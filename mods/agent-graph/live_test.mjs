// The update coordinator (live.js) against fake host data, a fake clock and controlled reads.
// Run: node live_test.mjs

import assert from "node:assert/strict";
import { Live } from "./live.js";

const HISTORY = "/data/agent-graph/history.json";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const recordsText = (...ids) => JSON.stringify({ records: ids.map((id) => ({ id, address: id.split("@")[0] })) });

// A host: one shown space with terminals, a history file, and a log of what got published.
function world({ deferReads = false } = {}) {
  const w = {
    clock: 0,
    timers: [],
    seq: 0,
    shown: true,
    space: { id: "s1", name: "alpha" },
    terms: [{ address: "t1", name: "lead", template: "claude", status: "working", title: "⠋ thinking" }],
    file: recordsText("t0@1"),
    deferReads,
    reads: 0,
    pendingReads: [],
    builds: 0,
    buildFails: false,
    published: [],
    errors: [],
    watchCalls: 0,
  };
  const cx = {
    spawn(body) {
      try {
        Promise.resolve(body(cx)).catch((e) => w.errors.push(e));
      } catch (e) {
        w.errors.push(e);
      }
    },
    sleep(ms = 0) {
      return new Promise((resolve) => w.timers.push({ at: w.clock + ms, seq: w.seq++, resolve }));
    },
  };
  const host = {
    now: () => w.clock,
    isShown: () => w.shown,
    // Like main.js: the fields the graph uses, sorted by address, never the title.
    snapshot: () => {
      const terms = w.terms
        .map(({ address, name, template, status }) => ({ address, name, template, status }))
        .sort((a, b) => (a.address < b.address ? -1 : 1));
      return { space: w.space, terms, key: JSON.stringify([w.space, terms]) };
    },
    readHistory: () => {
      w.reads++;
      if (!w.deferReads) return Promise.resolve(w.file);
      return new Promise((resolve, reject) => w.pendingReads.push({ resolve, reject }));
    },
    parse: (text) => {
      const data = JSON.parse(text);
      if (!Array.isArray(data.records)) throw new Error("no records list");
      return data.records;
    },
    build: async ({ space, terms, records }, cx) => {
      w.builds++;
      await cx.sleep(0);
      if (w.buildFails) throw new Error("boom");
      return { space, terms, records };
    },
    // What the fake view draws: record ids, and each terminal's shown name and status (a name
    // hides the template, as title() does).
    graphKey: (m) => JSON.stringify([m.records.map((r) => r.id), m.terms.map((t) => [t.address, t.name || t.template, t.status])]),
    barKey: ({ space, error, missing, ready }) => JSON.stringify([space?.name ?? null, error, missing, ready]),
    publish: (model, change) => w.published.push({ model, ...change }),
  };
  const live = new Live(host);

  // Lets time pass: every fake timer due within `ms`, in order, with promises settling between.
  w.run = async (ms = 0) => {
    const end = w.clock + ms;
    for (;;) {
      await tick();
      w.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const t = w.timers[0];
      if (!t || t.at > end) break;
      w.timers.shift();
      w.clock = Math.max(w.clock, t.at);
      t.resolve();
    }
    w.clock = end;
    await tick();
  };
  // A shown render that is not a pan's.
  w.render = () => live.observe(cx, host.snapshot());
  // The reveal path of render.
  w.reveal = () => {
    w.shown = true;
    live.request(cx);
  };
  // A watcher whose batches the test delivers.
  w.watchFolder = (dir) => {
    w.watchCalls++;
    w.watchedDir = dir;
    return new Promise((resolve) => { w.deliver = resolve; });
  };
  w.watch = (watchFolder = w.watchFolder) => cx.spawn((cx) => live.watch(cx, watchFolder, HISTORY));
  w.resolveRead = async (text) => {
    w.pendingReads.shift().resolve(text);
    await w.run();
  };
  w.cx = cx;
  w.live = live;
  return w;
}

const lastModel = (w) => w.published.filter((p) => p.graph).at(-1)?.model;

