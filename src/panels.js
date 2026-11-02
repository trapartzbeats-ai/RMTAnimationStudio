// Every dock panel: builds once, refreshes on app changes.
import { h, button, heading, hint, row, label, select, check, num, slider, list, AX } from "./ui.js";
import * as R from "./core/rig.js";
import { EASES, newId, poseOfKey } from "./core/doc.js";
import { targetPoint } from "./core/evalc.js";
import { DEG, RAD, v3 } from "./core/clip.js";
import { PROP_SHAPES } from "./stage.js";
import { renderPicture } from "./views.js";
import * as A from "./core/adjust.js";
import * as M from "./core/merge.js";
import * as FL from "./core/fill.js";
import * as AL from "./core/alive.js";
import * as GT from "./core/gait.js";

// the MCP server ships with the game project's animator (game/packs/city_breaker/animator/mcp)
let MCP = "game/packs/city_breaker/animator/mcp/fight_studio_mcp.py";
export const setMcpPath = (p) => { if (p) MCP = String(p).replace(/\\/g, "/"); };
export const mcpConfig = () => JSON.stringify({ mcpServers: { "fight-studio": { command: "python", args: [MCP] } } }, null, 2);
const body = () => h("div", { class: "pbody" });
const prompt = (app, text, value, fn) => app.ui.prompt(text, value, fn);

// ==================================================================== CLIPS
export function Clips(app) {
  const el = body();
  const search = h("input", { placeholder: "search clips...", oninput: () => refill() });
  const filters = ["All", "Mine (no prefix)", "World (w_)", "Fighter moves (a_)", "This fighter's own"];
  const filt = select(filters, filters[0], () => refill());
  const l = list(null, (i, t) => app.openClip(t));
  l.el.style.minHeight = "300px";
  el.append(heading("Clips"), hint("Every clip the game reads (data/clips). Double-click to open."), search, filt, l.el,
    row(button("OPEN", () => l.text() && app.openClip(l.text())), button("NEW", () => prompt(app, "Name for the new clip (starts from the pose on screen):", "my_clip", (n) => app.newClip(n, 30, 30, false, true))),
      button("DUPLICATE", () => prompt(app, `Save a copy of ${app.doc.name} as:`, app.doc.name + "_v2", (n) => app.saveAs(n)))),
    row(button("AS LAYER", () => { if (l.text()) { app.addLayer({ name: l.text(), source: "clip", clip: l.text(), mode: "override", mask: R.MASKS["Upper body"] }); app.ui.showPanel("Layers"); } }, "Blend the selected clip on top as a layer"),
      button("TO TRASH", async () => { const n = l.text(); if (n && (await window.host.confirm(`Move ${n} to ${app.info.dirs.trash}?`))) { await app.trashClip(n); refill(); } }, "Clips are never deleted: they move to the trash folder"),
      button("RELOAD", () => refill())));
  let all = [];
  async function refill(reload = false) {
    if (reload || !all.length) all = await window.host.listClips();
    const q = search.value.trim().toLowerCase();
    const m = filters.indexOf(filt.value);
    const names = all.filter((s) => (m === 1 ? !s.startsWith("a_") && !s.startsWith("w_") : m === 2 ? s.startsWith("w_") : m === 3 ? s.startsWith("a_") : m === 4 ? s.startsWith(`a_${app.fighter}_`) : true) && (!q || s.toLowerCase().includes(q)));
    l.set(names, names.indexOf(app.doc.name), names.map((n) => (n === app.doc.name ? "#ffc93c" : "")));
  }
  app.on((w) => { if (["clips", "saved", "clip", "fighter"].includes(w)) refill(w !== "clip"); });
  refill(true);
  return el;
}

// ==================================================================== PROPERTIES
export function Props(app) {
  const el = body();
  const boneName = h("div", { class: "big" });
  const boneHint = hint("");
  const rot = [], locks = [];
  el.append(heading("Bone"), boneName, boneHint);
  for (let i = 0; i < 3; i++) {
    const s = slider(["X  turn", "Y  turn", "Z  turn"][i], -180, 180, 0.5, 0, () => onRot(), { color: AX[i], title: "Degrees on the bone's own axes" });
    const lk = check("lock", false, () => onLock(), "Freeze this channel: no tool can change it");
    s.el.append(lk);
    rot.push(s); locks.push(lk.querySelector("input"));
    el.append(s.el);
  }
  el.append(row(button("RESET BONE", () => app.resetBones(app.selBones)), button("MIRROR TO OTHER SIDE", () => {
    const m = R.mirrorName(app.selBone);
    if (m === app.selBone) return app.say(`${m} is a centre bone.`, "warn");
    const p = app.editablePose();
    p[m] = app.doc.guard(m, p[m] || [0, 0, 0], R.mirrorEuler(p[app.selBone] || [0, 0, 0]));
    app.editPose(p, `Mirror ${app.selBone} to ${m}`);
  }), button("KEY", () => app.keyNow())));
  el.append(heading("Body move (hips shift)"));
  const hips = ["dx", "dy", "dz"].map((ax, i) => {
    const s = slider({ dx: "side (m)", dy: "height (m)", dz: "forward (m)" }[ax], -1.5, 1.5, 0.005, 0, (v) => app.setHipsShift(ax, v), { color: AX[i] });
    el.append(s.el);
    return s;
  });
  el.append(heading("This key"));
  const keyInfo = h("div", { class: "txt" });
  const ease = select(EASES, "linear", (v) => app.setKeysField([Math.round(app.frame)], "ease", v), "How the motion leaves this key toward the next");
  const tag = select(["key", "breakdown", "extreme"], "key", (v) => app.setKeysField([Math.round(app.frame)], "tag", v === "key" ? "" : v));
  const klock = check("locked", false, (on) => app.setKeysField([Math.round(app.frame)], "lock", on), "A locked key cannot be changed, moved or deleted");
  el.append(keyInfo, row(label("ease"), ease, label("type"), tag, klock));
  el.append(heading("Clip"));
  const plant = check("plant feet (the game stands the lower foot on the floor)", false, (on) => app.setClipProp("plant", on));
  const over = check("override a baked clip of the same name", false, (on) => app.setClipProp("override", on));
  const dease = select(EASES, "linear", (v) => app.setClipProp("ease", v), "The ease of every key without its own");
  const note = h("input", { placeholder: "note", onchange: () => app.setClipProp("note", note.value) });
  const marks = h("div");
  el.append(plant, over, row(label("default ease"), dease), note, heading("Marks and markers"),
    hint("hit / clear: the frames a move's hitbox goes live and ends. Markers are your notes on the ruler."), marks,
    row(button("HIT HERE", () => setMark("hit")), button("CLEAR HERE", () => setMark("clear")),
      button("+ MARKER", () => prompt(app, "Marker name:", "contact", (n) => { const f = Math.round(app.frame); app.mutate("Marker " + n, () => app.doc.addMarker(f, n)); }))));
  function setMark(m) { app.setClipProp("marks", { ...(app.doc.extra.marks || {}), [m]: Math.round(app.frame) }); }
  function onRot() { app.setBoneEuler(app.selBone, rot.map((s) => Number(s.r.value) * RAD)); }
  function onLock() { app.setLock(app.selBone, locks.map((c, i) => (c.checked ? "xyz"[i] : "")).join("")); }
  function refresh() {
    const b = app.selBone, p = app.editablePose();
    const label = app.boneLabel(b);
    boneName.textContent = label + (label !== b ? `   · ${b}` : "") + (app.selBones.length > 1 ? `   (${app.selBones.length} selected)` : "");
    boneHint.textContent = R.hint(label);
    const e = p[b] || [0, 0, 0];
    rot.forEach((s, i) => { s.set(e[i] * DEG); locks[i].checked = app.doc.isLocked(b, i); s.disable(app.doc.isLocked(b, i)); });
    hips.forEach((s, i) => s.set(p[["_dx", "_dy", "_dz"][i]] || 0));
    const f = Math.round(app.frame), k = app.doc.keyAt(f);
    if (!k) keyInfo.textContent = `f${f} is between keys (K sets one)`;
    else {
      const partners = app.doc.partners(f, app.bones, true);
      keyInfo.textContent = `f${f} is a key${k.link ? "  - linked " + k.link : ""}${partners.length ? "  - same pose as f" + partners.join(", f") : ""}`;
      ease.value = k.ease || app.doc.ease;
      tag.value = k.tag || "key";
      klock.querySelector("input").checked = !!k.lock;
    }
    [ease, tag, klock.querySelector("input")].forEach((x) => (x.disabled = !k));
    plant.querySelector("input").checked = app.doc.plant;
    over.querySelector("input").checked = app.doc.override;
    dease.value = app.doc.ease;
    if (document.activeElement !== note) note.value = app.doc.extra.note || "";
    marks.innerHTML = "";
    const mk = app.doc.extra.marks || {};
    for (const m in mk) marks.append(h("div", { class: "txt", style: `color:${m === "hit" ? "#ff4d4d" : "#4fd1ff"}` }, `${m}  f${Number(mk[m]).toFixed(1)}`));
    app.doc.markers.forEach((m, i) => marks.append(row(h("span", { class: "txt", style: "color:#ffc93c" }, `marker ${m.name}  f${m.f}`), button("x", () => app.mutate("Remove marker", () => app.doc.markers.splice(i, 1))))));
  }
  app.on((w) => { if (["sel", "frame", "doc", "pending", "clip", "fighter", "tool"].includes(w)) refresh(); });
  return el;
}

