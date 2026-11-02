// COMPOSE: pose and effects on one timeline. Easy layer: RECIPES - one press puts the right effects on the move at the right
// frames (a hit spark on the striking limb at the hit mark, a swing trail, a kick swoosh, a heavy hit, landing dust, footsteps),
// worked out from the move itself (moveinfo.js). Pro layer: snap a cue to the hit, the clear, its limb's fastest frame or the
// nearest foot contact; nudge it; shift every cue together; line the impacts up with the hit; swap a cue to the other side.
// Every change is one step of COMPOSE's own undo (cues are not in the clip's undo history); nothing is written to the game until
// the clip is saved.
import { h, button, heading, hint, row, label } from "./ui.js";
import { kindOf } from "./library.js";
import { moveInfo, strikePoint, touchdowns, mirrorSocket } from "./moveinfo.js";

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const FOOT_SOCKET = { footL: "foot_L", footR: "foot_R" };

// each recipe: what it needs from the library, and a plan {cues, why} or {error} for the open move
export const RECIPES = [
  { id: "hit_spark", title: "Hit spark", tip: "A spark on the limb that strikes, on the hit mark.", need: ["impact_spark"], strike: true,
    plan: (a, mi, sp) => (sp ? { cues: [{ id: "impact_spark", socket: sp.socket, frame: sp.frame, mode: "burst", scale: 1 }], why: `impact_spark on ${sp.socket} at f${sp.frame} (${sp.why})` }
      : { error: "no hit mark and no fast limb stroke: set a hit mark (Properties > hit)" }) },
  { id: "swing_trail", title: "Swing trail", tip: "A streak that follows the striking limb from the wind-up to just after the hit.", need: ["motion_trail"], strike: true,
    plan: (a, mi, sp) => {
      if (!sp || sp.frame < 2) return { error: "needs a hit mark (or a fast stroke) a few frames into the move" };
      const start = Math.max(0, sp.frame - clamp(Math.round(sp.frame * 0.7), 3, 16));
      return { cues: [{ id: "motion_trail", socket: sp.socket, frame: start, mode: "follow", dur: Math.round(((sp.frame + 2 - start) / mi.fps) * 100) / 100, scale: 1 }],
        why: `motion_trail riding ${sp.socket} from f${start} to f${sp.frame + 2}` };
    } },
  { id: "kick_swoosh", title: "Kick swoosh", tip: "The arc of a kick, just before the foot lands.", need: ["kick_swoosh"], strike: true,
    plan: (a, mi, sp) => (sp && /^foot/.test(sp.socket) ? { cues: [{ id: "kick_swoosh", socket: sp.socket, frame: Math.max(0, sp.frame - 2), mode: "burst", scale: 1 }], why: `kick_swoosh on ${sp.socket} at f${Math.max(0, sp.frame - 2)}` }
      : { error: sp ? `the striker is ${sp.socket}, not a foot` : "no hit mark and no fast limb stroke" }) },
  { id: "heavy_hit", title: "Heavy hit", tip: "A big spark, a shockwave ring and a scuff on the floor, all on the hit.", need: ["impact_spark", "shockwave"], strike: true,
    plan: (a, mi, sp) => {
      if (!sp) return { error: "no hit mark and no fast limb stroke: set a hit mark (Properties > hit)" };
      const cues = [{ id: "impact_spark", socket: sp.socket, frame: sp.frame, mode: "burst", scale: 1.4 }, { id: "shockwave", socket: sp.socket, frame: sp.frame, mode: "burst", scale: 0.8 }];
      if (a.fx.library.has("hit_scuff")) cues.push({ id: "hit_scuff", socket: "ground_mid", frame: Math.min(mi.frames, sp.frame + 1), mode: "burst", scale: 1 });
      return { cues, why: `spark + shockwave on ${sp.socket}${cues.length > 2 ? " + a floor scuff" : ""} at f${sp.frame}` };
    } },
  { id: "landing_dust", title: "Landing dust", tip: "A puff of dust where the feet come down.", need: ["cloud_puff"],
    plan: (a, mi) => {
      if (a.doc.loop) return { error: "this is a loop (walk, run, idle): see Footsteps" };
      let at = touchdowns(mi);
      if (!at.length && /(^|_)land/.test(a.doc.name) && mi.landing > 0) at = [mi.landing];
      if (!at.length) return { error: "no landing found: the feet never leave the floor and come back" };
      at = at.slice(0, 3);
      return { cues: at.map((f) => ({ id: "cloud_puff", socket: "ground_mid", frame: f, mode: "burst", scale: 1 })), why: `cloud_puff at the feet at ${at.map((f) => "f" + f).join(", ")}` };
    } },
  { id: "footsteps", title: "Footsteps", tip: "A small puff under each foot as it lands (walks, runs, dashes).", need: [],
    plan: (a, mi) => {
      const kind = kindOf(a.doc.name);
      if (!["Movement", "World"].includes(kind) || !/(^|_)(walk|run|dash|sprint|jog|trot|step)/.test(a.doc.name)) return { error: "for walks, runs and dashes" };
      const id = ["dust_kick", "cloud_puff"].find((x) => a.fx.library.has(x));
      if (!id) return { error: "neither dust_kick nor cloud_puff is in the library" };
      const c = mi.contacts.filter((x) => x.f >= 1 && a.sockSpecs[FOOT_SOCKET[x.foot]]).slice(0, 8);
      if (c.length < 2) return { error: "fewer than two foot contacts in this clip" };
      return { cues: c.map((x) => ({ id, socket: FOOT_SOCKET[x.foot], frame: x.f, mode: "burst", scale: 0.4 })), why: `${id} (small) under the foot at ${c.map((x) => "f" + x.f).join(", ")}` };
    } },
];

