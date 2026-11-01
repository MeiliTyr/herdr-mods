// The one owner of every graph update: the first load, live changes render notices, history file
// changes, showing the graph, a space switch and key commands all ask it for a pass, and it runs
// one pass at a time. Host access is injected, so live_test.mjs drives it with fakes.
//
// A pass takes one snapshot of its inputs (the active space and its terminals, then the history
// when it is stale), builds the model from that snapshot only, and commits records, error state,
// the model and the keys it consumed together at the end, unless a newer pass took over. What the
// view shows is compared as projections: an equal graph keeps the old model, so nothing redraws.
//
// host: {
//   isShown(): boolean
//   snapshot(): { space: {id, name} | null, terms: [], key: string }  (terms sorted, never titles)
//   readHistory(): Promise<string | null>
//   parse(text): records                 (throws on bad data)
//   build({ space, terms, records }, cx): Promise<model>
//   graphKey(model): string              (what the graph draws of that model)
//   barKey({ space, error, missing, ready }): string
//   publish(model | null, { graph, bar, force }, cx)
//   now?(): number
// }

const STALL_MS = 10000;
const PAN_MS = 200;
const RETRY_MS = 5000;

const sameHist = (a, b) => a.text === b.text && a.error === b.error && a.missing === b.missing;
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

export class Live {
  constructor(host) {
    this.host = host;
    this.now = host.now ?? (() => Date.now());
    // Requests: something may have changed; force publishes even an equal result.
    this.dirty = false;
    this.force = false;
    // History invalidations: a read consumes the `want` it started with, so an older read can
    // never clear a newer invalidation. Never read yet: stale.
    this.histWant = 1;
    this.histHave = 0;
    // The committed history: the last good records, and a revision that changes with them.
    this.hist = { records: [], text: null, error: null, missing: false, rev: 0 };
    // Ownership: one pass loop at a time; gen retires a stalled one so it can never commit.
    this.running = false;
    this.gen = 0;
    this.startedAt = 0;
    this.passForce = false;
    // What the committed state was built from, and the key of the snapshot being built now.
    this.processed = null;
    this.processedLive = null;
    this.inflightLive = null;
    // What the view shows from it.
    this.space = null;
    this.error = null;
    this.missing = false;
    this.ready = false;
    this.graphView = null;
    this.barView = null;
    this.panAt = 0;
    this.panWait = false;
    // Counters for tests.
    this.passes = 0;
    this.builds = 0;
  }

  // Asks for a pass. reread: the history may have changed; force: publish whatever comes out.
  request(cx, { reread = false, force = false } = {}) {
    if (reread) this.histWant++;
    if (force) this.force = true;
    this.dirty = true;
    if (this.running) {
      if (this.now() - this.startedAt < STALL_MS) return;
      this.retire();
    }
    this.start(cx);
  }

  // From render (shown, not a pan): a pass only when the live snapshot differs from the one the
  // graph was built from and from the one being built.
  observe(cx, snap) {
    if (snap.key !== this.processedLive && snap.key !== this.inflightLive) this.request(cx);
  }

  // The same check off the render path, for a change that came with a pan's render.
  check(cx) {
    if (this.host.isShown()) this.observe(cx, this.host.snapshot());
  }

  // A pan render skips live checks; one check runs PAN_MS after the last pan.
  panned(cx) {
    this.panAt = this.now();
    if (this.panWait) return;
    this.panWait = true;
    cx.spawn(async (cx) => {
      try {
        for (let left = PAN_MS; left > 0; left = this.panAt + PAN_MS - this.now()) await cx.sleep(left);
      } finally {
        this.panWait = false;
      }
      this.check(cx);
    });
  }

  // The history file changed (or may have): stale now, read by the next pass that runs shown.
  historyChanged(cx) {
    this.histWant++;
    this.dirty = true;
    if (this.host.isShown()) this.request(cx);
  }

  // Follows the history file's folder. Subscribing first and resyncing before the wait leaves no
  // unwatched gap; a folder that can't be watched is retried (and the history reread while shown)
  // every RETRY_MS.
  async watch(cx, watchFolder, path, retryMs = RETRY_MS) {
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const name = basename(path);
    let sync = true;
    for (;;) {
      let batch;
      let synced = false;
      try {
        const next = watchFolder(dir);
        if (sync) {
          sync = false;
          synced = true;
          this.historyChanged(cx);
        }
        batch = await next;
        if (!Array.isArray(batch)) throw new Error("no change list");
      } catch {
        sync = true;
        if (!synced) this.historyChanged(cx);
        await cx.sleep(retryMs);
        continue;
      }
      // Temp files (history.json.<pid>.tmp) don't count; the rename onto the file does.
      if (batch.some((p) => basename(String(p)) === name)) this.historyChanged(cx);
      // A cx use every round: a reloaded build's loop ends here.
      await cx.sleep(0);
    }
  }