// ==================================================================== RIG V5
export function RigV5(app) {
  const el = body();
  const info = h("div", { class: "tag muted" });
  const tierSel = select(["simple", "advanced"], app.boneTier, (v) => app.setBoneTier(v), "Simple = body/limbs/tail/ears, Advanced = clavicles, Spine1, toes and full fingers");
  const controls = h("div");
  el.append(heading("Rig v5"), hint("One canonical bone/control schema over rig-v4 and Mixamo skeletons. A rig-v4 fighter is upgraded on load: the v5 bones it lacks (Spine1, clavicles, toes, 4th finger joints, tail tip) are inserted at rest, so ADVANCED is the full rig. The tier only hides bones; the schema keeps the full mapping for the agent API."),
    info, row(tierSel), controls);
  let sliders = [];
  function refresh() {
    const v = app.v5;
    if (!v) {
      info.textContent = "No rig_v5.json loaded.";
      controls.innerHTML = "";
      sliders = [];
      return;
    }
    const up = app.v5Upgrade || {};
    const made = (up.added || []).length;
    info.textContent = `${v.name} · ${v.style}${made ? ` (v5 upgraded +${made})` : v.counts.advanced >= 73 ? " (native v5)" : ""} · ${v.counts[app.boneTier]} of ${v.counts.advanced} bones · ${v.missing.length} missing · ${v.extras.length} extra`;
    info.title = made ? "Added by the v4 → v5 upgrade: " + up.added.join(", ") : "";
    tierSel.value = app.boneTier;
    controls.innerHTML = "";
    sliders = [];
    const pose = app.editablePose();
    for (const ctl of v.controls(app.boneTier)) {
      const mapped = app.v5ControlFor(ctl);
      const s = slider(ctl.name, Number(ctl.min ?? -1), Number(ctl.max ?? 1), 0.01, 0, (value) => app.applyV5Control(ctl.name, value),
        { title: `${ctl.tier} control · ${ctl.drives.length} bone channels${ctl.grounded ? " · grounded: the hips drop by the leg fold, feet stay put" : ""}` });
      s.set(R.controlValue(mapped, pose));
      sliders.push({ ctl: mapped, s });
      controls.append(s.el);
    }
  }
  // an agent edit (or the Controls panel) moves a control: show the pose, but leave a slider being dragged alone
  function syncValues() {
    if (sliders.some(({ s }) => s.el.contains(document.activeElement))) return;
    const pose = app.editablePose();
    for (const { ctl, s } of sliders) s.set(R.controlValue(ctl, pose));
  }
  app.on((w) => {
    if (["fighter", "bones", "clip", "doc"].includes(w)) refresh();
    else if (w === "pending" || w === "api") syncValues();
  });
  refresh();
  return el;
}

// ==================================================================== CONTROLS
export function Controls(app) {
  const el = body();
  const box = h("div");
  el.append(heading("Controls"), hint("One slider moves several bones together (a fist, a spine curl, a crouch). The slider reads the pose; key the result with K or AUTO KEY."), box);
  const nameIn = h("input", { placeholder: "new control name" });
  const target = h("select");
  const boneSel = h("select");
  const axSel = select(["X", "Y", "Z", "move side", "move up", "move forward"], "X", () => {});
  const amount = num(30, () => {}, { min: -180, max: 180, title: "How far the channel goes at value 1 (degrees, or cm for moves)" });
  el.append(heading("Add your own control"), nameIn, target, row(boneSel, axSel, amount),
    row(button("ADD DRIVE", () => add()), button("REMOVE CONTROL", () => { if (target.selectedIndex > 0) { R.rigData.controls.splice(target.selectedIndex - 1, 1); build(); } }),
      button("SAVE CONTROLS", async () => { await R.saveRigData(); app.say("Controls saved to data/animator_rig.json (shared with the Godot Animator).", "ok"); })));
  let sliders = [];
  function add() {
    const i = axSel.selectedIndex;
    const ax = [0, 1, 2, "dx", "dy", "dz"][i];
    const amt = i < 3 ? Number(amount.value) * RAD : Number(amount.value) / 100;
    const bone = i < 3 ? boneSel.value : "hips";
    if (target.selectedIndex > 0) R.rigData.controls[target.selectedIndex - 1].drives.push([bone, ax, amt]);
    else {
      if (!nameIn.value.trim()) return app.say("Name the new control first.", "warn");
      R.rigData.controls.push({ name: nameIn.value.trim(), min: -1, max: 1, drives: [[bone, ax, amt]] });
    }
    build();
    app.say("Control updated (SAVE CONTROLS keeps it).", "ok");
  }
  function build() {
    box.innerHTML = "";
    sliders = R.rigData.controls.map((ctl) => {
      const s = slider(ctl.name, Number(ctl.min ?? -1), Number(ctl.max ?? 1), 0.01, 0, (v) => app.setControl(ctl, v), { title: `${ctl.drives.length} bone channels` });
      s.el.style.display = ctl.drives.some((d) => app.bones.includes(d[0])) ? "" : "none";
      box.append(s.el);
      return s;
    });
    target.innerHTML = "";
    target.add(new Option("(new control)"));
    for (const c of R.rigData.controls) target.add(new Option(c.name));
    boneSel.innerHTML = "";
    for (const b of app.bones) boneSel.add(new Option(b));
    refresh();
  }
  function refresh() {
    const p = app.editablePose();
    R.rigData.controls.forEach((c, i) => sliders[i] && sliders[i].set(R.controlValue(c, p)));
  }
  app.on((w) => { if (w === "fighter") build(); else if (["frame", "doc", "pending", "clip"].includes(w)) refresh(); });
  build();
  return el;
}

// ==================================================================== LAYERS
export function Layers(app) {
  const el = body();
  let selId = "";
  const l = list((i) => { selId = app.doc.layers[i].id; edit(); });
  const clipIn = h("input", { placeholder: "clip to blend in (name)" });
  const ed = h("div");
  el.append(heading("Layers"), hint("KEYS layers tweak without touching the base keys; CLIP layers blend another clip in. add = adds its turns, add_delta = adds a clip's motion from its first frame, override = blends toward it. Masks pick bones, fades blend in and out. Saving bakes them for the game."),
    row(button("+ KEYS LAYER", () => { const ly = app.addLayer({ name: `tweak ${app.doc.layers.length + 1}`, mode: "add", source: "keys" }); ly.then((x) => { selId = x.id; app.setActiveLayer(x.id); }); }), button("BASE", () => app.setActiveLayer(""), "Key into the base clip again")),
    row(clipIn, button("+ CLIP LAYER", async () => {
      const n = clipIn.value.trim();
      if (!(await window.host.loadClip(n))) return app.say(`No clip named ${n}.`, "warn");
      const ly = await app.addLayer({ name: n, mode: "override", source: "clip", clip: n, mask: R.MASKS["Upper body"] });
      selId = ly.id;
    })), aliveRow(), gaitRow(), balanceRow(), l.el, ed, row(button("BAKE ALL INTO KEYS", () => app.bakeToKeys())));
  // Balance (core/balance.js): lean away from every kick, learned from real swing kicks
  function balanceRow() {
    const amount = num(100, () => {}, { min: 0, max: 300, width: 60, title: "100 = as much as real swing kicks lean away (%)" });
    return row(label("balance"), amount, label("%"),
      button("BALANCE", () => app.balanceAdd({ amount: Number(amount.value) / 100 }),
        "Every kick in the clip (a thigh lifted while the other stands) leans the torso and chest away from it, like real swing kicks do (only what it lacks; again = replace)"),
      button("REMOVE", () => app.balanceRemove(), "Take the Balance layer off"));
  }
  // Gait (core/gait.js): a real walk / run's upper body, in time with this clip's steps
  function gaitRow() {
    const kind = select(GT.KINDS.map((k) => [k, GT.KIND_NAMES[k]]), "auto", () => {}, "Walk or run (auto: by the clip's name, else by its stride)");
    const amount = num(100, () => {}, { min: 0, max: 300, width: 60, title: "100 = as much as real walks / runs move (%)" });
    return row(label("gait"), kind, amount, label("%"),
      button("GAIT", () => app.gaitAdd({ kind: kind.value, amount: Number(amount.value) / 100 }),
        "The torso and chest turn with each stride, the head turns back, the arms swing: learned from real walks and runs, in time with this clip's own steps (only what it lacks; again = replace)"),
      button("REMOVE", () => app.gaitRemove(), "Take the Gait layer off"));
  }
  // Alive (core/alive.js): breathing and life learned from real idles, as one layer
  function aliveRow() {
    const mood = select(AL.MOODS.map((m) => [m, AL.MOOD_NAMES[m]]), "calm", () => {}, "Which real idles the life is learned from");
    const amount = num(100, () => {}, { min: 0, max: 300, width: 60, title: "100 = as much as the real idles move (%)" });
    const holds = check("quieter while moving", true, () => {}, "While the clip itself moves (a strike, a step) the life drops to a quarter: breathing goes on under a move");
    const box = h("div");
    box.append(row(label("alive"), mood, amount, label("%")),
      row(holds, button("ALIVE", () => app.aliveAdd({ mood: mood.value, amount: Number(amount.value) / 100, holds: holds.querySelector("input").checked }),
        "Breathing, head nods against the breath, arm sway and slow drift, learned from real motion capture idles, as one layer (again = replace it)"),
      button("REMOVE", () => app.aliveRemove(), "Take the Alive layer off")));
    return box;
  }
  const put = (k, v) => app.setLayer(selId, { [k]: v });
  function edit() {
    ed.innerHTML = "";
    const ly = app.doc.layerById(selId);
    if (!ly) return;
    const nm = h("input", { value: ly.name, onchange: () => put("name", nm.value) });
    const maskNames = Object.keys(R.MASKS);
    const cur = maskNames.find((m) => JSON.stringify(R.MASKS[m]) === JSON.stringify(ly.mask || [])) || "Full body";
    ed.append(h("hr"), nm,
      row(label("mode"), select(["add", "add_delta", "override"], ly.mode || "add", (v) => put("mode", v)), check("mute", ly.mute, (v) => put("mute", v)), check("solo", ly.solo, (v) => put("solo", v))),
      slider("weight", 0, 1, 0.01, Number(ly.weight ?? 1), (v) => put("weight", v)).el,
      row(label("bones"), select(maskNames, cur, (v) => put("mask", R.MASKS[v]))),
      row(label("from"), num(ly.start || 0, (v) => put("start", v | 0)), label("to"), num(ly.end ?? -1, (v) => put("end", v | 0), { title: "-1 = to the end" })),
      row(label("fade in"), num(ly.fade_in || 0, (v) => put("fade_in", v | 0)), label("out"), num(ly.fade_out || 0, (v) => put("fade_out", v | 0))));
    if (ly.source === "clip") {
      const ce = h("input", { value: ly.clip, onchange: () => put("clip", ce.value) });
      ed.append(row(label("clip"), ce), row(label("offset"), num(ly.offset || 0, (v) => put("offset", v | 0)), label("speed"), num(ly.speed ?? 1, (v) => put("speed", v), { step: 0.05 }), check("cycle", ly.cycle !== false, (v) => put("cycle", v))));
    } else ed.append(button(app.activeLayer === selId ? "KEYING THIS LAYER" : "KEYS GO HERE", () => app.setActiveLayer(selId), "Pose and press K: the key lands in this layer", app.activeLayer === selId ? "on" : ""));
    ed.append(row(button("UP", () => app.moveInList(app.doc.layers, selId, -1, "Reorder layers")), button("DOWN", () => app.moveInList(app.doc.layers, selId, 1, "Reorder layers")),
      button("REMOVE", () => { app.removeLayer(selId); selId = ""; })));
  }
  function refresh() {
    l.set(app.doc.layers.map((x) => `${x.id === app.activeLayer ? "> " : ""}${x.name}  [${x.source} ${x.mode} ${Math.round((x.weight ?? 1) * 100)}%]${x.mute ? "  MUTED" : x.solo ? "  SOLO" : ""}`), app.doc.layers.findIndex((x) => x.id === selId));
    edit();
  }
  app.on((w) => { if (["doc", "clip", "layer"].includes(w)) refresh(); });
  return el;
}

