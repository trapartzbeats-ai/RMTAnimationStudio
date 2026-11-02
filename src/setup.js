// SETUP: the nine steps that take a fighter and a move to game-ready. Every step reads the real state (nothing is ticked by hand);
// a step that is not done has a FIX that does the work: bake the Collision Wrap and the soles in Godot, repair the sockets, add the
// end key, suggest the effect, clean the checks up, save. FIX ALL runs the lot in order. Nothing is hidden: each fix says what it
// will do first, a fix that writes into the game project asks, and the edits to the clip are one undo step each.
import { h, button, heading, hint, row } from "./ui.js";
import * as R from "./core/rig.js";
import { poseOfKey } from "./core/doc.js";
import { v3 } from "./core/clip.js";
import { kindOf } from "./library.js";
import { moveInfo, strikePoint } from "./moveinfo.js";

const SLACK = 5000;   // ms: a model written within this of its wrap is the same bake
const STANDARD = { fist_R: "handR", fist_L: "handL", foot_R: "footR", foot_L: "footL", head: "head", chest: "chest", hips: "hips", ground_mid: "root" };
const FALLBACK = [[/^hand/, ["elbow", "shoulder", "clavicle"]], [/^elbow/, ["shoulder", "clavicle"]], [/^foot/, ["knee"]], [/^knee/, ["hip"]], [/^head/, ["neck", "chest"]],
  [/^neck/, ["chest", "torso"]], [/^chest/, ["torso", "spine1", "hips"]], [/^torso/, ["spine1", "hips"]]];
const when = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// the nearest bone this model has to one it lacks (the same side), else the hips
function nearestBone(bones, bone) {
  const side = (/[LR]$/.exec(bone) || [""])[0];
  for (const [re, kin] of FALLBACK) {
    if (!re.test(bone)) continue;
    for (const k of kin) {
      if (bones.includes(k + side)) return k + side;
      if (bones.includes(k)) return k;
    }
  }
  return bones.includes("hips") ? "hips" : bones[0];
}

export class SetupEngine {
  constructor(app) {
    this.app = app;
    this.log = [];        // what Setup did: {t, id, ok, text}
    this.busy = "";       // what it is working on right now (a bake takes a while)
    this.info = null;     // host.setupInfo: when the model, wrap and soles were written
    this._fx = { key: "", plan: null };
  }

  async refreshInfo() {
    this.info = this.app.fighter ? await window.host.setupInfo(this.app.fighter) : null;
    return this.info;
  }

  say(id, ok, text) {
    this.log.push({ t: Date.now(), id, ok, text });
    if (this.log.length > 40) this.log.shift();
    this.app.say(text, ok ? "ok" : "warn");
  }

