// RMT Animation Studio - boot: builds the window, loads the fighter and clip, runs the render loop, wires the shortcuts and
// the agent API. `--selftest` runs the checks in tests/selftest.js and quits with the result.
import { App } from "./app.js";
import { Stage } from "./stage.js";
import { ViewHost } from "./views.js";
import { Shell, Views, MODES } from "./shell.js";
import { Dope, Graph } from "./timeline.js";
import * as P from "./panels.js";
import { Library } from "./library.js";
import { FxStudioPanel } from "./fxstudio.js";
import { Setup } from "./setup.js";
import { Review } from "./review.js";
import { Compose } from "./compose.js";
import { makeApi } from "./api.js";
import { EASES } from "./core/doc.js";
import * as R from "./core/rig.js";

const app = new App();
window.fsApp = app;
const shell = new Shell(app);
shell.build(document.getElementById("app"));
const stage = new Stage();
const views = new Views();
app.stage = stage;
app.views = views;

function dopeMenu(x, y) {
  shell.contextMenu(x, y, [
    ["Ease to next key", EASES.map((e) => [e, () => app.setKeysField(app.selKeys, "ease", e)])],
    ["Key type", [["key", () => app.setKeysField(app.selKeys, "tag", "")], ["breakdown", () => app.setKeysField(app.selKeys, "tag", "breakdown")], ["extreme", () => app.setKeysField(app.selKeys, "tag", "extreme")]]],
    null,
    ["Link as the same key (edit one, all follow)", () => app.linkKeys(app.selKeys)],
    ["Unlink", () => app.unlinkKeys(app.selKeys)],
    ["Lock (protect from edits)", () => app.setKeysField(app.selKeys, "lock", true)],
    ["Unlock", () => app.setKeysField(app.selKeys, "lock", false)],
    null,
    ["Copy keys", () => app.copyKeys(app.selKeys)],
    ["Paste keys at the current frame", () => app.pasteKeys(Math.round(app.frame))],
    ["Mirror the pose of these keys", () => app.mirrorKeys(app.selKeys)],
    ["Select all keys", () => app.selectKeys(app.doc.keyFrames())],
    null,
    ["Delete keys", () => app.deleteKeys(app.selKeys)],
  ]);
}