// ==================================================================== CONSTRAINTS
export function Constraints(app) {
  const el = body();
  let selId = "";
  const l = list((i) => { selId = app.doc.constraints[i].id; edit(); });
  const ed = h("div");
  const grid = h("div", { class: "grid3" });
  const adds = [["IK ARM L", { type: "ik", limb: "armL" }], ["IK ARM R", { type: "ik", limb: "armR" }], ["IK LEG L", { type: "ik", limb: "legL" }], ["IK LEG R", { type: "ik", limb: "legR" }],
    ["AIM HEAD", { type: "aim", bone: "head", axis: "+z" }], ["FLOOR", { type: "floor", bones: ["footL", "footR"], mode: "floor" }], ["PLANT FEET", { type: "floor", bones: ["footL", "footR"], mode: "plant", name: "PLANT feet" }]];
  for (const [t, def] of adds) grid.append(button(t, () => { selId = app.addConstraint(def).id; refresh(); }));
  grid.append(button("FREEZE SEL", () => { selId = app.pinSelected().id; refresh(); }, "Freeze the selected bone where it is now, from this frame on"));
  grid.append(button("LIMIT SEL", () => { selId = app.addConstraint({ type: "limit", bone: app.selBone, min: [-1, -1, -1], max: [1, 1, 1] }).id; refresh(); }));
  el.append(heading("Constraints"), hint("Rules solved every frame on top of the keys: IK (a hand / foot reaches a target), FREEZE (a bone stays put in the world), AIM (the head follows a point), LIMIT, COPY, FLOOR / PLANT. Purple crosshairs are their targets. Saving bakes them for the game."),
    grid, l.el, ed, row(button("BAKE ALL INTO KEYS", () => app.bakeToKeys())));
  const put = (k, v) => app.setConstraint(selId, { [k]: v });
  const vecRow = (text, v, fn, step = 0.01) => {
    const ins = [0, 1, 2].map((i) => num(Math.round(v[i] * 1000) / 1000, () => fn(ins.map((x) => Number(x.value))), { step, width: 72 }));
    return row(label(text), ...ins);
  };
  const boneSel = (cur, fn) => select(app.bones, cur, fn);
  function edit() {
    ed.innerHTML = "";
    const c = app.doc.constraintById(selId);
    if (!c) return;
    ed.append(h("hr"), h("div", { class: "big", style: "color:#a77bff" }, c.name || c.type), check("on", c.enabled !== false, (v) => put("enabled", v)),
      slider("influence", 0, 1, 0.01, Number(c.influence ?? 1), (v) => put("influence", v)).el,
      row(label("from"), num(c.start || 0, (v) => put("start", v | 0)), label("to"), num(c.end ?? -1, (v) => put("end", v | 0), { title: "-1 = to the end" }), label("blend"), num(c.blend || 0, (v) => put("blend", v | 0), { title: "Frames to fade at the range edges" })));
    if (c.type === "ik" || c.type === "aim") {
      const p = targetPoint(c.target, app.frame, app.stage.body);
      ed.append(vecRow("target m", [p.x, p.y, p.z], (v) => put("target", { pos: v })),
        row(button("TARGET = HERE NOW", () => {
          const end = c.type === "ik" ? R.LIMBS[c.limb][2] : c.bone || "head";
          const w = app.keyedJoint(end);
          if (c.type === "aim") w.z += 1.5;
          put("target", { pos: [w.x, w.y, w.z].map((x) => Math.round(x * 1000) / 1000) });
        }), button("KEY TARGET", () => {
          const tg = structuredClone(c.target || {});
          const f = Math.round(app.frame);
          const q = targetPoint(tg, app.frame, app.stage.body);
          tg.keys = (tg.keys || []).filter((k) => k.f !== f).concat([{ f, pos: [q.x, q.y, q.z].map((x) => Math.round(x * 1000) / 1000) }]).sort((a, b) => a.f - b.f);
          delete tg.pos;
          put("target", tg);
        }, "Key the target here: it moves between its keys")));
      if (c.type === "ik") ed.append(check("hand / foot keeps its angle", c.keep_end !== false, (v) => put("keep_end", v)));
      else ed.append(row(label("bone"), boneSel(c.bone || "head", (v) => put("bone", v)), label("looks along"), select(["+z", "-z", "+x", "-x", "+y", "-y"], c.axis || "+z", (v) => put("axis", v))));
    } else if (c.type === "pin") {
      ed.append(row(label("bone"), boneSel(c.bone, (v) => put("bone", v)), select(["both", "position", "rotation"], c.what || "both", (v) => put("what", v))),
        row(label("frozen as at f"), num(c.pin_frame || 0, (v) => put("pin_frame", v | 0)), button("AT THIS FRAME", () => put("pin_frame", Math.round(app.frame)))));
    } else if (c.type === "limit") {
      ed.append(boneSel(c.bone, (v) => put("bone", v)), vecRow("min deg", v3(c.min).map((x) => x * DEG), (v) => put("min", v.map((x) => x * RAD)), 1), vecRow("max deg", v3(c.max).map((x) => x * DEG), (v) => put("max", v.map((x) => x * RAD)), 1));
    } else if (c.type === "copy_rot") {
      ed.append(row(label("bone"), boneSel(c.bone, (v) => put("bone", v)), label("copies"), boneSel(c.source, (v) => put("source", v))),
        slider("mix", -2, 2, 0.01, Number(c.mix ?? 1), (v) => put("mix", v)).el, check("mirrored", c.mirror, (v) => put("mirror", v)));
    } else if (c.type === "floor") {
      const be = h("input", { value: (c.bones || ["footL", "footR"]).join(","), onchange: () => put("bones", be.value.replace(/ /g, "").split(",")) });
      ed.append(row(select(["floor", "plant"], c.mode || "floor", (v) => put("mode", v)), label("height"), num(c.height || 0, (v) => put("height", v), { step: 0.01 })), row(label("bones"), be));
    }
    ed.append(row(button("UP", () => app.moveInList(app.doc.constraints, selId, -1, "Reorder constraints")), button("DOWN", () => app.moveInList(app.doc.constraints, selId, 1, "Reorder constraints")),
      button("REMOVE", () => { app.removeConstraint(selId); selId = ""; })));
  }
  function refresh() {
    l.set(app.doc.constraints.map((c) => `${c.enabled === false ? "(off) " : ""}${c.name}  ${Math.round((c.influence ?? 1) * 100)}%  f${c.start || 0}-${(c.end ?? -1) < 0 ? "end" : c.end}`), app.doc.constraints.findIndex((c) => c.id === selId));
    edit();
  }
  app.on((w) => { if (["doc", "clip"].includes(w)) refresh(); });
  return el;
}