  start(cx) {
    this.running = true;
    const gen = ++this.gen;
    this.startedAt = this.now();
    cx.spawn(async (cx) => this.loop(cx, gen));
    // A pass the host interrupted never finishes: retire it and start a fresh one.
    cx.spawn(async (cx) => {
      for (;;) {
        await cx.sleep(STALL_MS);
        if (!this.running || this.gen !== gen) return;
        if (this.now() - this.startedAt >= STALL_MS) {
          this.retire();
          this.start(cx);
          return;
        }
      }
    });
  }

  // Gives up the running pass: it keeps nothing it hasn't committed, and its work is asked again.
  retire() {
    this.gen++;
    this.running = false;
    this.inflightLive = null;
    this.dirty = true;
    if (this.passForce) this.force = true;
  }

  async loop(cx, gen) {
    try {
      while (this.dirty && this.gen === gen) {
        // Off the call that asked (a render must not publish), then: hidden, the work stays asked
        // for, and showing the graph asks again.
        await cx.sleep(0);
        if (this.gen !== gen) return;
        if (!this.host.isShown()) return;
        this.dirty = false;
        const force = this.force;
        this.force = false;
        this.passForce = force;
        this.startedAt = this.now();
        let done = true;
        try {
          done = await this.pass(cx, gen, force);
        } catch (e) {
          if (this.gen !== gen) return;
          this.failed(cx, `Couldn't update the graph: ${e?.message ?? e}`);
        }
        if (this.gen !== gen) return;
        this.inflightLive = null;
        if (!done) {
          this.dirty = true;
          if (force) this.force = true;
          return;
        }
      }
    } finally {
      if (this.gen === gen) {
        this.running = false;
        this.passForce = false;
      }
    }
  }

  // One pass. Returns false when the graph got hidden before it could publish (nothing kept).
  async pass(cx, gen, force) {
    this.passes++;
    const snap = this.host.snapshot();
    this.inflightLive = snap.key;
    let hist = this.hist;
    let want = null;
    if (this.histHave < this.histWant) {
      want = this.histWant;
      hist = await this.read(this.hist);
      if (this.gen !== gen) return true;
    }
    const source = `${hist.rev}\n${snap.key}`;
    if (!force && source === this.processed) {
      this.commitHist(hist, want);
      this.processedLive = snap.key;
      return true;
    }
    if (!this.host.isShown()) return false;

    let model = null;
    let buildError = null;
    try {
      this.builds++;
      model = await this.host.build({ space: snap.space, terms: snap.terms, records: hist.records }, cx);
    } catch (e) {
      buildError = `Couldn't build the graph: ${e?.message ?? e}`;
    }
    if (this.gen !== gen) return true;
    if (!this.host.isShown()) return false;

    this.commitHist(hist, want);
    this.processed = source;
    this.processedLive = snap.key;
    this.space = snap.space;
    this.error = buildError ?? hist.error;
    this.missing = hist.missing;
    this.ready = true;
    const graphView = model ? this.host.graphKey(model) : this.graphView;
    const barView = this.host.barKey(this);
    const graph = Boolean(model) && (force || graphView !== this.graphView);
    const bar = force || barView !== this.barView;
    this.graphView = graphView;
    this.barView = barView;
    if (graph || bar) this.host.publish(graph ? model : null, { graph, bar, force }, cx);
    return true;
  }

  commitHist(hist, want) {
    this.hist = hist;
    if (want != null) this.histHave = Math.max(this.histHave, want);
  }

  // Reads and parses the history. A failed read or parse keeps the previous records.
  async read(prev) {
    let next;
    try {
      const text = await this.host.readHistory();
      if (text == null) next = { records: [], text: null, error: null, missing: true };
      else if (text === prev.text && !prev.missing) next = { records: prev.records, text, error: null, missing: false };
      else {
        try {
          next = { records: this.host.parse(text), text, error: null, missing: false };
        } catch (e) {
          next = { records: prev.records, text: prev.text, error: `Couldn't parse history: ${e?.message ?? e}`, missing: false };
        }
      }
    } catch (e) {
      next = { records: prev.records, text: prev.text, error: `Couldn't read history: ${e?.message ?? e}`, missing: prev.missing };
    }
    if (sameHist(prev, next)) return prev;
    return { ...next, rev: prev.rev + 1 };
  }

  // An unexpected failure inside a pass: say so in the bar, keep what is shown.
  failed(cx, error) {
    this.error = error;
    const barView = this.host.barKey(this);
    if (barView === this.barView) return;
    this.barView = barView;
    try {
      this.host.publish(null, { graph: false, bar: true, force: false }, cx);
    } catch {}
  }
}