const tests = {
  async "first load publishes the graph and the ready bar"() {
    const w = world();
    w.watch();
    await w.run();
    assert.equal(w.watchedDir, "/data/agent-graph");
    assert.equal(w.reads, 1);
    assert.equal(w.live.ready, true);
    assert.equal(w.published.length, 1);
    assert.deepEqual([w.published[0].graph, w.published[0].bar], [true, true]);
    assert.deepEqual(lastModel(w).records.map((r) => r.id), ["t0@1"]);
  },

  async "first empty load flips ready"() {
    const w = world();
    w.terms = [];
    w.file = recordsText();
    w.watch();
    await w.run();
    assert.equal(w.live.ready, true);
    assert.equal(w.live.missing, false);
    assert.equal(w.published.length, 1);
    assert.equal(w.published[0].bar, true);
  },

  async "a missing history file still flips ready and says it is missing"() {
    const w = world();
    w.file = null;
    w.watch();
    await w.run();
    assert.equal(w.live.ready, true);
    assert.equal(w.live.missing, true);
    assert.equal(w.published.at(-1).bar, true);
  },

  async "title-only churn causes no pass after the first"() {
    const w = world();
    w.watch();
    // Ticks while the first pass is still waiting to run, then after it.
    for (let i = 0; i < 20; i++) {
      w.terms[0].title = `${i} thinking`;
      w.render();
    }
    await w.run();
    for (let i = 0; i < 50; i++) {
      w.terms[0].title = `${i} still thinking`;
      w.render();
      await w.run();
    }
    assert.equal(w.live.passes, 1);
    assert.equal(w.reads, 1);
    assert.equal(w.published.length, 1);
  },

  async "title-only churn while the first read is out causes no second pass"() {
    const w = world({ deferReads: true });
    w.watch();
    await w.run();
    for (let i = 0; i < 20; i++) {
      w.terms[0].title = `${i} thinking`;
      w.render();
    }
    await w.resolveRead(recordsText("t0@1"));
    await w.run();
    assert.equal(w.live.passes, 1);
    assert.equal(w.published.length, 1);
  },

  async "a status change publishes once"() {
    const w = world();
    w.watch();
    await w.run();
    w.terms[0].status = "done";
    for (let i = 0; i < 10; i++) {
      w.terms[0].title = `${i}`;
      w.render();
    }
    await w.run();
    for (let i = 0; i < 10; i++) w.render();
    await w.run();
    assert.equal(w.live.passes, 2);
    assert.equal(w.reads, 1, "a terminal change doesn't reread the history");
    assert.equal(w.published.length, 2);
    assert.equal(w.published[1].graph, true);
    assert.equal(w.published[1].bar, false);
    assert.equal(lastModel(w).terms[0].status, "done");
  },

  async "an equal rebuild advances the source key and publishes nothing"() {
    const w = world();
    w.watch();
    await w.run();
    const first = lastModel(w);
    // A named terminal's template changes: the input differs, the drawn graph doesn't.
    w.terms[0].template = "codex";
    w.render();
    await w.run();
    assert.equal(w.live.builds, 2);
    for (let i = 0; i < 10; i++) {
      w.render();
      await w.run();
    }
    assert.equal(w.live.passes, 2);
    assert.equal(w.live.builds, 2);
    assert.equal(w.published.length, 1);
    assert.equal(lastModel(w), first);
  },

  async "a space rename and losing the active space are inputs"() {
    const w = world();
    w.watch();
    await w.run();
    w.space = { id: "s1", name: "beta" };
    w.render();
    await w.run();
    assert.equal(w.live.space.name, "beta");
    assert.equal(w.published.at(-1).bar, true);
    w.space = null;
    w.terms = [];
    w.render();
    await w.run();
    assert.equal(w.live.space, null);
    assert.deepEqual(lastModel(w).terms, []);
  },

  async "a request during a pass reruns it once"() {
    const w = world({ deferReads: true });
    w.watch();
    await w.run();
    assert.equal(w.pendingReads.length, 1);
    // While the first read is out: a history event, a status change and renders.
    w.live.historyChanged(w.cx);
    w.terms[0].status = "blocked";
    w.render();
    w.render();
    w.file = recordsText("t0@1", "t1@2");
    await w.resolveRead(recordsText("t0@1"));
    assert.equal(w.pendingReads.length, 1, "the second pass rereads");
    await w.resolveRead(recordsText("t0@1", "t1@2"));
    await w.run();
    assert.equal(w.live.passes, 2);
    assert.equal(w.reads, 2);
    assert.deepEqual(lastModel(w).records.map((r) => r.id), ["t0@1", "t1@2"]);
    assert.equal(lastModel(w).terms[0].status, "blocked");
  },

  async "overlapping reads A and B commit only the newest"() {
    const w = world({ deferReads: true });
    w.watch();
    await w.run();
    assert.equal(w.pendingReads.length, 1);
    const readA = w.pendingReads.shift();
    // Read A never comes back in time: the stall guard retires its pass and starts pass B.
    await w.run(10000);
    assert.equal(w.pendingReads.length, 1);
    await w.resolveRead(recordsText("b@2"));
    assert.deepEqual(w.live.hist.records.map((r) => r.id), ["b@2"]);
    const published = w.published.length;
    readA.resolve(recordsText("a@1"));
    await w.run();
    assert.deepEqual(w.live.hist.records.map((r) => r.id), ["b@2"]);
    assert.deepEqual(lastModel(w).records.map((r) => r.id), ["b@2"]);
    assert.equal(w.published.length, published);
    assert.equal(w.live.running, false);
  },

  async "a hidden pass publishes nothing, then publishes on reveal"() {
    const w = world({ deferReads: true });
    w.watch();
    await w.run();
    await w.resolveRead(recordsText("t0@1"));
    assert.equal(w.published.length, 1);
    // A history event while shown; the graph hides before the read comes back.
    w.live.historyChanged(w.cx);
    await w.run();
    w.shown = false;
    const builds = w.live.builds;
    await w.resolveRead(recordsText("t0@1", "t2@3"));
    // Hidden: a status change and another history event do no work.
    w.terms[0].status = "idle";
    w.live.historyChanged(w.cx);
    await w.run(60000);
    assert.equal(w.published.length, 1);
    assert.equal(w.live.builds, builds);
    assert.equal(w.pendingReads.length, 0);
    w.reveal();
    await w.run();
    await w.resolveRead(recordsText("t0@1", "t2@3"));
    assert.equal(w.published.length, 2);
    assert.deepEqual(lastModel(w).records.map((r) => r.id), ["t0@1", "t2@3"]);
    assert.equal(lastModel(w).terms[0].status, "idle");
  },

  async "showing again rereads the history only if it is stale"() {
    const w = world();
    w.watch();
    await w.run();
    w.shown = false;
    await w.run(1000);
    w.reveal();
    await w.run();
    assert.equal(w.reads, 1);
    assert.equal(w.published.length, 1);
  },

  async "watch batches: temp files are ignored, the rename onto the file rereads"() {
    const w = world();
    w.watch();
    await w.run();
    w.deliver([`${HISTORY}.4242.tmp`]);
    await w.run();
    assert.equal(w.reads, 1);
    w.file = recordsText("t0@1", "t5@9");
    w.deliver([`${HISTORY}.4242.tmp`, HISTORY]);
    await w.run();
    assert.equal(w.reads, 2);
    assert.deepEqual(lastModel(w).records.map((r) => r.id), ["t0@1", "t5@9"]);
    assert.equal(w.watchCalls, 3);
  },

  async "watch failure: reread every 5 s while shown, only stale while hidden, resync on recovery"() {
    const w = world();
    let failing = true;
    const watchFolder = (dir) => {
      w.watchCalls++;
      return failing ? Promise.reject(new Error("no such folder")) : w.watchFolder(dir);
    };
    w.watch(watchFolder);
    await w.run();
    assert.equal(w.reads, 1);
    w.file = recordsText("t0@1", "t6@10");
    await w.run(5000);
    assert.equal(w.reads, 2);
    assert.deepEqual(lastModel(w).records.map((r) => r.id), ["t0@1", "t6@10"]);
    await w.run(5000);
    assert.equal(w.reads, 3);
    assert.ok(w.watchCalls <= 4, `retries are paced (${w.watchCalls} watch calls)`);
    w.shown = false;
    await w.run(30000);
    assert.equal(w.reads, 3);
    // The folder becomes watchable while hidden; a write landed before it did.
    failing = false;
    w.file = recordsText("t0@1", "t6@10", "t7@11");
    await w.run(5000);
    assert.equal(w.reads, 3);
    w.reveal();
    await w.run();
    assert.equal(w.reads, 4);
    assert.deepEqual(lastModel(w).records.map((r) => r.id), ["t0@1", "t6@10", "t7@11"]);
  },

  async "a failed parse keeps the records and shows the error"() {
    const w = world();
    w.watch();
    await w.run();
    w.file = "{ not json";
    w.deliver([HISTORY]);
    await w.run();
    assert.match(w.live.error, /^Couldn't parse history/);
    assert.deepEqual(w.live.hist.records.map((r) => r.id), ["t0@1"]);
    assert.equal(w.published.at(-1).bar, true);
    assert.equal(w.published.at(-1).graph, false);
    w.file = recordsText("t0@1");
    w.deliver([HISTORY]);
    await w.run();
    assert.equal(w.live.error, null);
  },

  async "a build failure shows the error, keeps the model and doesn't loop"() {
    const w = world();
    w.watch();
    await w.run();
    const first = lastModel(w);
    w.buildFails = true;
    w.terms[0].status = "done";
    w.render();
    await w.run();
    assert.match(w.live.error, /^Couldn't build the graph/);
    assert.equal(lastModel(w), first);
    for (let i = 0; i < 5; i++) {
      w.render();
      await w.run();
    }
    assert.equal(w.live.passes, 2);
    assert.equal(w.live.running, false);
  },

  async "a forced request rereads and publishes even an equal result"() {
    const w = world();
    w.watch();
    await w.run();
    w.live.request(w.cx, { reread: true, force: true });
    await w.run();
    assert.equal(w.reads, 2);
    assert.equal(w.published.length, 2);
    assert.equal(w.published[1].force, true);
  },

  async "a change during panning is checked once, after the pan"() {
    const w = world();
    w.watch();
    await w.run();
    for (let i = 0; i < 5; i++) {
      w.live.panned(w.cx);
      if (i === 2) w.terms[0].status = "done";
      await w.run(50);
    }
    assert.equal(w.live.passes, 1);
    await w.run(200);
    assert.equal(w.live.passes, 2);
    assert.equal(lastModel(w).terms[0].status, "done");
  },
};

let failed = 0;
for (const [name, test] of Object.entries(tests)) {
  try {
    await test();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n${e?.stack ?? e}`);
  }
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log(`all ${Object.keys(tests).length} passed`);