// ==================================================================== OUTLINER
export function Outliner(app) {
  const el = body();
  const tree = h("div", { class: "tree" });
  const collapsed = { "Hand L": true, "Hand R": true, Ears: true, Extras: true };
  el.append(heading("Outliner"), hint("Bones by body part. Tick LOCK to freeze a bone (no tool can turn it). Click a group to select all of it."), tree);
  function refresh() {
    tree.innerHTML = "";
    const counts = {};
    for (const k of app.doc.keys) for (const b in k.rot || {}) counts[b] = (counts[b] || 0) + 1;
    const adjusted = A.adjustedBones(app.doc);
    const visible = app.visibleBones();
    const groups = app.v5 ? app.v5.grouped(visible) : R.grouped(visible);
    for (const [g, bones] of groups) {
      tree.append(h("div", { class: "tg", onclick: (e) => {
        if (e.offsetX < 18) { collapsed[g] = !collapsed[g]; refresh(); return; }
        const bs = app.v5 ? app.v5.maskGroup(g, visible) : R.maskBones(["@" + g], visible);
        app.selectBone(bs[0]);
        bs.slice(1).forEach((b) => app.selectBone(b, true));
      } }, (collapsed[g] ? "+ " : "- ") + g));
      if (collapsed[g]) continue;
      for (const b of bones) {
        const side = app.boneSide(b);
        const lock = h("input", { type: "checkbox", checked: app.doc.isLocked(b), onclick: (e) => e.stopPropagation(), onchange: () => app.setLock(b, lock.checked ? "xyz" : "") });
        tree.append(h("div", { class: "tb" + (app.selBones.includes(b) ? " sel" : ""), onclick: (e) => app.selectBone(b, e.shiftKey) },
          h("span", { style: `color:${side === "L" ? "#4fd1ff" : side === "R" ? "#ff5d8f" : "#f4efe6"}`, title: adjusted[b] ? "* adjusted (Adjust panel)" : app.boneLabel(b) !== b ? b : "" }, (adjusted[b] ? "* " : "") + app.boneLabel(b)),
          h("span", { class: "tc" }, app.doc.lockChannels(b) && !app.doc.isLocked(b) ? app.doc.lockChannels(b) : ""), lock, h("span", { class: "tc" }, String(counts[b] || 0))));
      }
    }
  }
  app.on((w) => { if (["doc", "fighter", "clip", "sel", "bones"].includes(w)) refresh(); });
  return el;
}

// ==================================================================== POSES
export function Poses(app) {
  const el = body();
  const g = h("div", { class: "grid3" });
  for (const [t, fn] of [["MIRROR L>R", () => app.poseMirror("l2r")], ["MIRROR R>L", () => app.poseMirror("r2l")], ["FLIP", () => app.poseMirror("flip")], ["COPY", () => app.copyPose()],
    ["PASTE", () => app.pastePose(false)], ["PASTE MIRROR", () => app.pastePose(true)], ["RESET SEL", () => app.resetBones(app.selBones)], ["RESET ALL", () => app.resetBones([...app.bones, "hips_move"])], ["KEY  K", () => app.keyNow()]]) g.append(button(t, fn));
  const l = list(null, () => apply(false, false));
  l.el.style.minHeight = "160px";
  const w = slider("weight", 0, 1, 0.01, 1, () => {});
  w.set(1);
  el.append(heading("Pose tools"), g, heading("Breakdown"), hint("Between the key before and the key after: slide toward either, then key it."),
    slider("lean", 0, 1, 0.01, 0.5, (v) => app.breakdown(v), { title: "0 = the previous key, 1 = the next key" }).el,
    heading("Pose library"), hint("Poses you keep (data/poses, shared with the Godot Animator). Whole body or selected bones, mirrored, blended by weight."), l.el, w.el,
    row(button("APPLY", () => apply(false, false)), button("ON SELECTED", () => apply(true, false)), button("MIRRORED", () => apply(false, true))),
    row(button("SAVE POSE", () => prompt(app, "Pose name:", `pose_${app.doc.name}_f${Math.round(app.frame)}`, (n) => app.saveLibraryPose(n))),
      button("SAVE SELECTED", () => prompt(app, "Partial pose (selected bones):", `part_${app.selBone}`, (n) => app.saveLibraryPose(n, true)))));
  function apply(sel, mir) {
    if (!l.text()) return app.say("Pick a pose in the list.", "warn");
    app.applyLibraryPose(l.text(), sel, Number(w.r.value), mir);
  }
  async function refresh() { l.set(await app.listPoses()); }
  app.on((w2) => { if (w2 === "poses") refresh(); });
  refresh();
  return el;
}

// ==================================================================== SOCKETS + PROPS
export function Sockets(app) {
  const el = body();
  const l = list((i, t) => { app.selSocket = t.split("   ")[0]; app.views.dirty(); edit(); });
  const ed = h("div");
  const pl = list((i) => { propSel = app.doc.props[i].id; editProp(); });
  const ped = h("div");
  let propSel = "";
  const shape = select(PROP_SHAPES, "bat", () => {});
  el.append(heading("Sockets"), hint("Named points on bones (effects, props, hit points). Shared by every fighter unless saved for this one."),
    check("show sockets in the views", app.show.sockets, (v) => { app.show.sockets = v; app.views.dirty(); }), l.el, ed,
    row(button("+ SOCKET", () => prompt(app, "Socket name:", "my_socket", (n) => { app.sockSpecs[n] = { bone: app.selBone, offset: [0, 0, 0] }; app.selSocket = n; refresh(); })),
      button("SAVE ALL", () => app.saveSockets(false)), button("SAVE THIS FIGHTER", () => app.saveSockets(true))),
    heading("Props on sockets"), hint("Stand-in objects held at a socket so you can animate with them. Saved in the clip, never in the game."), pl.el,
    row(shape, button("+ PROP AT SOCKET", () => app.mutate("Add prop", () => app.doc.props.push({ id: newId(app.doc.props, "prop"), name: shape.value, shape: shape.value, socket: app.selSocket || "fist_R", offset: [0, 0, 0], rot: [0, 0, 0], scale: 1, color: "#c8c0d0" })))), ped);
  function edit() {
    ed.innerHTML = "";
    const sp = app.sockSpecs[app.selSocket];
    if (!sp) return;
    const off = v3(sp.offset);
    const ins = [0, 1, 2].map((i) => num(off[i], () => { sp.offset = ins.map((x) => Number(x.value)); app.views.dirty(); }, { step: 0.005, width: 72 }));
    ed.append(row(label("bone"), select(app.bones, sp.bone, (v) => { sp.bone = v; app.views.dirty(); })), row(label("offset"), ...ins), check("on the ground under the bone", sp.ground, (v) => { sp.ground = v; app.views.dirty(); }));
  }
  const setProp = (k, v) => app.mutate("Prop " + k, () => { const p = app.doc.props.find((x) => x.id === propSel); if (p) p[k] = v; });
  function editProp() {
    ped.innerHTML = "";
    const p = app.doc.props.find((x) => x.id === propSel);
    if (!p) return;
    const socks = Object.keys(app.sockSpecs).sort();
    const vec = (fld, step) => { const v = v3(p[fld]); const ins = [0, 1, 2].map((i) => num(v[i], () => setProp(fld, ins.map((x) => Number(x.value))), { step, width: 66 })); return row(label(fld), ...ins); };
    ped.append(row(label("socket"), select(socks, p.socket, (v) => setProp("socket", v))), vec("offset", 0.005), vec("rot", 1), slider("scale", 0.1, 4, 0.05, p.scale ?? 1, (v) => setProp("scale", v)).el,
      row(h("input", { type: "color", value: p.color || "#c8c0d0", onchange: (e) => setProp("color", e.target.value) }), button("REMOVE PROP", () => app.mutate("Remove prop", () => app.doc.removeById(app.doc.props, propSel)))));
  }
  function refresh() {
    const names = Object.keys(app.sockSpecs).sort();
    l.set(names.map((n) => `${n}   (${app.sockSpecs[n].bone})`), names.indexOf(app.selSocket));
    edit();
    pl.set(app.doc.props.map((p) => `${p.name} on ${p.socket}`), app.doc.props.findIndex((p) => p.id === propSel));
    editProp();
  }
  app.on((w) => { if (["fighter", "clip", "doc"].includes(w)) refresh(); });
  return el;
}