function menus() {
  const p = (t, v, fn) => shell.prompt(t, v, fn);
  const f = () => Math.round(app.frame);
  return [
    ["File", () => [
      ["New clip...", () => p("Name for the new clip (starts from the pose on screen):", "my_clip", (n) => app.newClip(n, 30, 30, false, true)), "Ctrl+N"],
      ["New loop clip (walk, idle...)", () => p("Name for the new loop clip (60 frames @ 60 fps, first = last key):", "my_loop", (n) => app.newClip(n, 60, 60, true, true))],
      null,
      ["Save", () => app.save(), "Ctrl+S"],
      ["Save as...", () => p("Save as (clip name):", app.doc.name + "_2", (n) => app.saveAs(n)), "Ctrl+Shift+S"],
      ["Revert to the saved clip", async () => { if (await window.host.confirm("Throw away every change since the last save?")) app.openClip(app.doc.name, true); }],
      null,
      ["Bake clips into the fighter GLB (Animato + Blender)", async () => {
        if (app.history.dirty()) return app.say("Save the clip first (the bake reads the saved files).", "warn");
        if (await window.host.confirm(`Bake every studio clip into ${app.fighter}_fight.glb with Animato (headless Blender)? The original is kept in D:/Cache/chars_before_studio.`)) {
          const r = await window.host.bakeAnimato(app.fighter);
          app.say(r.ok ? `Animato is baking ${app.fighter} in the background.` : r.error, r.ok ? "ok" : "error");
        }
      }],
      ["Import motion (Mixamo FBX, GLB)...", () => shell.importMotion()],
      ["Choose the game project folder...", async () => {
        if (!app.history.dirty() || (await window.host.confirm(`"${app.doc.name}" has changes that are not saved. Switch projects anyway (changes are lost)?`))) window.host.changeProject();
      }],
      ["Open this clip in the Godot Fight Studio Animator", () => window.host.openGodotAnimator(app.fighter, app.doc.name)],
      null,
      ["Quit", () => window.close()],
    ]],
    ["Edit", [
      ["Undo", () => app.undo(), "Ctrl+Z"], ["Redo", () => app.redo(), "Ctrl+Shift+Z"], null,
      ["Copy pose", () => app.copyPose(), "Ctrl+C"], ["Paste pose", () => app.pastePose(false), "Ctrl+V"], ["Paste pose mirrored", () => app.pastePose(true), "Ctrl+Shift+V"],
      ["Paste pose on the selected bones only", () => app.pastePose(false, true)], ["Throw away the unkeyed change", () => app.revertPending(), "Esc"], null,
      ["Select all keys", () => app.selectKeys(app.doc.keyFrames())], ["Clear key selection", () => app.selectKeys([])],
    ]],
    ["Key", [
      ["Set / update key", () => app.keyNow(), "K"], ["Delete key here", () => app.deleteKeys([f()]), "Alt+K"], ["Delete selected keys", () => app.deleteKeys(app.selKeys), "Del"], null,
      ["Ease to next key", EASES.map((e) => [e, () => app.setKeysField(app.selKeys, "ease", e)])],
      ["When a key changes, update the same key elsewhere", [["Off: only the key you edit", () => (app.propagate = "off")], ["Linked keys only", () => (app.propagate = "linked")],
        ["Same pose (default)", () => (app.propagate = "pose")], ["Same bone value", () => (app.propagate = "bone")]].map(([t, fn]) => [t, () => { fn(); app.emit("tool"); }])],
      ["Link selected keys (one pose, many frames)", () => app.linkKeys(app.selKeys)], ["Unlink selected keys", () => app.unlinkKeys(app.selKeys)],
      ["Lock selected keys", () => app.setKeysField(app.selKeys, "lock", true)], ["Unlock selected keys", () => app.setKeysField(app.selKeys, "lock", false)], null,
      ["Insert frames here...", () => p(`Insert how many frames at f${f()}?`, "5", (t) => app.insertFrames(f(), Number(t)))],
      ["Delete frames here...", () => p(`Delete how many frames from f${f()}?`, "5", (t) => app.deleteFrames(f(), Number(t)))],
      ["Scale time (whole clip or selected keys)...", () => p("Scale time by (0.5 = twice as fast, 2 = half speed):", "1.25", (t) => app.scaleTime(Number(t), app.selKeys))],
      ["Reverse selected keys", () => app.selKeys.length > 1 && app.reverseRange(Math.min(...app.selKeys), Math.max(...app.selKeys))],
      ["Close loop (last frame = first key, linked)", () => app.closeLoop()], null,
      ["Bake layers + constraints into keys", () => app.bakeToKeys()],
    ]],
    ["Pose", [
      ["Reset selected bones", () => app.resetBones(app.selBones)], ["Reset the whole pose", () => app.resetBones([...app.bones, "hips_move"])], null,
      ["Mirror left to right", () => app.poseMirror("l2r"), "Ctrl+M"], ["Mirror right to left", () => app.poseMirror("r2l"), "Ctrl+Shift+M"], ["Flip pose (swap sides)", () => app.poseMirror("flip")], null,
      ["Save pose to the library...", () => p("Pose name:", `pose_${app.doc.name}_f${f()}`, (n) => app.saveLibraryPose(n))],
      ["Save selected bones as a partial pose...", () => p("Partial pose name:", `hand_${app.selBone}`, (n) => app.saveLibraryPose(n, true))], null,
      ["Breakdown 25% (toward the previous key)", () => app.breakdown(0.25)], ["Breakdown 50%", () => app.breakdown(0.5)], ["Breakdown 75% (toward the next key)", () => app.breakdown(0.75)],
    ]],
    ["Rig", () => [
      ["Lock / unlock selected bones", () => app.toggleLockSelected(), "L"],
      ["Lock channels of the selected bone", [["X only", "x"], ["Y only", "y"], ["Z only", "z"], ["Y + Z (only X turns)", "yz"], ["Unlock all channels", ""]].map(([t, c]) => [t, () => app.setLock(app.selBone, c)])],
      ["Freeze selected bone in the world from here (pin)", () => app.pinSelected()], null,
      ["Add IK", [["Arm L", "armL"], ["Arm R", "armR"], ["Leg L", "legL"], ["Leg R", "legR"]].map(([t, l]) => [t, () => app.addConstraint({ type: "ik", limb: l })])],
      ["Add aim (head looks at a target)", () => app.addConstraint({ type: "aim", bone: "head", axis: "+z" })],
      ["Add limit to the selected bone", () => app.addConstraint({ type: "limit", bone: app.selBone, min: [-1, -1, -1], max: [1, 1, 1] })],
      ["Add copy rotation (selected copies its mirror bone)", () => app.addConstraint({ type: "copy_rot", bone: app.selBone, source: R.mirrorName(app.selBone), mirror: true })],
      ["Add floor (nothing sinks under it)", () => app.addConstraint({ type: "floor", bones: ["footL", "footR"], mode: "floor" })],
      ["Add plant (lowest foot stands on the floor)", () => app.addConstraint({ type: "floor", bones: ["footL", "footR"], mode: "plant", name: "PLANT feet" })], null,
      ["Run checks", () => shell.showPanel("Checks")], ["Controls (one slider, many bones)", () => shell.showPanel("Controls")],
    ]],
    ["View", () => [
      ["Layout", [["1 view", "1"], ["2 views", "2"], ["3 views", "3"], ["Quad", "4"], ["Strip: front / 3-q / side / back x time", "strip"], ["Quad + strip", "4+strip"]].map(([t, l]) => [t, () => { views.main.setLayout(l); app.emit("tool"); }])],
      ["Strip columns", [6, 8, 10, 12, 16].map((n) => [`${n} columns`, () => { views.hosts.forEach((h) => (h.stripCols = n)); app.stripCols = n; views.stripDirty(); }])],
      ["Render scale (HD / supersampling)", [1, 1.5, 2].map((s) => [`${s}x`, () => { views.hosts.forEach((h) => (h.renderScale = s)); views.resizeAll(); }])],
      null,
      ["Onion skin on / off", () => { app.onion.on = !app.onion.on; app.applyNow(); app.emit("tool"); }, "O"],
      ["Onion skin: by keys / by frames", () => { app.onion.keys = !app.onion.keys; app.applyNow(); }],
      ...[["Motion trail", "trail"], ["Bones", "bones"], ["Bone names", "labels"], ["Sockets", "sockets"], ["Props", "props"], ["All finger joints", "fingers"], ["Game feet (plant + flat feet like a match)", "gameFeet"],
        ["Collision Wrap (the match's Body Solve: parts out of the body and the floor)", "wrap"], ["Wrap capsules (red = still in the body)", "wrapCaps"]]
        .map(([t, k]) => [`${t}: ${app.show[k] ? "on" : "off"}`, () => { app.show[k] = !app.show[k]; app.applyNow(); app.views.stripDirty(); app.emit("tool"); }]),
      ["Strip camera follows the body (walks, runs)", () => { app.stripFollow = !app.stripFollow; views.stripDirty(); }],
      ["Strip around the current frame / whole clip", () => { views.hosts.forEach((h) => (h.aroundNow = !h.aroundNow)); views.stripDirty(); }],
    ]],
    ["Window", () => [
      ["Show panel", [...shell.panels.keys()].map((t) => [t, () => shell.showPanel(t)])],
      ["Float a panel in its own window", [...shell.panels.keys()].map((t) => [t, () => shell.floatPanel(t)])],
      null,
      ["New canvas window: strip (second monitor)", () => shell.newCanvasWindow("strip")],
      ["New canvas window: quad", () => shell.newCanvasWindow("4")],
      ["New canvas window: one big view", () => shell.newCanvasWindow("1")],
      null,
      ["Reset the layout", () => { localStorage.clear(); location.reload(); }],
    ]],
    ["Agents", [
      ["Show the agent log", () => shell.showPanel("Agents")],
      ["Copy the MCP config", () => { navigator.clipboard.writeText(P.mcpConfig()); app.say("MCP config copied.", "ok"); }],
      ["Copy the API address", () => { navigator.clipboard.writeText(`http://127.0.0.1:${app.info.apiPort}/rpc`); app.say("API address copied.", "ok"); }],
    ]],
    ["Help", [["Shortcuts", () => shell.info("Shortcuts", SHORTCUTS)]]],
  ];
}