export class ComposeEngine {
  constructor(app) {
    this.app = app;
    this.stack = [];    // {label, before: cues} - the cues as they were before each change
    this.log = [];
    this.clip = "";
    app.on((w) => { if (w === "clip" || w === "fighter") this.stack = []; });   // the cues of another clip are not these cues
  }

  fresh() {
    const d = this.app.doc, key = this.app.fighter + "|" + d.name;
    if (key !== this.clip) { this.clip = key; this.stack = []; }
  }

  plan(id) {
    const a = this.app;
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return { ok: false, why: "no recipe " + id, cues: [] };
    if (!a.fx) return { ok: false, why: "the effects are not loaded yet", cues: [] };
    const mi = moveInfo(a);
    if (!mi) return { ok: false, why: "no stage yet", cues: [] };
    const missing = r.need.find((b) => !a.fx.library.has(b));
    if (missing) return { ok: false, why: `the block ${missing} is not in the effect library`, cues: [] };
    if (r.strike && mi.hit < 0 && kindOf(a.doc.name) !== "Attacks") return { ok: false, why: `this is ${kindOf(a.doc.name) === "Other" ? "not an attack" : "a " + kindOf(a.doc.name).toLowerCase() + " clip"} with no hit mark: strike recipes need an attack, or a hit mark (Properties > hit)`, cues: [] };
    const p = r.plan(a, mi, strikePoint(a));
    if (p.error) return { ok: false, why: p.error, cues: [] };
    const cues = p.cues.filter((c) => c.socket === "origin" || a.sockSpecs[c.socket]);
    if (!cues.length) return { ok: false, why: "this fighter has none of the sockets the recipe needs", cues: [] };
    const have = a.fx.list();
    const fresh = cues.filter((c) => !have.some((x) => x.id === c.id && x.socket === c.socket && Math.abs(x.frame - c.frame) <= 1));
    return { ok: true, why: p.why, cues, fresh: fresh.length, title: r.title };
  }

  recipes() { return RECIPES.map((r) => ({ id: r.id, title: r.title, tip: r.tip, ...this.plan(r.id) })); }

  _push(label) {
    this.fresh();
    this.stack.push({ label, before: this.app.fx.pl.asCues() });
    if (this.stack.length > 40) this.stack.shift();
  }

  _say(ok, text) { this.log.push({ t: Date.now(), ok, text }); this.app.say(text, ok ? "ok" : "warn"); this.app.emit("compose"); return { ok, text }; }

  // put a recipe's cues on the clip (the ones already there at the same frame and socket are left alone)
  async apply(id) {
    const a = this.app;
    const p = this.plan(id);
    if (!p.ok) return this._say(false, `${p.title || id}: ${p.why}.`);
    const todo = p.cues.filter((c) => !a.fx.list().some((x) => x.id === c.id && x.socket === c.socket && Math.abs(x.frame - c.frame) <= 1));
    if (!todo.length) return this._say(true, `${p.title}: already on the clip.`);
    this._push(p.title);
    let n = 0, last = -1;
    for (const c of todo) { const i = await a.fx.add(c); if (i >= 0) { n++; last = i; } }
    if (last >= 0) a.selectFx(last);
    return this._say(n > 0, n ? `${p.title}: added ${n} cue${n > 1 ? "s" : ""} - ${p.why}.` : `${p.title}: no cue could be added.`);
  }