// ==================================================================== BLEND LAB
export function Blend(app) {
  const el = body();
  const clipB = h("input", { placeholder: "clip B (type to search)", oninput: () => search() });
  const found = list((i, t) => (clipB.value = t));
  found.el.style.minHeight = "90px";
  const at = num(12, () => {}, { min: 0 });
  const span = num(6, () => {}, { min: 0 });
  const name = h("input", { placeholder: "new clip name" });
  const maskSel = select(Object.keys(R.MASKS), "Upper body", () => {});
  const w = slider("mix weight", 0, 1, 0.01, 1, () => {});
  w.set(1);
  el.append(heading("Blend Lab"), hint("TRANSITION: this clip, then B takes over at a frame, crossfading over N frames (try it as a layer, or make a new clip). MIX: B on top on some bones only, or B's motion added on top."),
    clipB, found.el, row(label("B starts at f"), at, label("crossfade frames"), span, button("AT CURRENT FRAME", () => (at.value = Math.round(app.frame)))),
    row(button("TRY AS LAYER", async () => { if (await ok()) { await app.addLayer({ name: "to " + clipB.value, mode: "override", source: "clip", clip: clipB.value.trim(), offset: Number(at.value), cycle: false, start: Number(at.value), fade_in: Number(span.value) }); app.ui.showPanel("Layers"); } }),
      name, button("MAKE TRANSITION CLIP", async () => { if (await ok()) app.makeTransitionClip(clipB.value.trim(), Number(at.value), Number(span.value), name.value.trim() || `${app.doc.name}_to_${clipB.value.trim()}`); })),
    h("hr"), w.el, row(label("bones"), maskSel, button("MIX B ON THESE BONES", () => mix("override")), button("ADD B'S MOTION", () => mix("add_delta"), "Adds B's movement from its first frame on top")));
  async function ok() { if (!(await window.host.loadClip(clipB.value.trim()))) { app.say("Pick clip B first.", "warn"); return false; } return true; }
  async function mix(mode) { if (await ok()) { await app.addLayer({ name: `${clipB.value} ${mode}`, mode, source: "clip", clip: clipB.value.trim(), weight: Number(w.r.value), mask: R.MASKS[maskSel.value] }); app.ui.showPanel("Layers"); } }
  let all = [];
  async function search() {
    if (!all.length) all = await window.host.listClips();
    const q = clipB.value.trim();
    found.set(all.filter((c) => !q || c.includes(q)).slice(0, 60));
  }
  search();
  return el;
}

// ==================================================================== ADJUST
// press and drag left / right to turn (Shift for fine steps); one drag is one undo step
function tiltDrag(onDelta, onEnd) {
  const b = h("button", { class: "tilt", title: "Press and drag left / right to turn (hold Shift for fine steps)" }, "< TILT >");
  b.style.cursor = "ew-resize";
  b.onpointerdown = (e) => { b.setPointerCapture(e.pointerId); b._down = true; };
  b.onpointermove = (e) => { if (b._down && e.movementX) onDelta(e.movementX * (e.shiftKey ? 0.05 : 0.25)); };
  b.onpointerup = b.onpointercancel = () => { if (b._down) { b._down = false; onEnd(); } };
  return b;
}

export function Adjust(app) {
  const el = body();
  let quiet = false;
  const part = select([], "", (v) => { if (!quiet) app.selectBone(v); });
  const both = check("both sides", false, () => {}, "The other side gets the same turn, mirrored");
  const axisHint = hint("");
  const rangeRow = row();
  const scopeSel = select([["all", "all frames"], ["frame", "around this frame"], ["range", "frame range"]], "all", () => { rangeRow.style.display = scopeSel.value === "range" ? "" : "none"; load(); });
  const easeIn = num(6, () => load(), { min: 0, max: 60, title: "Frames it eases in and out over (0 = sharp)" });
  const fromIn = num(0, () => load(), { min: 0 }), toIn = num(30, () => load(), { min: 0 });
  rangeRow.append(label("from f"), fromIn, label("to f"), toIn, button("PLAY RANGE", () => { const [a, b] = app.playRangeFrames(); fromIn.value = a; toIn.value = b; load(); }, "Use the IN / OUT play range"));
  rangeRow.style.display = "none";
  const deg = [], drag = [0, 0, 0];
  const listBox = h("div");
  el.append(heading("Adjust"), hint("Tilt a body part across the whole clip, a frame range, or around this frame, without touching its keys: the shoulders up on every frame of a walk, an arm straighter, the hands meeting for a clap. Pick the part (or click it in a view), the scope, then drag TILT on an axis. Adjusted parts get a * in the Outliner; RESTORE takes an adjustment off."),
    row(label("part"), part, both), axisHint, row(label("on"), scopeSel, label("ease"), easeIn), rangeRow);
  for (let i = 0; i < 3; i++) {
    const n = num(0, () => { if (!quiet) apply(); }, { min: -180, max: 180, step: 0.5, width: 84, title: "Degrees, the total turn of this adjustment" });
    deg.push(n);
    // a drag edits the box live and lands as one undo step when you let go
    const t = tiltDrag((d) => { drag[i] += d; n.value = Math.round((Number(n.value) + d) * 10) / 10; preview(); }, () => { drag[i] = 0; apply(); });
    el.append(row(h("span", { class: "lbl", style: `color:${AX[i]};font-size:16px` }, "XYZ"[i]), t, n, label("deg"), button("0", () => { n.value = 0; apply(); }, "No turn on this axis")));
  }
  el.append(h("hr"), heading("Adjusted"), listBox,
    row(button("RESTORE ALL", () => app.adjustRestore(), "Every adjustment off: the keys as they were"),
      button("APPLY INTO KEYS", () => app.bakeToKeys(), "Bake layers (adjustments too) and constraints into plain keys (undo brings them back)")));
  const turn = () => deg.map((n) => Number(n.value) * RAD);
  const args = () => [scopeSel.value, -1, Number(fromIn.value), Number(toIn.value), Number(easeIn.value)];
  const mirror = () => both.querySelector("input").checked && !!R.sideOf(app.selBone);
  // while dragging: show it on the model without an undo step per pixel
  let dragBase = null;
  function preview() {
    if (!dragBase) dragBase = app.doc.toDict();
    app.doc.loadDict(dragBase);
    const [scope, at, from, to, ease] = args();
    const f = Math.round(app.frame);
    const sp = A.span(scope, f, from, to < 0 ? app.doc.frames : to, ease);
    const targets = [[app.selBone, turn()]];
    if (mirror()) targets.push([R.mirrorName(app.selBone), R.mirrorEuler(turn())]);
    for (const [b, v] of targets) {
      const l = A.find(app.doc, b, scope, sp);
      if (l) Object.assign(l, A.layerDef(b, scope, sp, v));
      else app.doc.addLayer(A.layerDef(b, scope, sp, v));
    }
    app.applyNow();
  }
  function apply() {
    if (dragBase) { app.doc.loadDict(dragBase); dragBase = null; }
    app.adjustPart(app.selBone, turn(), ...args(), mirror());
  }
  function fill() {
    quiet = true;
    part.innerHTML = "";
    for (const [, bones] of R.grouped(app.bones)) for (const b of bones) part.add(new Option(b));
    quiet = false;
  }
  function showBone() {
    quiet = true;
    part.value = app.selBone;
    both.querySelector("input").disabled = !R.sideOf(app.selBone);
    axisHint.textContent = R.hint(app.selBone);
    quiet = false;
  }
  function load() {
    if (dragBase) return;
    const v = app.adjustValue(app.selBone, ...args());
    quiet = true;
    deg.forEach((n, i) => (n.value = Math.round(v[i] * DEG * 10) / 10));
    quiet = false;
  }
  function list() {
    listBox.innerHTML = "";
    const ls = A.adjustLayers(app.doc);
    if (!ls.length) return listBox.append(hint("Nothing adjusted."));
    for (const l of ls) listBox.append(row(h("span", { class: "txt", style: "flex:1" }, "* " + A.describe(l)), button("PICK", () => app.selectBone(l.bone), "Select this part"),
      button("RESTORE", () => app.adjustRestore(l.id), "Take this adjustment off")));
  }
  app.on((w) => {
    if (w === "fighter") fill();
    if (["doc", "clip", "fighter"].includes(w)) list();
    if (["sel", "clip", "fighter", "doc"].includes(w) || (w === "frame" && scopeSel.value === "frame")) { showBone(); load(); }
  });
  fill(); list(); showBone(); load();
  return el;
}