const SHORTCUTS = `VIEWS   left-drag a joint: Rotate swings it / Move slides the body / IK pulls it (hands + feet bend the limb)
        drag a coloured ring: turn about that axis only     outer white ring: turn in the view
        right-drag orbit   middle-drag pan   wheel zoom   double-click a joint: frame it   \` maximize a view
TOOLS   Q select   E rotate   W move   T IK   X local / global axes   M X-mirror edits   N auto key
KEYS    K set / update key   Alt+K delete key   Del delete selected keys   Esc throw away an unkeyed change
TIME    Space play   , . or Left Right step   Up Down next / previous key   Home End
POSE    Ctrl+C / Ctrl+V copy / paste   Ctrl+Shift+V paste mirrored   Ctrl+M mirror L>R   L lock bone   O onion skin
FILE    Ctrl+S save   Ctrl+Shift+S save as   Ctrl+Z undo   Ctrl+Shift+Z redo
LAYOUT  1 2 3 4 views   5 strip   6 quad + strip   F frame the selected joint
DOPE    click / Shift-click keys, drag to box-select, drag keys to retime, right-click for ease, link, lock, copy, paste
PANELS  drag a tab onto another dock; right-click a tab to float it in its own window (close it to dock it back)`;

shell.key = (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (e.altKey && !ctrl && /^[1-5]$/.test(e.key)) { e.preventDefault(); shell.setMode(Object.keys(MODES)[Number(e.key) - 1]); return; }
  const map = {
    " ": () => app.togglePlay(), k: () => (e.altKey ? app.deleteKeys([Math.round(app.frame)]) : app.keyNow()), i: () => app.keyNow(),
    delete: () => app.deleteKeys(app.selKeys.length ? app.selKeys : [Math.round(app.frame)]), backspace: () => app.deleteKeys(app.selKeys.length ? app.selKeys : [Math.round(app.frame)]),
    arrowleft: () => app.step(-1), ",": () => app.step(-1), arrowright: () => app.step(1), ".": () => app.step(1), arrowup: () => app.gotoKey(1), arrowdown: () => app.gotoKey(-1),
    home: () => app.setFrame(0), end: () => app.setFrame(app.doc.frames), q: () => app.setTool("select"), e: () => app.setTool("rotate"), r: () => app.setTool("rotate"),
    w: () => app.setTool("move"), g: () => app.setTool("move"), t: () => app.setTool("ik"), x: () => { app.spaceGlobal = !app.spaceGlobal; views.dirty(); app.emit("tool"); },
    m: () => (ctrl ? app.poseMirror(e.shiftKey ? "r2l" : "l2r") : (app.mirrorEdit = !app.mirrorEdit, app.emit("tool"))), l: () => app.toggleLockSelected(),
    o: () => { app.onion.on = !app.onion.on; app.applyNow(); app.emit("tool"); }, n: () => (ctrl ? shell.prompt("Name for the new clip:", "my_clip", (n) => app.newClip(n, 30, 30, false, true)) : (app.autokey = !app.autokey, app.emit("tool"))),
    escape: () => app.revertPending(), f: () => { const v = views.main.focused; if (v) { v.target.copy(app.jointWorld(app.selBone)); v.dist = 1.3; v.update(); } },
    "`": () => views.main.focused && views.main.toggleMax(views.main.focused),
    1: () => views.main.setLayout("1"), 2: () => views.main.setLayout("2"), 3: () => views.main.setLayout("3"), 4: () => views.main.setLayout("4"), 5: () => views.main.setLayout("strip"), 6: () => views.main.setLayout("4+strip"),
  };
  if (ctrl) {
    const c = { z: () => (e.shiftKey ? app.redo() : app.undo()), y: () => app.redo(), s: () => (e.shiftKey ? shell.prompt("Save as (clip name):", app.doc.name + "_2", (n) => app.saveAs(n)) : app.save()),
      c: () => app.copyPose(), v: () => app.pastePose(e.shiftKey), m: map.m, n: map.n }[k];
    if (c) { e.preventDefault(); c(); }
    return;
  }
  if (map[k]) { e.preventDefault(); map[k](); if ("123456".includes(k)) app.emit("tool"); }
};
document.addEventListener("keydown", (e) => shell.key(e));