  // ---------------------------------------------------------------- the steps
  steps() {
    const a = this.app, f = a.fighter, i = this.info || {};
    const solesKey = a.rigSoles && Object.keys(a.rigSoles).find((k) => k.toLowerCase().endsWith("/" + f + "_fight.glb"));
    const hasGodot = !!i.godot;
    const noGodot = hasGodot ? "" : " (Godot was not found: set FIGHT_STUDIO_GODOT)";
    const names = Object.keys(a.sockSpecs || {});
    const broken = names.filter((n) => !a.bones.includes(a.sockSpecs[n].bone));
    const bad = a.runChecks().filter((c) => c.level !== "ok");
    const wrapStale = !!a.wrapData && i.model && i.wrap && i.model - i.wrap > SLACK;
    const solesStale = !!solesKey && i.model && i.soles && i.model - i.soles > SLACK;
    const v5 = a.v5, up = a.v5Upgrade || {};
    const rigOk = !!v5 && up.style !== "none";
    const fx = this.suggestFx();
    const cleanable = this.cleanable(bad);
    const left = bad.filter((c) => !/bends FORWARD|past its limit|loop seam|not keyed/.test(c.text));
    const k0 = a.doc.keys[0];
    const out = [
      { id: "model", ok: !!f && a.bones.length > 0, note: f ? `${f}, ${a.bones.length} bones` : "no model", go: ["Library", "Models"], label: "PICK" },
      { id: "rig", ok: rigOk, note: v5 ? `${v5.style}: ${v5.counts.simple} simple / ${v5.counts.advanced} advanced bones${(up.added || []).length ? `, the upgrade added ${up.added.length}` : ""}` : "not mapped",
        go: ["Rig v5"], label: "OPEN", fix: rigOk ? null : { label: "RELOAD RIG", plan: `Read rig_v5.json again and rebuild the bone map of ${f}` } },
      { id: "wrap", ok: !!a.wrapData && !wrapStale, stale: wrapStale,
        note: !a.wrapData ? "no Collision Wrap for this model" : wrapStale ? `baked ${when(i.wrap)}, the model was written ${when(i.model)}: bake it again` : `height ${Number(a.wrapData.height_m).toFixed(2)} m`,
        go: ["Properties"], label: "OPEN",
        fix: hasGodot && !(a.wrapData && !wrapStale) ? { label: a.wrapData ? "BAKE AGAIN" : "BAKE WRAP", confirm: true,
          plan: `Run the game's wrap_bake.gd for ${f} in Godot (headless): rewrites data/wraps/${f}.collide.json` } : null, extra: noGodot && !a.wrapData ? noGodot : "" },
      { id: "soles", ok: !!solesKey && !solesStale, stale: solesStale,
        note: !solesKey ? "no baked soles: toes use the foot mesh" : solesStale ? `baked ${when(i.soles)}, the model was written ${when(i.model)}: bake again` : "baked soles found",
        go: ["Feet"], label: "FEET",
        fix: hasGodot && !(solesKey && !solesStale) ? { label: solesKey ? "BAKE AGAIN" : "BAKE SOLES", confirm: true,
          plan: "Run feet_bake.gd in Godot (headless): reads every fighter's soles again into data/feet_soles.json" } : null, extra: noGodot && !solesKey ? noGodot : "" },
      { id: "sockets", ok: names.length >= 6 && !broken.length,
        note: `${names.length} sockets${broken.length ? `, ${broken.length} on bones this model lacks (${broken.slice(0, 3).join(", ")}${broken.length > 3 ? "..." : ""})` : ""}`,
        go: ["Sockets"], label: "OPEN",
        fix: names.length >= 6 && !broken.length ? null : { label: "REPAIR", confirm: true,
          plan: `${broken.length ? `Move ${broken.length} sockets to the nearest bone ${f} has` : "Add the standard sockets"}, then save them for ${f} only (data/sockets.json)` } },
      { id: "move", ok: a.doc.keys.length >= 2, note: `${a.doc.name}: ${a.doc.keys.length} keys, ${a.doc.frames} frames`, go: ["Library", "Animations"], label: "PICK",
        fix: a.doc.keys.length >= 2 || a.doc.frames <= (k0 ? k0.f : 0) ? null : { label: "ADD END KEY", plan: `Copy the first pose to f${a.doc.frames}, so ${a.doc.name} has a start and an end` } },
      { id: "effects", ok: !!a.fx && a.fx.count() > 0, soft: true, note: a.fx ? (a.fx.count() ? `${a.fx.count()} cues` : fx ? `none yet: ${fx.why}` : `none yet (nothing to suggest for a ${kindOf(a.doc.name).toLowerCase()} move)`) : "effects not loaded",
        go: ["Library", "Effects"], label: "PICK",
        fix: a.fx && !a.fx.count() && fx ? { label: "SUGGEST", plan: `Put ${fx.id} on ${fx.socket} at f${fx.frame} (${fx.why})` } : null },
      { id: "checks", ok: bad.length === 0, note: bad.length ? `${bad.length} to look at${cleanable.total ? `, ${cleanable.total} of them it can fix` : ""}` : "no warnings", go: ["Checks"], label: "OPEN",
        fix: cleanable.total ? { label: "CLEAN UP", plan: `${cleanable.parts.join(", ")} (one undo step)` } : null, more: left.slice(0, 4) },
      { id: "saved", ok: !a.history.dirty() && !a.isNew, note: a.history.dirty() ? "unsaved edits" : a.isNew ? "new clip, not saved yet" : "saved to the game", go: null,
        fix: a.history.dirty() || a.isNew ? { label: a.doc.name && a.doc.name !== "untitled" ? "SAVE" : "SAVE AS...", plan: `Save ${a.doc.name} into the game's clips folder (with its effect cues)` } : null },
    ];
    out.forEach((s, n) => { s.n = n + 1; s.title = `${n + 1}  ${TITLES[s.id]}`; });
    return out;
  }