// ==================================================================== FILL
// Fill (core/fill.js): the frames between two keys made for you. Once a span is filled the knobs change it live.
export function Fill(app) {
  const el = body();
  let quiet = false, span = [], matches = [], busy = false, again = false;
  const spanLbl = h("div", { class: "txt", style: "color:var(--gold);margin:4px 0" });
  const useRange = check("play range", false, () => refresh(), "Fill the IN / OUT play range instead of the keys around this frame");
  const rangeOn = () => useRange.querySelector("input").checked;
  const engineSel = select([["shape", "SHAPE (the rules)"], ["library", "LIBRARY (your clips)"]], "shape", () => {
    showEngine();
    if (engineSel.value === "library" && !matches.length) search().then(live);
    else live();
  }, "SHAPE: made by the rules of good motion. LIBRARY: taken from the clip that makes the same change, bent onto your keys");
  const learnedLbl = h("div", { class: "hint" });
  const learnedNote = () => {
    const sty = FL.learned(timingSel.value);
    learnedLbl.style.display = sty.note ? "" : "none";
    learnedLbl.textContent = sty.note ? `Learned from real motion: ${sty.note}.` : "";
  };
  const timingSel = select(FL.TIMINGS.map((t) => [t, FL.TIMING_NAMES[t]]), "smooth", () => {
    if (FL.LEARNED.includes(timingSel.value) && !quiet) knobs.overlap.set(0);   // real joints barely trail: the learned lag is the trail
    learnedNote();
    live();
  }, "How the move spends its time between the two keys. The (learned) ones come from real motion capture: their speed, which body part leads, and how a move arrives");
  const knobs = {};
  const shapeBox = h("div"), libBox = h("div");
  shapeBox.append(row(label("timing"), timingSel), learnedLbl);
  for (const [k, name, tip] of [["flow", "Flow", "Carries the speed the motion has coming into the first key and going out of the last"],
    ["overlap", "Overlap", "Each joint trails the one it hangs from and catches up by the end: the hand after the arm, the tail after the hips"],
    ["anticipate", "Anticipate", "A small wind-up the other way before the move"],
    ["overshoot", "Overshoot", "Goes a little past the last pose and settles onto it"]]) {
    knobs[k] = slider(name, 0, 100, 1, FL.DEFAULTS[k] * 100, () => live(), { title: tip });
    shapeBox.append(knobs[k].el);
  }
  const foundLbl = h("span", { class: "hint", style: "flex:1" });
  const found = list(() => live(), () => doFill());
  found.el.style.minHeight = "110px";
  libBox.append(row(button("SEARCH", () => search(), "Look through every clip (mirrored too) for the stretch that best joins these two keys"), foundLbl), found.el);
  const feetChk = check("hold planted feet", true, () => live(), "In a planted clip a foot standing at both keys stays where it stands; one that moved steps on an arc");
  const feetOn = () => feetChk.querySelector("input").checked;
  const airIn = num(0, () => live(), { min: 0, max: 200, title: "The hips go up on a jump arc this high in the middle (0 = off)" });
  const stepIn = num(0, () => live(), { min: 0, max: 12, width: 56, title: "A key every N frames (0: every 2 at 60 fps, every frame at 30)" });
  const listBox = h("div");
  el.append(heading("Fill"), hint("The frames between two keys, made for you. Put the playhead between two keys (or tick play range) and press FILL. SHAPE makes the move by the rules of good motion: it carries the speed through the keys (Flow), the hand trails the arm (Overlap), winds up first (Anticipate), goes past and settles (Overshoot). LIBRARY finds how your own clips make the same change and bends it onto your two keys. Every joint stays inside its natural range and planted feet stay put. The made keys are plain breakdown keys you can still edit; once filled, the knobs change it live."),
    spanLbl, row(label("engine"), engineSel, useRange), shapeBox, libBox,
    row(feetChk, label("air"), airIn, label("cm")), row(label("key every"), stepIn, label("frames")),
    row(button("FILL", () => doFill(), "Make the frames between the two keys"),
      button("REMOVE", () => { const fl = here(); if (fl) app.fillRemove(fl.id); }, "Take this span's fill out: the keys around it are as they were")),
    h("hr"), heading("Filled"), listBox);

  const showEngine = () => { shapeBox.style.display = engineSel.value === "shape" ? "" : "none"; libBox.style.display = engineSel.value === "library" ? "" : "none"; learnedNote(); };
  const currentSpan = () => {
    if (!rangeOn()) return app.fillSpan();
    const [a, b] = app.playRangeFrames();
    return app.fillSpan({ from: a, to: b });
  };
  const here = () => (span.length ? FL.atSpan(app.doc, span[0], span[1]) : null);
  function opts() {
    const o = { engine: engineSel.value, timing: timingSel.value, feet: feetOn(), air: Number(airIn.value), step: Number(stepIn.value), pick: Math.max(0, found.selected()) };
    for (const k in knobs) o[k] = Number(knobs[k].r.value) / 100;
    if (span.length) { o.from = span[0]; o.to = span[1]; }
    return o;
  }
  // the span under the playhead; when it changes, the controls show that span's fill (if it has one)
  function refresh() {
    const sp = currentSpan();
    const changed = sp.join() !== span.join();
    span = sp;
    if (!sp.length) { spanLbl.textContent = "Put the playhead between two keys (2 frames apart or more), or tick play range."; return; }
    const fl = here();
    spanLbl.textContent = `f${sp[0]} -> f${sp[1]}  (${sp[1] - sp[0]} frames)   ${fl ? "filled: " + FL.describe(fl) : "not filled"}`;
    if (changed) {
      matches = [];
      found.set([]);
      foundLbl.textContent = "SEARCH to see which clips make this change.";
      if (fl) load(fl.settings);
    }
  }
  function load(s) {
    quiet = true;
    engineSel.value = s.engine || "shape";
    timingSel.value = s.timing || "smooth";
    for (const k in knobs) knobs[k].set(Number(s[k] ?? FL.DEFAULTS[k]) * 100);
    feetChk.querySelector("input").checked = s.feet !== false;
    airIn.value = Number(s.air || 0);
    stepIn.value = Number(s.step || 0);
    showEngine();
    quiet = false;
  }
  // a knob moved: a span that is already filled is filled again with it (one fill at a time; the last change wins)
  function live() {
    if (quiet || !here()) return;
    doFill();
  }
  async function doFill() {
    if (!span.length) { app.say("Put the playhead between two keys first.", "warn"); return; }
    if (busy) { again = true; return; }
    busy = true;
    try {
      if (engineSel.value === "library" && !matches.length) { await search(); if (!matches.length) return; }
      await app.fillApply(opts());
    } finally {
      busy = false;
    }
    refresh();
    if (again) { again = false; doFill(); }
  }
  async function search() {
    if (!span.length) return;
    foundLbl.textContent = "Searching your clips...";
    matches = await app.fillMatches({ from: span[0], to: span[1], n: 8 });
    found.set(matches.map((m) => `${String(m.score).padStart(3)}%  ${m.clip}  f${Math.round(m.from)}-f${Math.round(m.to)}${m.mirror ? "  mirrored" : ""}   took ${m.frames} frames`), matches.length ? 0 : -1);
    if (!matches.length) { foundLbl.textContent = "No clip makes this change."; return; }
    const took = matches[0].frames, have = span[1] - span[0];
    foundLbl.textContent = matches[0].score < 50 ? `Weak: no clip makes quite this change (best ${matches[0].score}%). SHAPE may suit it better.`
      : Math.abs(took - have) > 0.25 * have ? `Best: ${matches[0].clip}. It took ${took} frames there; this span has ${have}.` : `Best: ${matches[0].clip}.`;
  }
  function fillList() {
    listBox.innerHTML = "";
    if (!app.doc.fills.length) return listBox.append(hint("Nothing filled."));
    for (const fl of app.doc.fills) listBox.append(row(h("span", { class: "txt", style: "flex:1" }, FL.describe(fl)),
      button("GO", () => app.setFrame((fl.a + fl.b) / 2), "Put the playhead in this fill"),
      button("REMOVE", () => app.fillRemove(fl.id), "Take this fill out")));
  }
  app.on((w) => {
    if (["doc", "clip", "fighter"].includes(w)) { fillList(); refresh(); }
    else if (w === "frame" && !rangeOn()) refresh();
  });
  showEngine(); fillList(); refresh();
  return el;
}

// ==================================================================== FEET
const FEET_COLORS = { flat: "#5cc773", pivot: "#f2ad40", loose: "#ff6a1a", limit: "#b88cf2", sink: "#eb4d4d", air: "#40454f" };
const FEET_SAY = { flat: "standing flat on the floor", pivot: "on its toes / heel (pivot)", loose: "LOOSE: tipped just off the floor, not planted",
  limit: "standing, heel up: the ankle is at its natural bend",
  sink: "INTO the floor", air: "off the floor" };

