// One long-lived graph copy lives in the side panel’s panel-body stack beside Files and Changes.
// Keeping it alive keeps Herdr’s JIT warm; fresh copies are cold and stall the window for seconds.
//
// A snapshot, not a feed: the history file and terminals() are read when the panel opens, when
// the active space changes while it shows, and on Refresh. Nothing watches the recorder and
// nothing ticks, so being open costs one render, not one per terminal title change.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { terminals, spaces, panes, theme, run, props, home, readTextFile, nextCommand, shared, exec, notify, appHome, layout as windowLayout } from "herdr";
import { parseHistory, merge, orderRuns, facts, title, outcome, isDone, duration, clock, layout, colX, rowY, CARD_W, CARD_H, qualify, RESUMABLE, agentOf } from "./model.js";

// Whether layout node `id` is on screen: it and every ancestor not hidden, and every stack on the
// way showing that branch. null when the layout has no such node.
function onScreen(node, id) {
  if (!node) return null;
  if (node.id === id) return !node.hidden;
  for (const child of node.children ?? []) {
    const shown = onScreen(child, id);
    if (shown !== null) return shown && !node.hidden && (node.active == null || node.active === child.id);
  }
  return null;
}

// Outside a layout block named "graph" (a pane, a check run) it always shows.
const isShown = () => onScreen(windowLayout(), "graph") ?? true;
const hide = () => run("layout.hide", { id: "panel" });

const GRAPH_W = 900;
const GRAPH_H = 560;
const BAR_H = 32;
const HEAD_H = 34;
const LINK = 1.5;
const MAX_CARDS = 28;

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

// The fields this view shows, read once per render (never the title, which ticks).
function liveTerminals() {
  return terminals().map((t) => {
    const p = t.program;
    return {
      address: t.address,
      parent: t.parent ?? null,
      created_ms: t.created_ms ?? null,
      finished_ms: t.finished_ms ?? null,
      exit_code: t.exit_code ?? null,
      reason: t.reason ?? null,
      state: t.state,
      status: t.status ?? null,
      name: t.name ?? null,
      template: t.template ?? null,
      argv: Array.isArray(t.argv) ? t.argv.slice(0, 12).map(String) : null,
      space_label: t.labels?.["herdr.space"] ?? null,
      program: p ? { name: p.name, icon: p.icon, tint: p.tint, agent: p.agent } : null,
    };
  });
}

// The id Herdr writes in a terminal's herdr.space label (local to its machine).
const localSpaceId = (space) => {
  const id = space?.id ?? "";
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
};

// The part of a record's `where` ("space / tab") that names the space.
const whereSpace = (where) => (where ?? "").split(" / ")[0];

// The live terminals of one space: those in its tabs' panes, their sub-agents (found by parent),
// and anything carrying the space's herdr.space label.
function activeTerms(space) {
  const all = liveTerminals();
  const tabs = new Set(space.tabs.map((t) => t.id));
  const local = localSpaceId(space);
  const keep = new Set(panes().filter((p) => p.terminal && tabs.has(p.tab)).map((p) => p.terminal));
  for (const t of all) if (t.space_label && t.space_label === local) keep.add(t.address);
  const kids = new Map();
  for (const t of all) {
    const key = qualify(t.parent, t.address);
    if (key == null) continue;
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(t.address);
  }
  const stack = [...keep];
  while (stack.length) {
    const addr = stack.pop();
    for (const child of kids.get(addr) ?? []) {
      if (keep.has(child)) continue;
      keep.add(child);
      stack.push(child);
    }
  }
  return all.filter((t) => keep.has(t.address));
}

// Theme colors by outcome kind: a card's status word (else muted) and a link by its child (else input).
const TONE = { working: "working", blocked: "blocked", error: "blocked", done: "done", idle: "dim", failed: "ansi1", stopped: "muted", ended: "dim", running: "muted" };
const LINK_TONE = { working: "working", blocked: "blocked", error: "blocked", failed: "ansi1", done: "done" };
const linkTone = (t, kind) => t[LINK_TONE[kind] ?? "input"];

// The program's icon from the app's table; a recorded-only node gets its initial.
function glyph(t, v, size) {
  const p = v.program;
  if (!p?.icon) return div().w(size).flex_none().text_color(t.muted).text_size(size * 0.85).font_semibold().child(v.letter);
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(t.foreground) : image(p.icon).w(size).h(size).flex_none();
}