  // what a fix would do, without doing it (the API says this unless told yes)
  plan(id) {
    const s = this.steps().find((x) => x.id === id);
    return s && s.fix ? { id, label: s.fix.label, plan: s.fix.plan, confirm: !!s.fix.confirm } : null;
  }

  // every fix fix-all would run, in order. A fix that edits the clip leaves it unsaved, and fix-all then saves it: that goes in the plan
  planAll() {
    const a = this.app;
    const plan = this.steps().filter((s) => !s.ok && !s.soft && s.fix).map((s) => ({ id: s.id, label: s.fix.label, plan: s.fix.plan, confirm: !!s.fix.confirm }));
    const named = a.doc.name && a.doc.name !== "untitled";
    if (named && !plan.some((p) => p.id === "saved") && plan.some((p) => p.id === "move" || p.id === "checks"))
      plan.push({ id: "saved", label: "SAVE", plan: `Save ${a.doc.name} into the game's clips folder (with its effect cues)`, confirm: false });
    return plan;
  }

  // ---------------------------------------------------------------- fixes
  async fix(id, opts = {}) {
    const a = this.app;
    if (this.busy) return { ok: false, text: `Busy: ${this.busy}` };
    const s = this.steps().find((x) => x.id === id);
    if (!s) return { ok: false, text: `No step ${id}` };
    if (!s.fix) return { ok: true, text: s.ok ? "Already done." : "Nothing Setup can do for this one: use its button." };
    this.busy = s.fix.plan;
    a.emit("setup");
    let r;
    try {
      r = await this["_" + id](opts);
    } catch (e) {
      r = { ok: false, text: `${s.fix.label} failed: ${(e && e.message) || e}` };
    } finally {
      this.busy = "";
    }
    this.say(id, r.ok, r.text);
    await this.refreshInfo();
    a.emit("setup");
    return r;
  }

  // every step that is not done and has a fix, in order; a step's fix can undo another's, so each is read again just before it runs
  async fixAll(opts = {}) {
    const did = [];
    for (const id of ["rig", "wrap", "soles", "sockets", "move", ...(opts.effects ? ["effects"] : []), "checks", "saved"]) {
      const s = this.steps().find((x) => x.id === id);
      if (!s || s.ok || !s.fix) continue;
      if (id === "saved" && (!this.app.doc.name || this.app.doc.name === "untitled")) continue;
      const r = await this.fix(id, { save: true, ...opts });
      did.push({ id, ok: r.ok, text: r.text });
      if (!r.ok) break;   // later steps lean on this one
    }
    const left = this.steps().filter((s) => !s.ok && !s.soft);
    return { did, left: left.map((s) => ({ id: s.id, note: s.note })) };
  }

  async _reload() {
    const a = this.app;
    a.rigSoles = null;
    await a.setFighter(a.fighter);
    await this.refreshInfo();
  }

  async _rig() {
    const a = this.app;
    a.rigV5Data = null;
    await this._reload();
    return a.v5 ? { ok: true, text: `Rig v5 mapped again: ${a.v5.style}.` } : { ok: false, text: "rig_v5.json could not be read." };
  }