export function Feet(app) {
  const el = body();
  let report = {};
  let dirty = true;
  const planted = check("planted (ground the feet, as the match does)", false, (on) => app.setClipProp("plant", on), "Clips on the ground: on. Clips in the air (jumps, aerials, falls): off");
  // the feet across the clip: one lane per foot, a cell per frame coloured by how it stands; click one to go to that frame
  const lanes = h("canvas", { class: "feetlanes", height: 58, style: "width:100%;height:58px;cursor:pointer;display:block" });
  const now = h("div", { class: "txt" }), counts = hint(""), soles = hint("");
  // the lanes and this frame first: the dock is short on a laptop screen, the explanation goes last
  el.append(row(heading("Feet"), planted, button("REFRESH", () => { dirty = true; tick(); }, "Measure the feet again")), lanes, now, counts, soles,
    hint("Lanes: green flat on the floor, amber pivot (toes / heel), violet heel up at the ankle's limit, red INTO the floor, grey off it; click one to go to that frame. A planted clip stands each foot on its real sole (read from the model, which is not always level at rest), levels every standing foot and reaches the legs down with the knee's own bend; a foot the clip keys onto its toes or heel pivots there."));
  const LABEL_W = 22;
  function draw() {
    const fr = report.frames || [];
    const w = lanes.clientWidth || 240;
    lanes.width = w;
    const g = lanes.getContext("2d");
    g.fillStyle = "#1a1c21";
    g.fillRect(0, 0, w, 58);
    if (!fr.length) return;
    const cw = (w - LABEL_W) / fr.length, rh = (58 - 6) / 2;
    ["footL", "footR"].forEach((b, li) => {
      g.fillStyle = "#8a8496";
      g.font = "12px sans-serif";
      g.fillText("LR"[li], 4, 3 + rh * li + rh * 0.7);
      fr.forEach((r, i) => { g.fillStyle = FEET_COLORS[(r[b] || {}).state || "air"] || "#888"; g.fillRect(LABEL_W + i * cw, 3 + rh * li + 1, Math.max(1, cw - 0.5), rh - 2); });
    });
    const last = fr[fr.length - 1].f;
    const x = LABEL_W + (app.frame / Math.max(1, last)) * (w - LABEL_W - cw) + cw * 0.5;
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 58); g.stroke();
  }
  const pick = (e) => {
    const fr = report.frames || [];
    if (!fr.length) return;
    const i = Math.max(0, Math.min(fr.length - 1, Math.floor((e.offsetX - LABEL_W) / ((lanes.clientWidth - LABEL_W) / fr.length))));
    app.setFrame(fr[i].f);
  };
  lanes.onpointerdown = (e) => { lanes.setPointerCapture(e.pointerId); pick(e); };
  lanes.onpointermove = (e) => { if (e.buttons & 1) pick(e); };
  function showNow() {
    const fr = report.frames || [];
    if (!fr.length) { now.textContent = ""; return; }
    const r = fr[Math.max(0, Math.min(fr.length - 1, Math.round(app.frame)))];
    now.textContent = `f${r.f}  ` + ["footL", "footR"].map((b) => { const d = r[b] || {}; return `${b}  ${FEET_SAY[d.state] || ""}  (${d.low_cm >= 0 ? "+" : ""}${Number(d.low_cm || 0).toFixed(1)} cm, ${Math.round(d.tilt || 0)} deg)`; }).join("   |   ");
  }
  function tick() {
    if (!dirty || !el.isConnected || !el.offsetParent || !app.stage || !app.stage.probe) return;
    dirty = false;
    report = app.feetReport(1);
    planted.querySelector("input").checked = app.doc.plant;
    soles.textContent = "This model: " + Object.entries(report.soles || {}).map(([b, s]) => `${b} sole ${Math.round(s.tilt0)} deg off level at rest, ankle ${s.ankle_cm.toFixed(1)} cm over it`).join("; ");
    counts.textContent = "Foot-frames: " + ["flat", "pivot", "loose", "limit", "sink", "air"].filter((k) => report.counts[k]).map((k) => `${k} ${report.counts[k]}`).join(", ");
    showNow();
    draw();
  }
  app.on((w) => {
    if (["doc", "clip", "fighter", "saved", "layer"].includes(w)) dirty = true;
    if (w === "frame" || w === "play") { showNow(); draw(); }
  });
  // measured only while the panel shows (the whole clip is posed once per change)
  setInterval(tick, 250);
  return el;
}

// ==================================================================== MERGE
export function Merge(app) {
  const el = body();
  const find = h("input", { placeholder: "clip to put on top (type to search)", oninput: () => search(), style: "flex:1" });
  const found = list((i, t) => (find.value = t), (i, t) => add(t));
  found.el.style.minHeight = "84px";
  const baseLbl = h("div", { class: "big", style: "color:#ffc93c" });
  const rows = h("div");
  const lenLbl = hint("");
  const name = h("input", { placeholder: "name of the merged clip", style: "width:220px" });
  const rebuild = button("REBUILD THE SETUP", async () => {
    if (app.history.dirty() && !(await window.host.confirm(`Rebuild the merge behind ${app.doc.name}? Changes to it are lost.`))) return;
    app.mergeRebuild();
  }, "This clip was merged: open its base with the clips on top again");
  el.append(heading("Merge"), hint("One animation from several. The open clip is the BASE: it gives the body. Each clip ON TOP gives only the parts you light up (the arms of a cheer over a run, a clap over a walk), from its start frame, blending in and out. Play to see it. BAKE makes one new clip; the base stays as it is."),
    baseLbl, row(find, button("PUT ON TOP", () => add(found.text() || find.value.trim()), "From the current frame, the arms and hands first; light up other parts on its row")), found.el,
    h("hr"), rows, h("hr"), lenLbl,
    row(name, button("BAKE INTO ONE CLIP", () => app.mergeBake(name.value.trim() || app.doc.name + "_merged"), "One new clip with everything above in it (opens unsaved; the base is not touched)"), rebuild));
  let all = [];
  async function search() {
    if (!all.length) all = await window.host.listClips();
    const q = find.value.trim();
    found.set(all.filter((c) => !q || c.includes(q)).slice(0, 80));
  }
  function add(clip) {
    if (!clip) return app.say("Pick a clip to put on top.", "warn");
    app.mergeAdd(clip);
  }
  let ids = "";
  function refresh() {
    const ml = M.mergeLayers(app.doc);
    baseLbl.textContent = `Base: ${app.doc.name}  (${app.doc.frames} frames${app.doc.loop ? ", loops: repeats under longer clips" : ""})`;
    lenLbl.textContent = ml.length ? `The merged clip runs ${M.length(app.doc)} frames.` : "Nothing on top yet.";
    rebuild.style.display = app.doc.extra.merge ? "" : "none";
    if (!name.value || name.value.endsWith("_merged")) name.value = app.doc.name + "_merged";
    const now = ml.map((l) => l.id).join(",");
    if (now === ids) return;   // same rows: the widgets already show the values (no rebuild while you type)
    ids = now;
    rows.innerHTML = "";
    for (const l of ml) rows.append(mergeRow(l));
  }
  function mergeRow(l) {
    const id = l.id;
    const set = (p) => app.mergeSet(id, p);
    const chips = M.PARTS.map((p) => {
      const on = (l.parts || []).includes(p);
      const c = button(p.toUpperCase(), () => {
        const cur = [...(app.doc.layerById(id)?.parts || [])];
        const lit = !c.classList.contains("on");
        c.classList.toggle("on", lit);
        set({ parts: lit ? [...cur.filter((x) => x !== p), p] : cur.filter((x) => x !== p) });
      }, "This part comes from this clip", on ? "on" : "");
      return c;
    });
    return h("div", { class: "mrow" }, row(h("span", { class: "big" }, l.clip), ...chips),
      row(label("start f"), num(l.start || 0, (v) => set({ start: v | 0 }), { min: 0 }), button("NOW", () => set({ start: Math.round(app.frame) }), "Start at the current frame"),
        label("blend in"), num(l.fade_in || 0, (v) => set({ blend_in: v | 0 }), { min: 0, max: 240 }), label("out"), num(l.fade_out || 0, (v) => set({ blend_out: v | 0 }), { min: 0, max: 240 }),
        label("weight"), num(l.weight ?? 1, (v) => set({ weight: v }), { min: 0, max: 1, step: 0.05 }),
        check("loop it", !!l.cycle, (v) => set({ cycle: v }), "Repeat this clip to the end"), check("mute", !!l.mute, (v) => set({ mute: v })),
        button("REMOVE", () => app.removeLayer(id))), h("hr"));
  }
  app.on((w) => { if (["doc", "clip", "layer"].includes(w)) refresh(); if (w === "clips" || w === "saved") { all = []; search(); } });
  search();
  refresh();
  return el;
}

// ==================================================================== AGENTS
export function Agents(app) {
  const el = h("div", { class: "pbody split" });
  const head = h("div", { class: "big", style: "color:#a77bff" });
  const log = list();
  log.el.style.flex = "1";
  const left = h("div", { class: "col", style: "flex:1.6" }, head, log.el);
  const right = h("div", { class: "col", style: "flex:1" }, heading("Connect an agent"),
    hint("Agents animate here through MCP: they read the rig, pose, key, blend, add constraints, render pictures to check their work, and save. Their edits show live (purple frame), are in History and undo like yours."),
    h("textarea", { readOnly: true, rows: 7, value: mcpConfig() }),
    row(button("COPY MCP CONFIG", () => { navigator.clipboard.writeText(mcpConfig()); app.say("MCP config copied.", "ok"); }), button("CLEAR LOG", () => { app.apiLog = []; refresh(); })));
  el.append(left, right);
  function refresh() {
    head.textContent = `AGENT API on http://127.0.0.1:${app.info?.apiPort || 47680}/rpc  -  ${app.apiLog.length} calls`;
    const items = app.apiLog.slice(-300).reverse();
    log.set(items.map((e) => `${e.time}  ${e.method}  ${e.summary}`), -1, items.map((e) => (e.ok ? "" : "#ff4d4d")));
  }
  app.on((w) => { if (w === "api") refresh(); });
  refresh();
  return el;
}

// ==================================================================== HISTORY
export function HistoryPanel(app) {
  const el = body();
  const l = list(null, (i) => { for (let n = 0; n <= i; n++) app.undo(); });
  l.el.style.flex = "1";
  el.append(row(heading("History"), button("UNDO", () => app.undo()), button("REDO", () => app.redo()), hint("newest first; [agent] = an agent's. Double-click undoes back to that step.")), l.el);
  const refresh = () => { const ls = app.history.labels(200); l.set(ls, -1, ls.map((t) => (t.startsWith("[agent]") ? "#a77bff" : ""))); };
  app.on((w) => { if (["doc", "clip", "saved"].includes(w)) refresh(); });
  return el;
}

// ==================================================================== CHECKS
export function Checks(app) {
  const el = body();
  let res = [];
  const l = list((i) => { if (res[i].f >= 0) app.setFrame(res[i].f); });
  l.el.style.flex = "1";
  el.append(row(heading("Checks"), button("RUN", () => run(), "Knees never bend forward, joint limits, the loop seam, planted feet sliding, unkeyed edits, and the Collision Wrap: parts in the body as keyed and after the match's Body Solve, flagged when the solve turns a joint more than 45°")), l.el);
  function run() {
    res = app.runChecks();
    l.set(res.map((r) => r.text), -1, res.map((r) => ({ error: "#ff4d4d", warn: "#ff7a1a", ok: "#5ce08a" }[r.level])));
  }
  app.on((w) => { if (["saved", "clip"].includes(w)) run(); });
  return el;
}