  async undo() {
    this.fresh();
    const s = this.stack.pop();
    if (!s) return this._say(false, "Nothing to undo in COMPOSE.");
    this.app.fx.pl.fromCues(s.before);
    this.app.fx._edited();
    this.app.selectFx(-1);
    return this._say(true, `Undid: ${s.label}.`);
  }

  _cue(i) {
    const c = this.app.fx.list()[i];
    return c || null;
  }

  // where a cue can snap: the hit / clear marks, its limb's fastest frame, the nearest foot contact, the ends
  targets(i) {
    const mi = moveInfo(this.app), c = this._cue(i);
    if (!mi || !c) return {};
    const t = {};
    if (mi.hit >= 0) t.hit = mi.hit;
    if (mi.clear >= 0) t.clear = mi.clear;
    const s = mi.socks.find((x) => x.socket === c.socket);
    if (s && s.peak.v > 0) t.peak = s.peak.f;
    const fs = [...mi.contacts.map((x) => x.f), ...touchdowns(mi)];
    if (fs.length) t.contact = fs.reduce((best, f) => (Math.abs(f - c.frame) < Math.abs(best - c.frame) ? f : best), fs[0]);
    t.start = 0;
    t.end = mi.frames;
    t.playhead = Math.round(this.app.frame);
    return t;
  }

  async snap(i, to) {
    const c = this._cue(i);
    if (!c) return this._say(false, "No such cue.");
    const t = this.targets(i);
    if (t[to] === undefined) return this._say(false, `Nothing to snap to: ${to} (${{ hit: "set a hit mark", clear: "set a clear mark", peak: "that socket is not a striker", contact: "no foot contact found" }[to] || "not available"}).`);
    this._push(`snap ${c.id} to ${to}`);
    await this.app.fx.edit(i, { frame: t[to] });
    this.app.setFrame(t[to]);
    return this._say(true, `${c.id} moved from f${c.frame} to f${t[to]} (${to}).`);
  }

  async nudge(i, frames) {
    const c = this._cue(i), mi = moveInfo(this.app);
    if (!c) return this._say(false, "No such cue.");
    const f = clamp(Math.round(c.frame + Number(frames)), 0, mi ? mi.frames : 1e6);
    if (f === Math.round(c.frame)) return this._say(false, `${c.id} is already at the end of the clip.`);
    this._push(`nudge ${c.id}`);
    await this.app.fx.edit(i, { frame: f });
    return this._say(true, `${c.id} moved to f${f}.`);
  }

  // every cue by the same number of frames (none goes before 0 or after the end)
  async shiftAll(frames) {
    const a = this.app, list = a.fx.list(), mi = moveInfo(a);
    if (!list.length) return this._say(false, "No cues to shift.");
    const n = Math.round(Number(frames));
    const lo = Math.min(...list.map((c) => c.frame)), hi = Math.max(...list.map((c) => c.frame));
    const dn = clamp(n, -Math.round(lo), Math.round((mi ? mi.frames : hi) - hi));
    if (!dn) return this._say(false, "The cues are already at the edge of the clip.");
    this._push(`shift all ${dn > 0 ? "+" : ""}${dn}`);
    for (const c of list) await a.fx.edit(c.index, { frame: Math.round(c.frame) + dn });
    return this._say(true, `${list.length} cue${list.length > 1 ? "s" : ""} moved ${dn > 0 ? "+" : ""}${dn} f.`);
  }

  // the impacts (bursts of impact blocks) move to the hit mark; everything else keeps its distance from them
  async alignToHit() {
    const a = this.app, mi = moveInfo(a);
    if (!mi || mi.hit < 0) return this._say(false, "Set a hit mark first (Properties > hit).");
    const list = a.fx.list();
    const imp = list.filter((c) => {
      const e = a.fx.library.get(c.id);
      return c.mode === "burst" && e && (["impacts", "impact", "melee"].includes(e.category) || (e.manifest.tags || []).includes("impact")) && !(e.manifest.tags || []).some((t) => /slash|swoosh|trail/.test(t));
    });
    if (!imp.length) return this._say(false, "No impact effect on the clip to line up.");
    const first = imp.reduce((m, c) => (c.frame < m.frame ? c : m), imp[0]);
    return this.shiftAll(mi.hit - Math.round(first.frame));
  }