  async _wrap() {
    const a = this.app, f = a.fighter;
    const r = await window.host.bake("wrap", f, false);
    if (!r.ok) return { ok: false, text: `The wrap bake failed: ${r.error}` };
    await this._reload();
    const line = (String(r.log || "").split("\n").find((l) => l.startsWith(f + ":")) || "").trim();
    return { ok: !!a.wrapData, text: `Baked the Collision Wrap of ${f}${line ? ` (${line.split("|")[0].trim()})` : ""}.` };
  }

  async _soles() {
    const r = await window.host.bake("soles", "", false);
    if (!r.ok) return { ok: false, text: `The soles bake failed: ${r.error}` };
    await this._reload();
    return { ok: !!this.app.rigSoles, text: "Baked the soles of every fighter (data/feet_soles.json)." };
  }

  async _sockets(opts) {
    const a = this.app;
    let moved = 0, added = 0;
    for (const n of Object.keys(a.sockSpecs)) {
      const sp = a.sockSpecs[n];
      if (!a.bones.includes(sp.bone)) { sp.bone = nearestBone(a.bones, sp.bone); moved++; }
    }
    if (Object.keys(a.sockSpecs).length < 6) {
      for (const n in STANDARD) if (!a.sockSpecs[n]) { a.sockSpecs[n] = { bone: a.bones.includes(STANDARD[n]) ? STANDARD[n] : nearestBone(a.bones, STANDARD[n]), offset: [0, 0, 0] }; added++; }
    }
    if (opts.save !== false) await a.saveSockets(true);
    a.views && a.views.dirty();
    return { ok: true, text: `Sockets repaired: ${moved} moved, ${added} added${opts.save !== false ? `, saved for ${a.fighter}` : " (not saved)"}.` };
  }

  _move() {
    const a = this.app, d = a.doc, k0 = d.keys[0];
    a.mutate("Setup: end key", () => d.writeKey(d.frames, poseOfKey(k0, a.bones), a.bones));
    return { ok: true, text: `Copied the first pose to f${d.frames}: ${d.name} has a start and an end.` };
  }

  // a new move that starts and ends on the pose on screen
  newMove(name) {
    const a = this.app;
    if (!a.newClip(name, 30, 30, false, true)) return { ok: false, text: "Move names use letters, digits, _ and - only." };
    this._move();
    const text = `New move ${a.doc.name}: a start and an end key. Pose it, then save.`;
    this.say("move", true, text);
    a.emit("setup");
    return { ok: true, text };
  }

  async _effects() {
    const a = this.app, p = this.suggestFx();
    if (!p) return { ok: false, text: "Nothing to suggest for this move." };
    const i = await a.fx.add({ id: p.id, socket: p.socket, mode: "burst", dur: 0.5, scale: 1, offset: [0, 0, 0], rot: [0, 0, 0], frame: p.frame });
    if (i < 0) return { ok: false, text: `${p.id} could not be added.` };
    a.selectFx(i);
    return { ok: true, text: `Put ${p.id} on ${p.socket} at f${p.frame} (${p.why}). Move it in the Dope Sheet or tune it in the FX mode.` };
  }

  // what the clean-up can do about the Checks' findings, read off their text
  cleanable(bad) {
    const n = (re) => bad.filter((c) => re.test(c.text)).length;
    const knees = n(/bends FORWARD/), limits = n(/past its limit/), seam = n(/loop seam/), pending = n(/not keyed/);
    const parts = [];
    if (knees) parts.push(`turn ${knees} forward knee${knees > 1 ? "s" : ""} straight`);
    if (limits) parts.push(`bring ${limits} joint${limits > 1 ? "s" : ""} back inside ${limits > 1 ? "their" : "its"} limit`);
    if (seam) parts.push("close the loop seam");
    if (pending) parts.push("key the pose you changed");
    return { total: knees + limits + seam + pending, parts };
  }

