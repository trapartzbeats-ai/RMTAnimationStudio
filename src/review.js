// REVIEW: a verdict on the open move. The checks the app already runs (knees, limits, wrists, loop seam, feet, Collision Wrap), the
// wrap and sole data being current, the move's frame data from its hit / clear marks, how far and how fast each striker goes, and
// whether the effects land on the hit - on one card sheet with a verdict, a contact sheet of every angle and a report to copy.
// Nothing here changes the clip: it measures (moveinfo.js) and reads (app.runChecks, app.setup, app.fx).
import { h, button, heading, hint, row, label, check } from "./ui.js";
import { kindOf } from "./library.js";
import { moveInfo, frameData, strikerStats, mainStriker } from "./moveinfo.js";

const ORDER = { error: 3, warn: 2, info: 1, ok: 0 };
const worst = (a, b) => (ORDER[b] > ORDER[a] ? b : a);
const MARK = { ok: "✓", warn: "!", error: "✗", info: "○" };
const CLASS = { ok: "ok", warn: "stale", error: "todo", info: "soft" };

// where each check belongs on the sheet (the order is the order of the cards)
const CATS = [
  ["joints", "Joints", /bends FORWARD|past its limit|past a finger|is after the end/],
  ["arms", "Arms and wrists", /\(the wrist\)|\(the upper arm's roll\)/],
  ["loop", "Loop seam", /loop seam/],
  ["feet", "Feet", /planted foot slides|hangs tipped/],
  ["wrap", "Collision Wrap", /^Collision Wrap|has no Collision Wrap|^\s+(keyed|after the solve):/],
];

const impactish = (e) => !!e && (["impacts", "impact", "melee"].includes(e.category) || (e.manifest.tags || []).some((t) => /^(impact|hit)$/.test(t)));
const swingish = (e) => !!e && (e.manifest.tags || []).some((t) => /^(slash|swoosh|trail|follow|motion|swing)$/.test(t));

// -> {fighter, clip, verdict, counts, cards [{id, title, level, note, f, more[]}], frame_data, strikers, effects [{index, id, socket, frame, delta, flag}], text}
export function buildReport(app) {
  const d = app.doc;
  const checks = app.runChecks();
  const cards = [];
  const left = checks.filter((c) => c.level !== "ok" || /^Collision Wrap/.test(c.text));
  const used = new Set();
  for (const [id, title, re] of CATS) {
    const mine = left.filter((c) => re.test(c.text));
    mine.forEach((c) => used.add(c));
    if (id === "loop" && !d.loop) { cards.push({ id, title, level: "info", note: "not a loop", f: -1, more: [] }); continue; }
    if (id === "feet" && !d.plant) { cards.push({ id, title, level: "info", note: "this clip is not planted (Properties > planted)", f: -1, more: [] }); continue; }
    let level = "ok";
    if (id === "wrap") level = (mine[0] && mine[0].level) || "ok";   // the head line is the verdict, the rows under it are detail
    else for (const c of mine) level = worst(level, c.level);
    const lead = mine.find((c) => c.level === level && c.level !== "info") || mine[0];
    const okNote = { joints: "knees bend the right way, every joint inside its limits", arms: "wrists and upper arms turn within range", loop: "first and last frame match",
      feet: "planted feet hold and stand flat", wrap: "no clashes" }[id];
    cards.push({ id, title, level, note: lead ? lead.text.trim() : okNote, f: lead ? lead.f : -1,
      more: mine.filter((c) => c !== lead).slice(0, 4).map((c) => ({ text: c.text.trim(), f: c.f })) });
  }
  const rest = left.filter((c) => !used.has(c));
  if (rest.length) cards.push({ id: "clip", title: "Clip", level: rest.reduce((l, c) => worst(l, c.level), "ok"), note: rest[0].text, f: rest[0].f, more: rest.slice(1, 4).map((c) => ({ text: c.text, f: c.f })) });

  // the game's data for this fighter being current
  const steps = app.setup ? app.setup.steps() : [];
  const data = steps.filter((s) => s.id === "wrap" || s.id === "soles");
  if (data.length) {
    const bad = data.filter((s) => !s.ok);
    cards.push({ id: "data", title: "Game data", level: bad.length ? "warn" : "ok", f: -1,
      note: bad.length ? bad.map((s) => `${s.id}: ${s.note}`).join("; ") + " (SETUP bakes them)" : "wrap and soles are baked from the current model", more: [] });
  }

  // effects against the hit
  const fps = Math.max(1, d.fps), tol = Math.max(1, Math.round(2 * fps / 60));
  const mi = moveInfo(app);
  const hit = mi ? mi.hit : -1;
  const effects = [];
  if (app.fx) {
    app.fx.list().forEach((c) => {
      const e = app.fx.library.get(c.id);
      const delta = hit >= 0 ? c.frame - hit : null;
      let flag = "";
      if (c.frame > d.frames || c.frame < 0) flag = "outside the clip";
      else if (delta !== null && c.mode === "burst" && impactish(e) && !swingish(e) && Math.abs(delta) > tol) flag = `${delta > 0 ? "late" : "early"} by ${Math.abs(delta)} f`;
      effects.push({ index: c.index, id: c.id, socket: c.socket, mode: c.mode, frame: c.frame, delta, flag });
    });
  }
  const off = effects.filter((x) => x.flag);
  const attack = kindOf(d.name) === "Attacks";
  let fxNote, fxLevel = "ok";
  if (off.length) { fxLevel = "warn"; fxNote = off.map((x) => `${x.id} f${x.frame} is ${x.flag}`).join("; ") + (hit >= 0 ? ` (the hit is f${hit})` : ""); }
  else if (effects.length) fxNote = `${effects.length} effect${effects.length > 1 ? "s" : ""}${hit >= 0 ? ", the impacts are on the hit (f" + hit + ")" : ""}`;
  else { fxLevel = "info"; fxNote = attack ? "no effect on this attack yet (COMPOSE has recipes)" : "no effects (optional)"; }
  if (attack && hit < 0) { fxLevel = worst(fxLevel, "info"); fxNote += "; no hit mark set (Properties > hit)"; }
  cards.push({ id: "effects", title: "Effects", level: fxLevel, note: fxNote, f: off.length ? off[0].frame : -1, more: [] });

  if (app.history.dirty()) cards.push({ id: "saved", title: "Saved", level: "info", note: "this clip has changes that are not saved yet", f: -1, more: [] });

  const counts = { error: 0, warn: 0, info: 0, ok: 0 };
  for (const c of cards) counts[c.level]++;
  const verdict = counts.error ? "BLOCKED" : counts.warn ? "NEEDS WORK" : "READY";
  const fd = frameData(app);
  const strikers = strikerStats(app);
  const rep = { fighter: app.fighter, clip: d.name, frames: d.frames, fps: d.fps, loop: !!d.loop, planted: !!d.plant, verdict, counts, cards, frame_data: fd, strikers, effects };
  rep.text = reportText(rep);
  return rep;
}

function reportText(r) {
  const out = [`REVIEW  ${r.fighter} / ${r.clip}  (${r.frames} f @ ${r.fps} fps${r.loop ? ", loop" : ""}${r.planted ? ", planted" : ""})  -  ${r.verdict}`];
  for (const c of r.cards) out.push(`  ${MARK[c.level]} ${c.title}: ${c.note}${c.f >= 0 ? `  [f${c.f}]` : ""}`, ...c.more.map((m) => `      ${m.text}`));
  const fd = r.frame_data;
  if (fd) {
    out.push(fd.startup ? `FRAME DATA  startup ${fd.startup.f} f (${fd.startup.ms} ms)${fd.active ? `, active ${fd.active.f} f (${fd.active.ms} ms), recovery ${fd.recovery.f} f (${fd.recovery.ms} ms)` : ", no clear mark"}, total ${fd.frames} f (${fd.total_ms} ms)`
      : `FRAME DATA  no hit mark, total ${fd.frames} f (${fd.total_ms} ms)`);
  }
  for (const s of r.strikers) out.push(`STRIKER  ${s.socket}: top speed ${s.peak_ms} m/s at f${s.peak_f}${s.at_hit_ms !== null ? `, ${s.at_hit_ms} m/s at the hit` : ""}, reach ${s.reach_m} m (forward ${s.fwd_m} m)`);
  for (const e of r.effects) out.push(`EFFECT  f${e.frame}  ${e.id} @ ${e.socket} ${e.mode}${e.delta !== null ? `  (${e.delta >= 0 ? "+" : ""}${e.delta} from the hit)` : ""}${e.flag ? "  <-- " + e.flag : ""}`);
  return out.join("\n");
}

// ==================================================================== the panel
export function Review(app) {
  const el = h("div", { class: "pbody" });
  const banner = h("div", { class: "verdict" });
  const cardsBox = h("div", { class: "steps" });
  const dataBox = h("div", { class: "vtab" });
  const lastShot = h("div", { class: "hint" });
  let rep = null, stale = false, busy = false;

  const flag = (key, text, tip) => check(text, key === "onion" ? app.onion.on : !!app.show[key], (v) => {
    if (key === "onion") app.onion.on = v; else app.show[key] = v;
    app.applyNow();
    app.views.stripDirty();
    app.emit("tool");
  }, tip);
  const angle = (name) => button(name, () => {
    const vh = app.views.main, v = vh.focused || vh.views[0];
    if (v) { v.setPreset(name); vh.focused = v; app.views.dirty(); }
  }, `Turn the selected view to ${name}`);
  const layout = (text, l) => button(text, () => { app.views.main.setLayout(l); app.emit("tool"); });

  el.append(heading("Review"), hint("A verdict on this move: checks, game data, frame data, striker reach, effects on the hit. It reads the clip and never changes it."),
    banner,
    row(button("RE-RUN", () => run(), "Check the move again"), button("NEXT PROBLEM", () => nextProblem(), "Jump to the next frame a check complains about"),
      button("COPY REPORT", () => copy(), "The whole review as text, to paste into a note or a message"), button("CONTACT SHEET", () => sheet(), "A picture of the move from every angle (front, three-quarter, side, back) across its frames, in the renders folder")),
    cardsBox, heading("Frame data"), dataBox, lastShot,
    heading("Look at it"),
    row(label("view"), angle("Front"), angle("Three-Q"), angle("Side L"), angle("Back"), angle("Top")),
    row(label("layout"), layout("QUAD + STRIP", "4+strip"), layout("STRIP", "strip"), layout("QUAD", "4"), layout("ONE", "1")),
    row(flag("wrap", "Collision Wrap", "Show the move as the match's Body Solve shows it"), flag("wrapCaps", "wrap capsules", "Red = still in the body"), flag("onion", "onion skin"), flag("trail", "motion trail"), flag("gameFeet", "game feet", "Plant + flat feet like a match")));

  const goto = (f) => { if (f >= 0) app.setFrame(f); };

  function nextProblem() {
    if (!rep) return;
    const fs = [...new Set(rep.cards.flatMap((c) => [c.f, ...c.more.map((m) => m.f)]).filter((f) => f >= 0))].sort((a, b) => a - b);
    if (!fs.length) { app.say("Nothing to jump to: no check points at a frame.", "ok"); return; }
    const now = Math.round(app.frame);
    app.setFrame(fs.find((f) => f > now) ?? fs[0]);
  }

  async function copy() {
    if (!rep) run();
    try { await navigator.clipboard.writeText(rep.text); app.say("The review is on the clipboard.", "ok"); } catch { app.say("Could not reach the clipboard.", "warn"); }
  }

  async function sheet() {
    lastShot.textContent = "Rendering the contact sheet...";
    const p = await app.ui.picture("sheet", 1920, 1080, 8);
    lastShot.textContent = p ? `Contact sheet: ${p}` : "The contact sheet did not render.";
  }

  function render() {
    if (!rep) { banner.textContent = "No review yet."; cardsBox.replaceChildren(); dataBox.replaceChildren(); return; }
    const c = rep.counts;
    banner.className = "verdict " + ({ READY: "ready", "NEEDS WORK": "work", BLOCKED: "blocked" }[rep.verdict]);
    banner.replaceChildren(h("div", { class: "vword" }, rep.verdict),
      h("div", { class: "vsub" }, `${rep.fighter} / ${rep.clip}   ${c.error} error${c.error === 1 ? "" : "s"}, ${c.warn} warning${c.warn === 1 ? "" : "s"}, ${c.ok} passed${stale ? "   (edited since: RE-RUN)" : ""}`));
    cardsBox.replaceChildren(...rep.cards.map((k) => h("div", { class: "step " + CLASS[k.level] },
      h("span", { class: "dot" }, MARK[k.level]),
      h("div", { class: "st" }, h("div", { class: "stt" }, k.title), h("div", { class: "stn" }, k.note),
        ...k.more.map((m) => h("div", { class: "stn more", title: "Go to that frame", onclick: () => goto(m.f) }, "· " + m.text))),
      k.f >= 0 ? h("div", { class: "acts" }, button(`f${k.f}`, () => goto(k.f), "Go to that frame")) : null)));
    const fd = rep.frame_data, rows = [];
    const cell = (t, cls = "") => h("span", { class: cls }, t);
    if (fd && fd.startup) {
      rows.push(h("div", { class: "vrow head" }, cell(""), cell("frames"), cell("@ 60 fps"), cell("ms")));
      for (const [t, k] of [["startup", fd.startup], ["active", fd.active], ["recovery", fd.recovery]]) if (k) rows.push(h("div", { class: "vrow" }, cell(t, "vk"), cell(k.f), cell(k.f60), cell(k.ms)));
      rows.push(h("div", { class: "vrow" }, cell("total", "vk"), cell(fd.frames), cell(Math.round(fd.frames * 60 / fd.fps)), cell(fd.total_ms)));
      if (!fd.active) rows.push(h("div", { class: "hint" }, "Set a clear mark (Properties > clear) for the active and recovery frames."));
    } else rows.push(h("div", { class: "hint" }, fd ? `No hit mark: total ${fd.frames} f (${fd.total_ms} ms). Set one in Properties to get startup / active / recovery.` : "No stage yet."));
    if (rep.strikers.length) {
      rows.push(h("div", { class: "vrow head", title: "Speed through the world, as the game shows it; reach is from the hips" }, cell("striker"), cell("top m/s"), cell("at"), cell("reach m")));
      for (const s of rep.strikers) rows.push(h("div", { class: "vrow link", title: "Go to its fastest frame", onclick: () => goto(s.peak_f) }, cell(s.socket, "vk"), cell(s.peak_ms), cell("f" + s.peak_f), cell(s.reach_m)));
    }
    dataBox.replaceChildren(...rows);
  }

  function run() {
    if (busy) return;
    busy = true;
    want = false;
    try { rep = buildReport(app); stale = false; } catch (e) { rep = null; banner.textContent = "The review failed: " + (e && e.message ? e.message : e); busy = false; return; }
    busy = false;
    render();
  }

  // the review runs when the move, the save or the cues change - only while the panel is on screen, a moment after the last change
  let timer = null, want = true;
  const visible = () => el.isConnected && el.getClientRects().length > 0;
  const later = (ms = 300) => { want = true; if (!visible()) return; clearTimeout(timer); timer = setTimeout(() => { if (want && visible()) run(); }, ms); };
  el.__resize = () => { if (want) later(0); };
  app.review = { run: () => { run(); return rep; }, get report() { return rep; } };
  app.on((w) => {
    if (["clip", "saved", "fighter", "fx", "mode"].includes(w)) later();
    else if (w === "doc" && rep && !stale) { stale = true; render(); }
  });
  later();
  return el;
}

export { mainStriker };