  async swapSide(i) {
    const c = this._cue(i);
    if (!c) return this._say(false, "No such cue.");
    const to = mirrorSocket(c.socket);
    if (to === c.socket || !this.app.sockSpecs[to]) return this._say(false, `${c.socket} has no other side.`);
    this._push(`swap ${c.id} to ${to}`);
    await this.app.fx.edit(i, { socket: to });
    return this._say(true, `${c.id} now fires from ${to}.`);
  }

  async duplicate(i) {
    const a = this.app, c = this._cue(i);
    if (!c) return this._say(false, "No such cue.");
    this._push(`duplicate ${c.id}`);
    const j = await a.fx.add({ id: c.id, socket: c.socket, mode: c.mode, dur: c.dur, offset: c.offset, rot: c.rot, scale: c.scale, frame: Math.min(moveInfo(a)?.frames ?? 1e6, Math.round(c.frame) + 3) });
    if (j >= 0) a.selectFx(j);
    return this._say(j >= 0, j >= 0 ? `${c.id} copied 3 f later.` : "Could not copy the cue.");
  }

  async remove(i) {
    const c = this._cue(i);
    if (!c) return this._say(false, "No such cue.");
    this._push(`remove ${c.id}`);
    this.app.fx.remove(i);
    this.app.selectFx(-1);
    return this._say(true, `${c.id} at f${c.frame} removed.`);
  }

  // the beat sheet: the hit / clear marks and every cue, in time order, each against the hit
  sheet() {
    const a = this.app, mi = moveInfo(a);
    const rows = [];
    if (mi) {
      if (mi.hit >= 0) rows.push({ kind: "mark", name: "hit", frame: mi.hit });
      if (mi.clear >= 0) rows.push({ kind: "mark", name: "clear", frame: mi.clear });
    }
    for (const c of a.fx.list()) rows.push({ kind: "cue", ...c, delta: mi && mi.hit >= 0 ? Math.round(c.frame) - mi.hit : null });
    return rows.sort((x, y) => x.frame - y.frame || (x.kind === "mark" ? -1 : 1));
  }
}