  _checks() {
    const a = this.app, d = a.doc;
    let keyed = false, clamped = 0, knees = 0, seam = false;
    if (a.pending) { a.keyNow("Setup: key the changed pose"); keyed = true; }
    const hadSeam = d.loop && a.runChecks().some((c) => /loop seam/.test(c.text));
    a.mutate("Setup: clean up the checks", () => {
      for (const k of d.keys) {
        if (k.lock) continue;   // a locked key is the user's
        const pose = poseOfKey(k, a.bones);
        let changed = false;
        for (const b of Object.keys(k.rot || {})) {
          const e = v3(k.rot[b]);
          const forward = b.startsWith("knee") && e[0] < -0.01;
          if (!forward && !R.breaksLimits(b, e)) continue;   // only what the Checks flag
          let c = R.clampLimits(b, e);
          if (forward) { c = [Math.max(0, c[0]), c[1], c[2]]; knees++; }
          pose[b] = c;
          changed = true;
          clamped++;
        }
        if (changed) d.writeKey(k.f, pose, a.bones);
      }
      if (hadSeam) {
        const k0 = d.keys[0];
        d.writeKey(d.frames, poseOfKey(k0, a.bones), a.bones);
        d.linkKeys([k0.f, d.frames], a.bones, false);
        seam = true;
      }
    });
    const left = a.runChecks().filter((c) => c.level !== "ok").length;
    const did = [keyed && "keyed the changed pose", clamped && `brought ${clamped} bone rotation${clamped > 1 ? "s" : ""} inside the limits${knees ? ` (${knees} knee${knees > 1 ? "s" : ""} straightened)` : ""}`, seam && "closed the loop seam"].filter(Boolean);
    return { ok: true, text: `${did.length ? "Cleaned up: " + did.join(", ") : "Nothing to clean"}. ${left ? left + " warning" + (left > 1 ? "s" : "") + " left for you (Checks)." : "The checks are clean."}` };
  }

  async _saved(opts) {
    const a = this.app;
    if ((!a.doc.name || a.doc.name === "untitled") && opts.name) { const r = await a.saveAs(String(opts.name)); return r.ok ? { ok: true, text: `Saved ${a.doc.name}.` } : { ok: false, text: `Not saved: ${r.error}` }; }
    const r = await a.save();
    return r.ok ? { ok: true, text: `Saved ${a.doc.name}.` } : { ok: false, text: `Not saved: ${r.error}` };
  }

  // ---------------------------------------------------------------- the effect to suggest
  // an attack: an impact on the limb that strikes, at the clip's hit mark (else where a limb is fastest); a landing: a puff at the feet
  suggestFx() {
    const a = this.app, d = a.doc;
    const key = `${a.fighter}|${d.name}|${a.history.undoStack.length}|${d.extra.marks ? JSON.stringify(d.extra.marks) : ""}|${a.fx ? a.fx.count() : 0}`;
    if (this._fx.key !== key) this._fx = { key, plan: a.fx && !a.fx.count() ? this._analyse() : null };
    return this._fx.plan;
  }

  _analyse() {
    const a = this.app, d = a.doc;
    if (!a.stage || !a.stage.probe || !a.fx) return null;
    const have = (id) => a.fx.library.has(id);
    if (kindOf(d.name) === "Attacks" && have("impact_spark")) {
      const sp = strikePoint(a);
      return sp ? { id: "impact_spark", socket: sp.socket, frame: sp.frame, why: sp.why } : null;
    }
    if (/(^|_)land/.test(d.name) && have("cloud_puff")) {
      const mi = moveInfo(a);
      return !mi || mi.landing < 0 ? null : { id: "cloud_puff", socket: "ground_mid", frame: mi.landing, why: `the feet reach the floor at f${mi.landing}` };
    }
    return null;
  }
}

const TITLES = { model: "Model on the stage", rig: "Rig v5 joints", wrap: "Collision Wrap baked", soles: "Foot soles read", sockets: "Sockets placed",
  move: "A move to work on", effects: "Effects on the move", checks: "Checks clean", saved: "Saved" };