async function boot() {
  const main = new ViewHost(app, shell.canvasWrap, "4");
  views.add(main);
  await app.boot(stage, views);
  P.setMcpPath(app.info.dirs.mcp);
  shell.buildMenus(menus());
  shell.buildToolbar();
  const dock = (title, make, where) => shell.addPanel(title, make, where);
  dock("Setup", Setup(app), "left");
  dock("Library", Library(app), "left");
  dock("Clips", P.Clips(app), "left");
  dock("Poses", P.Poses(app), "left");
  dock("Sockets", P.Sockets(app), "left");
  dock("Properties", P.Props(app), "right_top");
  dock("Controls", P.Controls(app), "right_top");
  dock("Rig v5", P.RigV5(app), "right_top");
  dock("Adjust", P.Adjust(app), "right_top");
  dock("Fill", P.Fill(app), "right_top");
  dock("FX Studio", FxStudioPanel(app), "right_top");
  dock("Compose", Compose(app), "right_top");
  dock("Review", Review(app), "right_top");
  dock("Effects", P.Effects(app), "right_top");
  dock("Layers", P.Layers(app), "right_top");
  dock("Constraints", P.Constraints(app), "right_top");
  dock("Outliner", P.Outliner(app), "right_bottom");
  dock("Checks", P.Checks(app), "right_bottom");
  const dopeEl = document.createElement("div");
  dopeEl.className = "panel";
  dock("Dope Sheet", dopeEl, "bottom");
  const dope = new Dope(app, dopeEl, dopeMenu);
  dopeEl.__resize = () => dope.resize();
  const graphEl = document.createElement("div");
  graphEl.className = "panel";
  dock("Graph", graphEl, "bottom");
  const bar = document.createElement("div");
  bar.className = "row";
  bar.style.cssText = "position:absolute;left:58px;top:30px;z-index:2";
  graphEl.append(bar);
  const graph = new Graph(app, graphEl);
  graphEl.__resize = () => graph.resize();
  ["X", "Y", "Z"].forEach((t, i) => { const b = document.createElement("button"); b.textContent = t; b.className = "on"; b.onclick = () => { graph.channels[i] = !graph.channels[i]; b.classList.toggle("on", graph.channels[i]); graph.draw(); }; bar.append(b); });
  for (const [t, fn] of [["FINAL", (b) => { graph.showFinal = !graph.showFinal; b.classList.toggle("on", graph.showFinal); }], ["HIPS MOVE", (b) => { graph.showHips = !graph.showHips; graph._fitNext = true; b.classList.toggle("on", graph.showHips); }], ["FIT", () => { graph._fitNext = true; }]]) {
    const b = document.createElement("button");
    b.textContent = t;
    if (t === "FINAL") b.className = "on";
    b.onclick = () => { fn(b); graph.draw(); };
    bar.append(b);
  }
  dock("Blend Lab", P.Blend(app), "bottom");
  dock("Merge", P.Merge(app), "bottom");
  dock("Feet", P.Feet(app), "bottom");
  dock("Agents", P.Agents(app), "bottom");
  dock("History", P.HistoryPanel(app), "bottom");
  dock("Render", P.Render(app), "bottom");
  for (const d of ["left", "right_top", "right_bottom", "bottom"]) shell.activate([...shell.panels].find(([, p]) => p.dock === d)[0]);
  shell.restoreLayout();
  const wantMode = (app.info.args.find((x) => x.startsWith("--mode=")) || "").slice(7).toUpperCase();
  shell.setMode(MODES[wantMode] ? wantMode : shell.savedMode(), false);
  const wantFx = (app.info.args.find((x) => x.startsWith("--fx=")) || "").slice(5);
  if (wantFx) await app.fxs.open(wantFx);
  window.host.onRpc(makeApi(app));
  document.getElementById("boot").classList.add("gone");
  app.emit("doc");
  app.emit("clip");
  let last = performance.now();
  const loop = (t) => {
    app.tick(Math.min(0.1, (t - last) / 1000));
    last = t;
    if (app.playing || app.agentFlash > 0) views.dirty();
    views.render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  if (app.info.args.includes("--selftest")) {
    const { selftest } = await import("../tests/selftest.js");
    const r = await selftest(app);
    await window.host.log(r.lines.join("\n"));
    await window.host.log(`DESKTOP SELFTEST: ${r.pass} passed, ${r.fail} failed`);
    window.host.quit(r.fail ? 1 : 0);
  }
  const shot = app.info.args.find((a) => a.startsWith("--shot="));
  if (shot) {
    const wait = app.info.args.find((a) => a.startsWith("--shot-wait="));
    await new Promise((r) => setTimeout(r, wait ? Number(wait.slice(12)) : 1500));
    const call = makeApi(app);
    const res = await call("screenshot", { target: "window", path: shot.slice(7) });
    await window.host.log(JSON.stringify(res));
    window.host.quit(0);
  }
}

boot().catch(async (e) => {
  document.getElementById("boot").innerHTML = `RMT ANIMATION STUDIO<small style="color:#ff4d4d">${String(e && e.stack ? e.stack : e)}</small>`;
  await window.host.log("BOOT ERROR " + (e && e.stack ? e.stack : e));
  if ((await window.host.info()).args.includes("--selftest")) window.host.quit(2);   // a self-test that throws ends instead of hanging
});