// ==================================================================== the panel
export function Compose(app) {
  const st = app.compose;
  const el = h("div", { class: "pbody" });
  const recBox = h("div", { class: "recipes" });
  const sheetBox = h("div", { class: "list beats", tabIndex: 0 });
  const info = h("div", { class: "hint" });
  const undoBtn = button("UNDO", () => st.undo(), "Take back the last change COMPOSE made to the cues");
  const logBox = h("div", { class: "setuplog" });
  const sel = () => app.fxSel;
  const need = (fn) => () => { if (sel() < 0 || !st._cue(sel())) { app.say("Pick a cue in the beat sheet first.", "warn"); return; } fn(sel()); };
  const snap = (text, to, tip) => button(text, need((i) => st.snap(i, to)), tip);
  const nudge = (n) => button((n > 0 ? "+" : "") + n, need((i) => st.nudge(i, n)), `Move the cue ${Math.abs(n)} frame${Math.abs(n) > 1 ? "s" : ""} ${n > 0 ? "later" : "earlier"}`);
  const shift = (n) => button((n > 0 ? "+" : "") + n, () => st.shiftAll(n), `Move every cue ${Math.abs(n)} frame${Math.abs(n) > 1 ? "s" : ""} ${n > 0 ? "later" : "earlier"}`);

  el.append(heading("Compose"), hint("Press a recipe and the right effects land on the right frames of this move; tune them with the snaps below. Undoable here; nothing reaches the game until you save the clip."),
    info, heading("Recipes"), recBox,
    row(undoBtn, button("SAVE CLIP + CUES", () => app.save(), "Ctrl+S"), button("OPEN EFFECTS", () => app.ui.showPanel("Effects"), "The Effects panel: pick any block, set socket, size, offset, turn")),
    heading("Beat sheet"), hint("The marks and every cue in time order; the number is how many frames from the hit. Click one to select it."), sheetBox,
    heading("Selected cue"),
    row(label("snap to"), snap("HIT", "hit", "Move it to the hit mark"), snap("CLEAR", "clear", "Move it to the clear mark"), snap("FASTEST", "peak", "Move it to the frame its limb moves fastest"),
      snap("FOOT CONTACT", "contact", "Move it to the nearest frame a foot meets the floor"), snap("PLAYHEAD", "playhead", "Move it to the frame on screen")),
    row(label("nudge"), nudge(-5), nudge(-1), nudge(1), nudge(5), button("SWAP SIDE", need((i) => st.swapSide(i)), "Fire it from the other hand / foot"),
      button("COPY +3 F", need((i) => st.duplicate(i)), "A copy of this cue 3 frames later"), button("REMOVE", need((i) => st.remove(i)), "Take it off the clip")),
    heading("All cues"),
    row(label("shift"), shift(-5), shift(-1), shift(1), shift(5), button("IMPACTS ON THE HIT", () => st.alignToHit(), "Move every cue together so the first impact lands exactly on the hit mark")),
    heading("What COMPOSE did"), logBox);

  async function pick(i) { app.selectFx(i); const c = st._cue(i); if (c) app.setFrame(Math.round(c.frame)); }

  function render() {
    if (!app.fx) return;
    st.fresh();
    const mi = moveInfo(app);
    const cues = app.fx.count();
    info.textContent = `${app.fighter} / ${app.doc.name}: ${kindOf(app.doc.name)}, ${app.doc.frames} f${mi && mi.hit >= 0 ? `, hit f${mi.hit}${mi.clear >= 0 ? `, clear f${mi.clear}` : ""}` : ", no hit mark"}; ${cues} cue${cues === 1 ? "" : "s"}${app.fx.dirty ? " (not saved)" : ""}.`;
    recBox.replaceChildren(...st.recipes().map((r) => h("div", { class: "recipe " + (r.ok ? (r.fresh ? "" : "done") : "off") },
      h("div", { class: "rhead" }, h("span", { class: "rname" }, r.title), button(r.ok && !r.fresh ? "ADDED" : "ADD", () => st.apply(r.id), r.ok ? r.tip : r.why, r.ok && r.fresh ? "gold mini" : "mini")),
      h("div", { class: "rwhy", title: r.ok ? r.tip : r.why }, r.ok ? (r.fresh ? r.why : "already on the clip") : r.why))));
    for (const b of recBox.querySelectorAll(".recipe.off button")) b.disabled = true;
    const rows = st.sheet();
    sheetBox.replaceChildren(...(rows.length ? rows : [{ kind: "none" }]).map((r) => {
      if (r.kind === "none") return h("div", { class: "item" }, "no marks and no cues yet");
      if (r.kind === "mark") return h("div", { class: "item mark", onclick: () => app.setFrame(r.frame) }, `◆ ${r.name}   f${r.frame}`);
      return h("div", { class: "item" + (app.fxSel === r.index ? " sel" : ""), onclick: () => pick(r.index) },
        `f${Math.round(r.frame)}${r.delta !== null ? `  (${r.delta >= 0 ? "+" : ""}${r.delta})` : ""}   ${r.id} @ ${r.socket}  ${r.mode}${r.scale !== 1 ? "  x" + r.scale.toFixed(2) : ""}`);
    }));
    undoBtn.disabled = !st.stack.length;
    undoBtn.textContent = st.stack.length ? "UNDO: " + st.stack[st.stack.length - 1].label : "UNDO";
    logBox.replaceChildren(...(st.log.length ? st.log.slice(-6).reverse().map((l) => h("div", { class: "logl " + (l.ok ? "ok" : "bad") }, `${new Date(l.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}  ${l.text}`))
      : [h("div", { class: "hint" }, "Nothing yet.")]));
  }
  // drawn only while the panel is on screen, and a moment after the last change (an edit drag fires many)
  let timer = null, want = true;
  const visible = () => el.isConnected && el.getClientRects().length > 0;
  const later = (ms = 120) => { want = true; if (!visible()) return; clearTimeout(timer); timer = setTimeout(() => { if (want && visible()) { want = false; render(); } }, ms); };
  el.__resize = () => { if (want) later(0); };
  app.on((w) => { if (["clip", "fighter", "fx", "fxsel", "doc", "compose", "saved", "mode"].includes(w)) later(w === "doc" ? 300 : 120); });
  later();
  return el;
}