// What a card or row shows, derived once per model.
function describe(n, worked) {
  if (n.ghost) return { ghost: true, title: n.address };
  const f = facts(n);
  const o = outcome(n, f);
  const name = title(n);
  // The program first, then what it runs (a model, a test filter) and why it may be quiet.
  const program = n.live?.program?.name ?? n.rec?.agent ?? null;
  const command = n.rec?.command || n.live?.argv?.join(" ") || n.live?.program?.name || n.rec?.agent;
  const resumable = Boolean(n.rec && n.live?.state !== "live" && RESUMABLE.has(agentOf(n.rec)));
  return {
    f,
    o,
    title: name,
    meta: [n.address, program, f.removed != null ? "removed" : null, f.notSeen ? "not seen" : null,
      command && command !== program ? command : null].filter(Boolean).join(" · "),
    program: n.live?.program ?? null,
    letter: (n.rec?.agent || name || "?").replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?",
    done: isDone(n, f, o, worked),
    resumable,
    peekable: Boolean(n.live) && !resumable,
    loud: o.kind === "blocked" || o.kind === "error",
  };
}

export default class AgentGraph extends View {
  init(_props, cx) {
    this.path = props()?.history || `${home()}/.local/share/herdr-agent-graph/history.json`;
    this.records = [];
    // Load ids: the latest started, and the one still running (null when none is).
    this.loads = 0;
    this.loading = null;
    this.token = shared("agent-graph.shown") ?? null;
    this.fh = cx.focus_handle();
    this.fh.focus();
    this.missing = false;
    this.error = null;
    this.size = null;
    this.model = { runs: [] };
    // The graph point at the viewport's top-left: Reset and Center move it, and cards outside
    // the viewport are not built at all.
    this.origin = { x: 0, y: 0 };
    // What the last cull of the viewport drew; a render with the same run, origin and size
    // reuses it instead of walking the run again.
    this.culled = null;
    this.centred = false;
    // The space whose graph this is: the one shown when the snapshot was taken.
    this.space = null;
    // Agents seen working here: an idle one among them has done its part.
    this.worked = new Set(store.get("worked", []));
    // When the snapshot the graph shows was taken. Nothing polls.
    this.refreshed = null;
    // One read when it starts; after that, opening the panel, a space change or Refresh.
    this.refresh(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "close") {
          hide();
          continue;
        }
        this.refresh(cx);
      }
    });
  }

  // Reads the history and snapshots the active space's terminals: the only place live data comes in.
  // A failed read or parse keeps the previous records and shows the error in the bar.
  async load(cx, id) {
    this.loading = id;
    const space = spaces().find((s) => s.active) ?? null;
    this.space = space ? { id: space.id, name: space.name } : null;
    const terms = space ? activeTerms(space) : [];
    this.error = null;
    let text = null;
    try {
      text = await readTextFile(this.path);
    } catch (e) {
      this.error = `Couldn't read history: ${e?.message ?? e}`;
    }
    if (!this.error) {
      this.missing = text == null;
      try {
        this.records = this.missing ? [] : parseHistory(text);
      } catch (e) {
        this.error = `Couldn't parse history: ${e?.message ?? e}`;
      }
    }
    await this.build(cx, terms, id);
    if (this.loading !== id) return;
    this.refreshed = Date.now();
    this.loading = null;
  }

  // A cold load can run for seconds, and Herdr may stop a script that runs too long: the load
  // then never finishes and the panel would stay empty. The watchdog retries it once, warmer.
  refresh(cx) {
    const id = ++this.loads;
    cx.spawn(async (cx) => {
      await this.load(cx, id);
      cx.notify();
    });
    cx.spawn(async (cx) => {
      await cx.sleep(10000);
      if (this.loading === id) this.refresh(cx);
    });
  }

  // Runs of this space and what every card says: built off the render path, once per read, in
  // steps that yield between them so the window can draw.
  async build(cx, terms, id) {
    const merged = merge(this.records, terms);
    await cx.sleep(0);
    let added = false;
    for (const r of merged) {
      for (const n of r.nodes) {
        if (n.live?.status === "working" && n.live.state === "live" && !this.worked.has(n.id)) {
          this.worked.add(n.id);
          added = true;
        }
      }
    }
    if (added) {
      const keep = [...this.worked].slice(-2000);
      this.worked = new Set(keep);
      store.set("worked", keep);
    }
    const name = this.space?.name ?? null;
    const runs = merged.filter((r) => r.nodes.some((n) => n.live || (name && whereSpace(n.rec?.where) === name)));
    const worked = (nid) => this.worked.has(nid);
    for (const r of runs) for (const n of r.nodes) n.v = describe(n, worked);
    await cx.sleep(0);
    orderRuns(runs);
    // A newer load took over while this one yielded: its result wins.
    if (this.loading !== id) return;
    this.model = { runs };
  }

  // Columns, headers, links and the active wave of one run, kept with the model. Nodes and
  // links are bucketed by column too, so a render visits only the columns the viewport shows.
  shape(r) {
    if (r.shape) return r.shape;
    const g = layout(r);
    const cols = Array.from({ length: g.cols }, () => ({ total: 0, done: 0, failed: 0, stopped: 0, working: 0 }));
    const byCol = Array.from({ length: g.cols }, () => []);
    let wave = null;
    for (const n of r.nodes) {
      const p = g.pos.get(n.id);
      byCol[p.col].push(n);
      const c = cols[p.col];
      if (n.v.ghost) continue;
      c.total++;
      if (n.v.done) c.done++;
      if (n.v.o.kind === "failed") c.failed++;
      if (n.v.o.kind === "stopped") c.stopped++;
      if (n.v.o.kind === "working") {
        c.working++;
        if (!wave || p.col > wave.col || (p.col === wave.col && p.row < wave.row)) wave = { ...p, id: n.id };
      }
    }
    const links = [];
    const linksByCol = Array.from({ length: g.cols }, () => []);
    for (const n of r.nodes) {
      if (!n.parent) continue;
      const a = g.pos.get(n.parent.id);
      const b = g.pos.get(n.id);
      const l = { id: n.id, pid: n.parent.id, x1: colX(a.col) + CARD_W, y1: rowY(a.row) + CARD_H / 2, x2: colX(b.col), y2: rowY(b.row) + CARD_H / 2, kind: n.v.ghost ? "ended" : n.v.o.kind };
      links.push(l);
      linksByCol[a.col].push(l);
    }
    r.shape = { g, cols, wave, links, byCol, linksByCol };
    return r.shape;
  }

  // The cards and links a viewport of one run draws, cached between renders: only the columns
  // crossing the viewport are visited, and live-data changes redraw from this data.
  cull(cur) {
    const { g, wave, byCol, linksByCol } = this.shape(cur);
    const ox = this.origin.x;
    const oy = this.origin.y;
    const { vw, vh } = this.viewport();
    const last = this.culled;
    if (last && last.cur === cur && last.ox === ox && last.oy === oy && last.vw === vw && last.vh === vh) return last;
    const midX = vw / 2;
    const midY = vh / 2;

    // Cards inside the fixed viewport and nearest its centre, at most MAX_CARDS: anything past
    // an edge is not built, so a huge run costs a screenful, never its whole canvas.
    const placed = [];
    for (let col = 0; col < g.cols; col++) {
      const x = colX(col) - ox;
      if (!(x + CARD_W > 0 && x < vw)) continue;
      for (const n of byCol[col]) {
        const y = HEAD_H + rowY(g.pos.get(n.id).row) - oy;
        // Build partly visible cards too; the canvas clips them at its edges.
        if (y + CARD_H > HEAD_H && y < vh) placed.push({ n, x, y, col });
      }
    }
    const rank = (d) => (d.x + CARD_W / 2 - midX) ** 2 + (d.y + CARD_H / 2 - midY) ** 2;
    placed.sort((a, b) => rank(a) - rank(b) || a.y - b.y || a.x - b.x);
    let drawn = placed.slice(0, MAX_CARDS);
    // The root and the wave stay built even when the budget is full: the graph must not lose
    // the run it starts from, and Center active wave must draw what it centres on.
    for (const id of [cur.root.id, wave?.id]) {
      if (!id || drawn.some((d) => d.n.id === id)) continue;
      const d = placed.find((p) => p.n.id === id);
      if (d) drawn = [d, ...drawn.slice(0, MAX_CARDS - 1)];
    }
    const hidden = cur.nodes.length - drawn.length;
    const shownIds = new Set(drawn.map((d) => d.n.id));
    const shownCols = new Set(drawn.map((d) => d.col));
    const placedIds = new Set(placed.map((d) => d.n.id));

    // Links whose parent column crosses the viewport: draw those between real ends, and stub
    // out a budgeted-out parent.
    const linkGeo = [];
    for (let c = 0; c < g.cols; c++) {
      if (!(colX(c + 1) - ox > 0 && colX(c) + CARD_W - ox < vw)) continue;
      for (const l of linksByCol[c]) {
        const x1 = l.x1 - ox;
        const y1 = l.y1 - oy;
        const x2 = l.x2 - ox;
        const y2 = l.y2 - oy;
        const parentReal = shownIds.has(l.pid) || !placedIds.has(l.pid);
        const childReal = shownIds.has(l.id) || !placedIds.has(l.id);
        if (parentReal && childReal && x2 > 0 && x1 < vw && Math.max(y1, y2) > 0 && Math.min(y1, y2) < vh - HEAD_H) {
          linkGeo.push({ elbow: true, x1, y1, x2, y2, kind: l.kind });
        } else if (shownIds.has(l.id) && !parentReal && x2 > 0) {
          linkGeo.push({ elbow: false, x2, y2, kind: l.kind });
        }
      }
    }
    this.culled = { cur, ox, oy, vw, vh, drawn, hidden, shownIds, placedIds, shownCols, linkGeo };
    return this.culled;
  }

  // Both buttons move what the fixed viewport shows; the card budget follows it.
  resetView(cx) {
    this.origin = { x: 0, y: 0 };
    this.centred = false;
    cx.notify();
  }

  viewport() {
    return { vw: Math.max(1, this.size?.width ?? GRAPH_W), vh: Math.max(1, (this.size?.height ?? GRAPH_H) - BAR_H) };
  }

  clampOrigin(x, y) {
    const cur = this.model.runs[0];
    if (!cur) return { x: 0, y: 0 };
    const { g } = this.shape(cur);
    const { vw, vh } = this.viewport();
    return {
      x: Math.round(Math.max(0, Math.min(Math.max(0, g.width - vw), x))),
      y: Math.round(Math.max(0, Math.min(Math.max(0, HEAD_H + g.height - vh), y))),
    };
  }

  pan(e, cx) {
    let dx = e.delta.x, dy = e.delta.y;
    if (e.modifiers?.shift && Math.abs(dx) < 0.5) { dx = dy; dy = 0; }
    const { x, y } = this.clampOrigin(this.origin.x - dx, this.origin.y - dy);
    if (x === this.origin.x && y === this.origin.y) return;
    this.origin = { x, y };
    this.centred = false;
    cx.notify();
  }

  // Puts the deepest working column (and its top working card) in the middle of the view.
  centerWave(cx) {
    const cur = this.model.runs[0];
    const wave = cur && this.shape(cur).wave;
    if (!wave) return;
    const { vw, vh } = this.viewport();
    this.origin = this.clampOrigin(
      colX(wave.col) + CARD_W / 2 - vw / 2,
      HEAD_H + rowY(wave.row) + CARD_H / 2 - vh / 2,
    );
    this.centred = true;
    cx.notify();
  }

  async resume(n) {
    try {
      const result = await exec("python3", ["-I", `${appHome()}/mods/agent-graph/resume.py`, "--history", this.path, n.id]);
      const data = JSON.parse(result.stdout);
      if (data.error) { notify({ title: "Cannot resume session", body: data.error }); return; }
      await run("tab.new", { name: n.v.title, folder: data.cwd, argv: data.argv });
      if (data.session == null) notify({ title: "Session not found", body: "The exact session wasn't found; a session picker opened." });
    } catch (error) { notify({ title: "Cannot resume session", body: String(error) }); }
  }

  render(cx) {
    if (!isShown()) return div().size_full();
    const token = shared("agent-graph.shown") ?? null;
    if (token !== this.token) {
      this.token = token;
      this.refresh(cx);
      cx.spawn(async (cx) => { await cx.sleep(0); this.fh.focus(); });
    }
    const active = spaces().find((s) => s.active);
    if (this.refreshed && active && active.id !== this.space?.id) this.refresh(cx);
    const t = theme();
    const now = Date.now();
    const cur = this.model.runs[0] ?? null;

    const root = v_flex()
      .track_focus(this.fh)
      .on_key_down((e, cx) => { if (e.key === "escape") { hide(); cx.stop_propagation(); } })
      .id("root")
      .on_size_change((size, cx) => {
        // Only a real change: notifying on every report would render in a loop.
        if (this.size && Math.round(this.size.width) === Math.round(size.width) && Math.round(this.size.height) === Math.round(size.height)) return;
        this.size = size;
        cx.notify();
      })
      .size_full()
      .min_w(0)
      .min_h(0)
      .bg(t.canvas)
      .text_size(12)
      .text_color(t.foreground);

    if (!cur) return root.child(this.bar(t)).child(this.empty(t));
    return root.child(this.graph(t, cur, now));
  }

  // A bar button, icon only: quiet at rest, hover lights it.
  button(t, id, icon, enabled, onClick) {
    return div()
      .id(id)
      .flex_none()
      .flex()
      .items_center()
      .px(6)
      .py(4)
      .rounded(5)
      .text_color(enabled ? t.muted : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(svg(icon).size(14).flex_none());
  }

  bar(t, hidden = 0) {
    const cur = this.model.runs[0] ?? null;
    const { g, wave } = cur ? this.shape(cur) : {};
    const bits = [];
    if (this.refreshed) bits.push(`snapshot ${clock(this.refreshed, Date.now())}`);
    if (cur) {
      bits.push(`${cur.sum.agents} agents · wave ${g.cols - 1}`);
      if (this.centred) bits.push("centred on the active wave");
      if (hidden > 0) bits.push(`${hidden} not drawn`);
    }
    if (this.error) bits.push(this.error);
    else if (this.missing) bits.push("no recorded history yet");
    return h_flex()
      .h(BAR_H)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.surface)
      .text_size(12)
      .child(h_flex().flex_1().min_w(0).overflow_hidden().gap(8).items_center()
        .child(div().min_w(0).flex_shrink_0().max_w(160).truncate().font_semibold().text_color(t.foreground).child(this.space?.name ?? "No active space"))
        .children(bits.map((text) => div().flex_none().text_color(t.dim).child(`· ${text}`))))
      .child(this.button(t, "refresh", "mods/agent-graph/icons/refresh.svg", true, (_e, cx) => this.refresh(cx)))
      .child(this.button(t, "center", "mods/agent-graph/icons/crosshair.svg", Boolean(wave), (_e, cx) => this.centerWave(cx)))
      .child(this.button(t, "reset", "mods/agent-graph/icons/undo.svg", Boolean(cur) && (this.origin.x > 0 || this.origin.y > 0), (_e, cx) => this.resetView(cx)))
      .child(this.button(t, "close", "mods/workspace-chrome/x.svg", true, () => hide()));
  }

  empty(t) {
    const text = !this.refreshed ? "" : "No agents in this space yet. Refresh after one starts another.";
    return div().flex_1().p(24).text_size(12).text_color(t.dim).child(text);
  }

  // ---- the graph: column headers, links and cards on one fixed canvas

  graph(t, cur, now) {
    const s = this.shape(cur);
    const { wave } = s;
    this.origin = this.clampOrigin(this.origin.x, this.origin.y);
    const ox = this.origin.x;
    const oy = this.origin.y;
    const { vw, vh } = this.viewport();
    const { drawn, hidden, shownCols, linkGeo } = this.cull(cur);

    const bar = this.bar(t, hidden);

    const heads = [];
    s.cols.forEach((c, col) => {
      const x = colX(col) - ox;
      if (x + CARD_W > 0 && x < vw && shownCols.has(col)) heads.push(this.header(t, c, col, x, wave?.col === col));
    });
    // Draw viewport-crossing links between real ends; use a stub for a budgeted-out parent.
    const links = [];
    for (const l of linkGeo) {
      if (l.elbow) links.push(...this.elbow(l.x1, l.y1, l.x2, l.y2, linkTone(t, l.kind)));
      else links.push(div().absolute().left(Math.max(0, l.x2 - 24)).top(l.y2 - LINK / 2).w(Math.min(24, l.x2)).h(LINK).bg(linkTone(t, l.kind)));
    }
    const body = div().absolute().left(0).top(HEAD_H).w(vw).h(Math.max(1, vh - HEAD_H)).overflow_hidden()
      .children(links)
      .children(drawn.map((d) => this.card(t, d.n, d.x, d.y - HEAD_H, now)));
    const canvas = div()
      .relative()
      .flex_none()
      .w(Math.max(1, vw))
      .h(Math.max(1, vh))
      .overflow_hidden()
      .children(heads)
      .child(body);

    const area = div().id("graph").flex_1().min_h(0).min_w(0).overflow_hidden().on_scroll_wheel((e, cx) => this.pan(e, cx)).child(canvas);
    return v_flex().flex_1().min_w(0).min_h(0).child(bar).child(area);
  }

  // A link from a parent's right edge to a child's left edge: across, down (rounded), across.
  elbow(x1, y1, x2, y2, color) {
    const line = () => div().absolute().border_color(color);
    // A straight run is a filled bar: a zero-height div paints no border.
    if (Math.abs(y2 - y1) < 1) return [div().absolute().left(x1).top(y1 - LINK / 2).w(x2 - x1).h(LINK).bg(color)];
    const mx = Math.round((x1 + x2) / 2);
    const mid = (y1 + y2) / 2;
    const r = Math.min(8, Math.abs(y2 - y1) / 2, (x2 - x1) / 4);
    const down = y2 > y1;
    const top = Math.min(y1, y2);
    const half = Math.abs(y2 - y1) / 2;
    return [
      line().left(x1).top(down ? y1 : mid).w(mx - x1).h(half)
        .when(down, (el) => el.border_t(LINK).border_r(LINK).rounded_tr(r))
        .when(!down, (el) => el.border_b(LINK).border_r(LINK).rounded_br(r)),
      line().left(mx - LINK).top(down ? mid : top).w(x2 - mx + LINK).h(half)
        .when(down, (el) => el.border_b(LINK).border_l(LINK).rounded_bl(r))
        .when(!down, (el) => el.border_t(LINK).border_l(LINK).rounded_tl(r)),
    ];
  }

  header(t, c, col, x, active) {
    const bits = [
      { text: col === 0 ? "Root" : `Wave ${col}`, color: active ? t.foreground : t.muted },
      { text: c.total ? `${c.done}/${c.total} done` : "removed before recording", color: t.dim },
      c.working && { text: `${c.working} working`, color: t.working },
      c.failed && { text: `${c.failed} failed`, color: t.ansi1 },
      c.stopped && { text: `${c.stopped} stopped`, color: t.muted },
    ].filter(Boolean);
    return h_flex()
      .absolute()
      .left(x)
      .top(0)
      .w(CARD_W)
      .h(HEAD_H)
      .pt(12)
      .gap(5)
      .items_start()
      .text_size(11)
      .when(active, (el) => el.border_b(2).border_color(t.accent))
      .children(bits.map((b, i) => div().flex_none().text_color(b.color).child(i ? `· ${b.text}` : b.text)));
  }

  card(t, n, x, y, now) {
    const v = n.v;
    const box = v_flex().id(`card-${n.id}`).absolute().left(x).top(y).w(CARD_W).h(CARD_H).rounded(7).border(1).px(10).py(7).gap(3);
    if (v.ghost) {
      return box.border_dashed().border_color(t.input)
        .child(div().truncate().text_size(12.5).text_color(t.muted).child(n.address))
        .child(div().text_size(11).text_color(t.dim).child("removed before recording"));
    }
    const f = v.f;
    const meta = [duration((f.finished ?? f.removed ?? now) - (f.created ?? now)), v.meta].filter(Boolean).join(" · ");
    const word = div().flex_none().text_color(t[TONE[v.o.kind] ?? "muted"]).when(v.loud, (el) => el.font_semibold()).child(v.o.word);
    const title = div().min_w(0).truncate().text_size(12.5).font_medium().child(v.title);
    return box
      .bg(t.background)
      .border_color(v.loud ? t.blocked : t.border)
      .when(f.removed != null, (el) => el.opacity(0.55))
      .when(v.peekable || v.resumable, (el) => el.cursor_pointer().hover((s) => s.border_color(t.accent)).on_click(() => v.peekable ? run("terminal.peek", { terminal: n.address }) : this.resume(n)))
      // Only a live card carries its program's icon; recorded cards say the program in the meta.
      .child(v.program?.icon ? h_flex().gap(7).items_center().child(glyph(t, v, 14)).child(title.flex_1()) : title.w_full())
      .child(word)
      .child(div().truncate().text_size(11).text_color(t.dim).child(meta));
  }

}