// ==================================================================== RENDER
export function Render(app) {
  const el = body();
  const SIZES = [["HD 1280 x 720", 1280, 720], ["Full HD 1920 x 1080", 1920, 1080], ["QHD 2560 x 1440", 2560, 1440], ["4K 3840 x 2160", 3840, 2160], ["Square 1080", 1080, 1080], ["Vertical 1080 x 1920", 1080, 1920]];
  const res = select(SIZES.map((s, i) => [String(i), s[0]]), "1", () => {});
  const cols = num(8, () => {}, { min: 2, max: 24 });
  const a = num(0, () => {}, { min: 0 }), b = num(app.doc.frames, () => {}, { min: 0 });
  const last = hint("");
  const wh = () => SIZES[Number(res.value)];
  el.append(heading("Render"), hint(`Pictures of your animation at HD or 4K, saved to ${app.info.dirs.renders}. Stills use the view you clicked last.`), res,
    row(button("STILL OF THE VIEW", async () => (last.textContent = await app.ui.picture("view", wh()[1], wh()[2]))), label("sheet columns"), cols,
      button("REVIEW SHEET (4 ANGLES)", async () => (last.textContent = await app.ui.picture("sheet", wh()[1], wh()[2], Number(cols.value))))),
    row(label("frames"), a, label("to"), b, button("PNG SEQUENCE", async () => {
      const was = app.frame;
      const dir = `${app.info.dirs.renders}/${app.fighter}_${app.doc.name}_seq_${wh()[1]}x${wh()[2]}`;
      for (let f = Number(a.value); f <= Number(b.value); f++) {
        app.frame = f; app.pending = null; app.applyNow();
        await app.ui.picture("view", wh()[1], wh()[2], 8, `${dir}/f${String(f).padStart(4, "0")}.png`);
      }
      app.frame = was; app.applyNow();
      last.textContent = dir;
      app.say("Rendered frames to " + dir, "ok");
    })), row(button("OPEN THE FOLDER", () => window.host.openPath(app.info.dirs.renders))), last);
  app.on((w) => { if (w === "clip") b.value = app.doc.frames; });
  return el;
}

export { renderPicture, poseOfKey };


// ==================================================================== EFFECTS
// RMT effect blocks fired at a socket at a frame of the clip: the clip's cues (data/clip_fx.json), playing in the views as the
// clip plays (fx.js). Blocks are made in the RMT Effect Studio (Godot): OPEN IN EFFECT STUDIO goes there on this fighter,
// clip and frame.
export function Effects(app) {
  const el = body();
  let sel = -1, quiet = false, ids = [];
  const filter = h("input", { type: "text", placeholder: "search blocks (id or tag)", style: "width:100%" });
  const blocks = list(() => {}, () => add());
  blocks.el.style.minHeight = "120px";
  const socketSel = select(["origin"], "origin", () => edit(), "Where it fires: a socket on the body, or origin = the floor at the feet");
  const modeSel = select(["burst", "follow"], "burst", () => edit(), "burst: fires where the socket is at its frame and stays there. follow: rides the socket for dur seconds");
  const durIn = num(0.5, () => edit(), { min: 0.05, max: 10, step: 0.05, width: 64, title: "How long a follow rides its socket (s)" });
  const sizeIn = num(1, () => edit(), { min: 0.05, max: 10, step: 0.05, width: 64, title: "The block's size (1 = as made)" });
  const offIn = [0, 1, 2].map((i) => num(0, () => edit(), { step: 0.01, width: 60, title: ["ahead", "up", "toward the camera"][i] + " (m, at match size); a follow: the bone's own axes" }));
  const rotIn = [0, 1, 2].map((i) => num(0, () => edit(), { step: 1, width: 60, title: ["about X", "about Y", "about Z"][i] + " (degrees)" }));
  const cues = list((i) => { app.selectFx(i); app.setFrame(app.fx.describe(i).frame); });
  cues.el.style.minHeight = "100px";
  const info = h("div", { class: "hint" });
  el.append(heading("Effects"),
    hint("Effect blocks fired at a socket at a frame of this clip, as the game fires the clip's cues. They play in the views as you play or scrub (the same frame always shows the same effect frame). A burst fires where the socket is at its frame and stays there; a follow rides the socket for dur seconds. Blocks are made in the RMT Effect Studio. The cues save with the clip. The look is close to the game's (the game has GPU particles and glow)."),
    check("show effects in the views", app.show.fx !== false, (v) => { app.show.fx = v; app.applyNow(); app.views.stripDirty(); }, "Effects on / off in the views (they stay on the clip)"),
    filter, blocks.el,
    row(label("at"), socketSel, modeSel), row(label("dur"), durIn, label("size"), sizeIn),
    row(label("offset"), ...offIn), row(label("turn"), ...rotIn),
    row(button("+ AT THIS FRAME", () => add(), "Fire the selected block at the playhead"),
      button("MOVE HERE", async () => { if (sel >= 0) { await app.fx.edit(sel, { frame: app.frame }); refresh(); } }, "Move the selected cue to the playhead"),
      button("REMOVE", () => { if (sel >= 0) { app.fx.remove(sel); app.selectFx(-1); refresh(); } }, "Take the selected cue off the clip")),
    cues.el, info,
    row(button("SAVE CUES", async () => { const ok = await app.fx.save(); app.say(ok ? `Saved the effect cues of ${app.fx.clip}.` : "Save the clip first (the cues are kept by its name).", ok ? "ok" : "warn"); refresh(); }, "Write this clip's cues (Save does it too)"),
      button("OPEN IN EFFECT STUDIO", async () => {
        const ok = await app.fx.openStudio(blockId());
        app.say(ok ? `The RMT Effect Studio opens on ${app.fighter}, ${app.doc.name} at frame ${Math.round(app.frame)}.` : "Godot was not found (set FIGHT_STUDIO_GODOT).", ok ? "ok" : "warn");
      }, "Make or change a block on this fighter, clip and frame (the Godot effect editor)")));
  filter.oninput = () => fillBlocks();

  function fillBlocks() {
    const found = app.fx ? app.fx.blockList(filter.value) : [];
    ids = found.map((b) => b.id);
    blocks.set(found.map((b) => `${b.id}   (${b.category})`));
  }
  const blockId = () => (blocks.selected() >= 0 ? ids[blocks.selected()] : sel >= 0 ? app.fx.describe(sel).id : "");
  const fields = () => ({ socket: socketSel.value, mode: modeSel.value, dur: Number(durIn.value), scale: Number(sizeIn.value),
    offset: offIn.map((x) => Number(x.value)), rot: rotIn.map((x) => Number(x.value)) });
  async function add() {
    const id = blockId();
    if (!id) { app.say("Pick a block in the list first.", "warn"); return; }
    const i = await app.fx.add({ ...fields(), id, frame: app.frame });
    if (i < 0) { app.say(`No block ${id} in the library.`, "warn"); return; }
    app.selectFx(i);
    refresh();
  }
  async function edit() {
    if (quiet || sel < 0) return;
    await app.fx.edit(sel, fields());
    refresh();
  }
  function showSel() {
    if (!app.fx) return;
    if (sel < 0) {
      info.textContent = app.fx.count() ? `${app.fx.count()} cues on this clip${app.fx.dirty ? " (not saved)" : ""}.` : "Pick a block and press + AT THIS FRAME (or double-click it).";
      return;
    }
    const d = app.fx.describe(sel);
    quiet = true;
    socketSel.value = d.socket;
    modeSel.value = d.mode;
    durIn.value = d.dur;
    sizeIn.value = d.scale;
    offIn.forEach((x, i) => (x.value = d.offset[i]));
    rotIn.forEach((x, i) => (x.value = d.rot[i]));
    quiet = false;
    const m = app.fx.measure()[sel] || {};
    const where = m.box ? `  Now ${m.box.size.map((x) => x.toFixed(2)).join(" x ")} m, nearest ${m.nearest_sockets[0].socket}${m.covers_head ? ", over the head" : ""}.` : "";
    info.textContent = `${d.id} at frame ${d.frame} (${d.t.toFixed(3)} s)${where}${app.fx.dirty ? "  (not saved)" : ""}`;
  }
  function refresh() {
    if (!app.fx) return;
    const names = ["origin", ...Object.keys(app.sockSpecs).sort()];
    const cur = socketSel.value;
    socketSel.innerHTML = "";
    for (const n of names) socketSel.append(h("option", { value: n }, n));
    socketSel.value = names.includes(cur) ? cur : names.includes("fist_R") ? "fist_R" : "origin";
    if (!ids.length) fillBlocks();
    const all = app.fx.list();
    sel = app.fxSel;
    if (sel >= all.length) { sel = -1; app.fxSel = -1; }
    cues.set(all.map((d) => `f${d.frame}  ${d.id} @ ${d.socket}  ${d.mode}${d.scale !== 1 ? "  x" + d.scale.toFixed(2) : ""}`), sel);
    showSel();
  }
  app.on((w) => { if (["clip", "fighter", "saved", "fx", "api", "fxsel"].includes(w)) refresh(); });
  setTimeout(refresh, 0);
  return el;
}