// ==================================================================== the panel
export function Setup(app) {
  const st = app.setup;
  const el = h("div", { class: "pbody" });
  const stepsBox = h("div", { class: "steps" });
  const summary = h("div", { class: "hint" });
  const logBox = h("div", { class: "setuplog" });
  const go = (panel, tab) => () => { if (tab) { app.libraryTab = tab; app.emit("libtab"); } app.ui.showPanel(panel); };
  el.append(heading("Setup"), hint("A guided run from a model to a game-ready move. Each step shows what the app sees right now; a step that is not done has a button that does the work."),
    summary, row(button("FIX ALL", () => fixAll(), "Do every step that is not done, in order (it asks first, and says what each one will do)", "gold"),
      button("RE-CHECK", async () => { await st.refreshInfo(); render(); }, "Read the state again"), button("SAVE CLIP", () => app.save(), "Ctrl+S: writes the clip where the game reads it")),
    stepsBox, heading("What Setup did"), logBox);

  async function ask(text) { return window.host.confirm(text); }

  async function fixOne(s) {
    if (s.fix.confirm && !(await ask(s.fix.plan + "?"))) return;
    if (s.id === "saved" && s.fix.label === "SAVE AS...") { app.ui.prompt("Name for the move:", "my_move", (n) => st.fix("saved", { name: n })); return; }
    await st.fix(s.id, { save: true });
  }

  async function fixAll() {
    const todo = st.planAll();
    if (!todo.length) { app.say("Every required step is done.", "ok"); return; }
    if (!(await ask("Fix all will:\n\n" + todo.map((t, i) => `${i + 1}. ${t.plan}`).join("\n") + "\n\nGo?"))) return;
    const r = await st.fixAll({ save: true });
    app.say(r.left.length ? `Setup did ${r.did.length} fixes; ${r.left.length} steps still need you.` : "Setup is done: this move is game-ready.", r.left.length ? "warn" : "ok");
  }

  function render() {
    const list = st.steps();
    const need = list.filter((s) => !s.soft);
    const done = need.filter((s) => s.ok).length;
    summary.textContent = st.busy ? `Working: ${st.busy}...` : done === need.length ? "Every required step is done: this move is game-ready." : `${done} of ${need.length} required steps done.`;
    stepsBox.replaceChildren(...list.map((s) => h("div", { class: "step " + (s.ok ? "ok" : s.stale ? "stale" : s.soft ? "soft" : "todo") },
      h("span", { class: "dot" }, s.ok ? "✓" : s.stale ? "!" : s.soft ? "○" : "✗"),
      h("div", { class: "st" }, h("div", { class: "stt" }, s.title), h("div", { class: "stn" }, s.note + (s.extra || "")),
        ...(s.more || []).map((c) => h("div", { class: "stn more", title: "Go to that frame", onclick: () => c.f >= 0 && app.setFrame(c.f) }, "· " + c.text))),
      h("div", { class: "acts" },
        s.fix ? button(s.fix.label, () => fixOne(s), s.fix.plan, "gold") : null,
        s.id === "move" && !s.ok ? button("NEW MOVE", () => app.ui.prompt("Name for the new move:", "my_move", (n) => st.newMove(n)), "A new move that starts and ends on the pose on screen") : null,
        s.go ? button(s.label, go(s.go[0], s.go[1]), "Go to the place for this step") : null))));
    logBox.replaceChildren(...(st.log.length ? st.log.slice(-8).reverse().map((l) => h("div", { class: "logl " + (l.ok ? "ok" : "bad") }, `${new Date(l.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}  ${l.text}`))
      : [h("div", { class: "hint" }, "Nothing yet.")]));
    for (const b of el.querySelectorAll("button")) if (st.busy && b.textContent !== "RE-CHECK") b.disabled = true;
  }
  app.on((w) => {
    if (w === "fighter" || w === "clip") st.refreshInfo().then(render);
    else if (!["frame", "status", "api", "tool", "libtab", "fxsel", "mode"].includes(w)) render();
  });
  st.refreshInfo().then(render);
  return el;
}
