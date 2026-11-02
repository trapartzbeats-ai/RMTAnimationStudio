// FX Studio: edit an RMT effect block live. The block (the game's addons/rmt_effects manifest) opens as a working copy that
// plays on the stage beside the fighter; every setting the runtime reads has a control (the shaders' own uniforms with their
// ranges, particles, lights, trails, decals), layers can be added, copied, moved, muted and soloed, the layer timeline
// drags start / end, and SAVE writes a user override exactly as the Godot Effect Studio does (the shipped manifest stays
// as it is; REVERT moves the override to the trash folder). Keyframed tracks (layer_time.gd) are kept as they are, not edited.
import * as THREE from "three";
import * as FXR from "./core/rmtfx.js";
import * as GS from "./core/gdshader.js";
import { h, button, row, hint, label, select, check, slider } from "./ui.js";

export const PHASES = ["", "anticipation", "effect", "cooldown"];
const INT_KEYS = ["amount", "h", "v", "sides", "fixed_fps", "count", "fps"];
const MESHES = ["card", "ring", "sphere", "tube", "disc", "spike", "coin", "rock"];
const GROUPS = ["emission", "initial_velocity", "scale", "angle", "angular_velocity", "damping", "radial_accel", "tangential_accel", "turbulence", "anim"];
const KINDS = ["particles", "light", "mesh", "decal", "trail", "aura", "block"];
const TEX_RES = "res://addons/rmt_effects/textures/";
const TAIL = 0.35;   // seconds the preview runs past the block's duration (particles still in the air)
const LAYER_COLORS = { mesh: "#ff7a1a", particles: "#3ee0c1", light: "#ffc93c", trail: "#4fd1ff", decal: "#a77bff", aura: "#ff5d8f", block: "#9a91a6" };

const clone = (o) => JSON.parse(JSON.stringify(o));
const snap = (v, s) => Math.round(v / s) * s;
const hexOf = (s, fallback = "ffffff") => String(s ?? fallback).replace("#", "") || fallback;

export function getAt(obj, path) {
  let o = obj;
  for (const k of path) { if (o === undefined || o === null) return undefined; o = o[k]; }
  return o;
}
export function setAt(obj, path, v) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof o[path[i]] !== "object" || o[path[i]] === null) o[path[i]] = {};
    o = o[path[i]];
  }
  o[path[path.length - 1]] = v;
}

// when a layer runs: [start, end] in seconds (core/layer_time.gd span / phase_start)
export function phaseStart(layer, phases) {
  const a = Number((phases || {}).anticipation || 0), i = Number((phases || {}).impact || 0);
  const p = String(layer.phase || "");
  return p === "anticipation" ? 0 : p === "cooldown" ? a + i * 0.5 : a;
}
export function layerSpan(layer, phases, duration) {
  const start = Number(layer.start ?? phaseStart(layer, phases));
  let end = layer.end !== undefined ? Number(layer.end) : -1;
  if (end < 0) {
    const an = layer.animate;
    let life = 0;
    if (an && an.life !== undefined) life = Number(an.life) + Number(an.delay || 0);
    else if (layer.kind === "particles") life = Number(layer.lifetime ?? 1);
    else if (layer.fade !== undefined && layer.kind === "light") life = Number(layer.fade);
    end = life > 0 ? start + life : duration;
    if (layer.start !== undefined && life > 0) end = start + life;
  }
  return [start, end];
}
// the block's phases from its layers' `phase` and its duration (a looping block has none)
export function recomputePhases(m) {
  if (m.loop) { delete m.phases; return; }
  const d = Number(m.duration ?? 1);
  let gather = false;
  for (const l of m.layers || []) {
    if (!l.phase) l.phase = "effect";
    if (l.phase === "anticipation") gather = true;
  }
  const a = gather ? snap(Math.min(0.22, Math.max(0.06, d * 0.12)), 0.001) : 0;
  const i = snap(d * 0.55, 0.001);
  m.phases = { anticipation: a, impact: i, cooldown: snap(Math.max(0, d - a - i), 0.001) };
}

export class FxStudio {
  constructor(app) {
    this.app = app;
    this.id = "";
    this.entry = null;
    this.manifest = null;
    this.orig = "";
    this.dirty = false;
    this.sel = -1;
    this.time = 0;
    this.playing = true;
    this.loop = true;
    this.speed = 1;
    this.at = "origin";
    this.mute = new Set();
    this.fold = new Map();
    this.solo = "";
    this.eff = null;
    this.err = "";
    this.shaders = [];
    this.textures = [];
    this.holder = new THREE.Group();
    this.holder.name = "FxStudio";
    this._timer = 0;
    this._seq = 0;
    this._shaderInfo = new Map();
    this._seeked = -1;
  }

  async init() {
    this.shaders = await window.host.fxShaders();
    this.textures = await window.host.fxTextures();
    this.app.fx.floorN.add(this.holder);
    this.syncVisible();
  }

  syncVisible() {
    this.holder.visible = this.app.mode === "FX" && !!this.id;
    this.app.views && this.app.views.dirty();
  }

  get ids() { return this.app.fx ? [...this.app.fx.library.keys()].sort() : []; }
  duration() { return Number(this.manifest ? this.manifest.duration ?? 1 : 1); }
  layers() { return this.manifest ? this.manifest.layers : []; }
  layer() { return this.manifest && this.sel >= 0 ? this.manifest.layers[this.sel] || null : null; }
  status() { return !this.id ? "" : this.dirty ? "modified" : this.entry && this.entry.override ? "override" : "shipped"; }

  // a shader's parsed uniforms (ranges, defaults, descriptions)
  async shaderInfo(name) {
    if (!name) return null;
    if (!this._shaderInfo.has(name)) {
      const src = this.app.fx._shaders.get(name) || (await window.host.fxShader(name));
      this._shaderInfo.set(name, src ? GS.parse(src) : null);
    }
    return this._shaderInfo.get(name);
  }

  async open(id) {
    const e = this.app.fx && this.app.fx.library.get(id);
    if (!e) return false;
    this.id = id;
    this.entry = e;
    this.manifest = clone(e.manifest);
    this.orig = JSON.stringify(e.manifest);
    this.dirty = false;
    this.sel = this.manifest.layers.length ? 0 : -1;
    this.mute.clear();
    this.solo = "";
    this.time = 0;
    this.playing = true;
    this.syncVisible();
    this.app.emit("fxstudio");
    await this.rebuildNow();
    return true;
  }

  // ---------------------------------------------------------------- editing

  // the working copy changed: mark it, tell the panel, rebuild the preview shortly
  changed(rebuild = true, redraw = false) {
    this.dirty = JSON.stringify(this.manifest) !== this.orig;
    this.app.emit(redraw ? "fxstudio" : "fxstudio_light");
    if (rebuild) this.queueRebuild();
  }

  queueRebuild() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.rebuildNow(), 80);
  }

  refreshPhases() { if (this.manifest) recomputePhases(this.manifest); }

  uniqueName(base) {
    const names = new Set(this.layers().map((l) => l.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  newLayer(kind) {
    const d = this.duration();
    const t = {
      light: () => ({ kind: "light", name: this.uniqueName("Light"), color: "ffd9a0", energy: 3.0, range: 5.0, fade: Math.min(d, 0.6), transform: { pos: [0, 1, 0] } }),
      mesh: () => ({ kind: "mesh", name: this.uniqueName("Ring"), mesh: "ring", shader: "shockwave", color: "ffd9a0", params: { width: 0.16, noise_scale: 6.0, softness: 0.32, radius: 0.9 },
        animate: { scale_from: [0.3, 0.3, 0.3], scale_to: [3, 3, 3], life: Math.min(d, 0.6), fade: true }, transform: { pos: [0, 0.03, 0] } }),
      decal: () => ({ kind: "decal", name: this.uniqueName("Decal"), texture: TEX_RES + "decal_scorch.png", size: [2, 0.4, 2], albedo_mix: 1, fade: 2, transform: { pos: [0, 0.01, 0] } }),
      trail: () => ({ kind: "trail", name: this.uniqueName("Trail"), length: 0.3, width: 0.12, taper: 0.8, sides: 6, color_ramp: [[0, "ffffffff"], [1, "ffffff00"]] }),
      aura: () => ({ kind: "aura", name: this.uniqueName("Aura"), shader: "aura_shell", params: { fade: 1 }, animate: { life: d } }),
      block: () => ({ kind: "block", name: this.uniqueName("Block"), id: this.ids.find((x) => x !== this.id) || "", start: 0 }),
      particles: () => ({ kind: "particles", name: this.uniqueName("Particles"), mesh: "spike", align: "velocity", amount: 24, lifetime: 0.5, loop: false, explosiveness: 0.95,
        randomness: 0.4, local_coords: true, emission: { shape: "sphere", radius: 0.1 }, direction: [0, 1, 0], spread: 180, gravity: [0, -3, 0], initial_velocity: { min: 2, max: 4 },
        scale: { min: 0.12, max: 0.2, curve: [[0, 1], [1, 0]] }, color_ramp: [[0, "ffffffff"], [1, "ffcc44ff"]], material: { blend: "add", shader: "particle_tint" } }),
    }[kind];
    return t ? t() : null;
  }

  addLayer(kind) {
    const l = this.newLayer(kind);
    if (!l) return;
    if (["block", "mesh", "light", "decal", "aura", "particles"].includes(kind) && l.start === undefined) l.start = snap(Math.max(this.time, 0), 0.01);
    this.manifest.layers.push(l);
    this.refreshPhases();
    this.sel = this.manifest.layers.length - 1;
    this.changed(true, true);
  }

  duplicateLayer(i = this.sel) {
    const l = this.layers()[i];
    if (!l) return;
    const c = clone(l);
    c.name = this.uniqueName(l.name);
    this.manifest.layers.splice(i + 1, 0, c);
    this.sel = i + 1;
    this.changed(true, true);
  }

  removeLayer(i = this.sel) {
    const ls = this.layers();
    if (i < 0 || i >= ls.length || ls.length <= 1) return;
    this.mute.delete(ls[i].name);
    ls.splice(i, 1);
    this.refreshPhases();
    this.sel = Math.min(this.sel, ls.length - 1);
    this.changed(true, true);
  }

  moveLayer(i, d) {
    const ls = this.layers(), j = i + d;
    if (i < 0 || j < 0 || i >= ls.length || j >= ls.length) return;
    [ls[i], ls[j]] = [ls[j], ls[i]];
    this.sel = j;
    this.changed(true, true);
  }

  renameLayer(i, name) {
    const l = this.layers()[i];
    name = String(name || "").trim();
    if (!l || !name || name === l.name) return false;
    if (this.layers().some((o) => o !== l && o.name === name)) { this.app.say(`A layer is already called ${name}.`, "warn"); return false; }
    if (this.mute.delete(l.name)) this.mute.add(name);
    if (this.solo === l.name) this.solo = name;
    l.name = name;
    this.changed(true, true);
    return true;
  }

  setStart(i, v) {
    const l = this.layers()[i];
    if (!l) return;
    const sp = layerSpan(l, this.manifest.phases, this.duration());
    v = Math.max(0, v);
    l.start = v;
    if (l.end !== undefined) l.end = Number(l.end) + (v - sp[0]);
    this.changed(true);
  }

  select(i) { this.sel = i; this.app.emit("fxstudio"); }

  toggleMute(name) { if (this.mute.has(name)) this.mute.delete(name); else this.mute.add(name); this.queueRebuild(); this.app.emit("fxstudio"); }
  toggleSolo(name) { this.solo = this.solo === name ? "" : name; this.queueRebuild(); this.app.emit("fxstudio"); }

  // ---------------------------------------------------------------- the preview

  visibleLayers() {
    return this.layers().filter((l) => (this.solo ? l.name === this.solo : !this.mute.has(l.name)));
  }

  async rebuildNow() {
    if (!this.manifest) return;
    const seq = ++this._seq;
    const fx = this.app.fx;
    const pm = { ...this.manifest, layers: this.visibleLayers() };
    try {
      const block = await FXR.prepare({ manifest: pm, dir: this.entry.dir, resUrl: this.entry.resUrl }, async (name) => {
        if (!fx._shaders.has(name)) fx._shaders.set(name, await window.host.fxShader(name));
        return fx._shaders.get(name);
      });
      if (seq !== this._seq) return;
      const eff = new FXR.RmtEffect(block);
      this._dropEffect();
      this.eff = eff;
      this.holder.add(eff);
      this.err = "";
      this._seeked = -1;
      this.seekNow();
    } catch (e) {
      if (seq !== this._seq) return;
      this.err = String((e && e.message) || e);
    }
    this.app.emit("fxstudio_light");
  }

  _dropEffect() {
    if (!this.eff) return;
    this.holder.remove(this.eff);
    this.eff.dispose();
    this.eff = null;
  }

  // the preview at this.time, placed at its socket
  seekNow() {
    if (!this.eff) return;
    this.placeAt();
    this.holder.updateWorldMatrix(true, true);
    this.eff.seek(this.time, 1);
    this._seeked = this.time;
    this.app.views && this.app.views.dirty();
  }

  placeAt() {
    const fx = this.app.fx;
    if (this.at === "origin" || !fx) { this.holder.position.set(0, 0, 0); return; }
    fx.floorN.updateWorldMatrix(true, false);
    const p = fx.socketAt(this.at, this.app.frame / Math.max(this.app.doc.fps, 1));
    this.holder.position.copy(fx.floorN.worldToLocal(p.clone()));
  }

  end() { return this.duration() + TAIL; }

  scrub(t) {
    this.playing = false;
    this.time = Math.max(0, Math.min(this.end(), t));
    this.seekNow();
    this.app.emit("fxstudio_light");
  }

  replay() { this.time = 0; this.playing = true; this.seekNow(); this.app.emit("fxstudio_light"); }

  tick(dt) {
    if (!this.holder.visible || !this.eff) return;
    let moved = false;
    if (this.playing) {
      this.time += dt * this.speed;
      if (this.time > this.end()) {
        if (this.loop) this.time = 0;
        else { this.time = this.end(); this.playing = false; }
      }
      moved = true;
    }
    if (this.at !== "origin") moved = true;   // a socket moves with the fighter
    if (moved || this._seeked !== this.time) {
      this.seekNow();
      this.app.emit("fxtime");
    }
  }

  // ---------------------------------------------------------------- save, revert, fire

  async save() {
    if (!this.id) return false;
    const m = clone(this.manifest);
    const ok = await window.host.fxSaveOverride(this.id, m);
    if (!ok) { this.app.say(`Could not save ${this.id}.`, "warn"); return false; }
    this.entry.manifest = clone(m);
    this.entry.override = true;
    this.orig = JSON.stringify(m);
    this.dirty = false;
    await this.app.fx.reloadBlock(this.id);
    this.app.say(`Saved ${this.id} as a user override (the shipped block is untouched). Clips that fire it play this one.`, "ok");
    this.app.emit("fxstudio");
    return true;
  }

  async revert() {
    if (!this.id) return false;
    const id = this.id;
    if (this.entry.override) {
      if (!(await window.host.fxRevertOverride(id))) { this.app.say(`No override to revert for ${id}.`, "warn"); return false; }
      const lib = await window.host.fxLibrary();
      const b = lib.blocks.find((x) => x.id === id);
      if (b) this.app.fx.library.set(id, { ...b, resUrl: (p) => lib.resRoot + String(p).replace(/^res:\/\//, "") });
      await this.app.fx.reloadBlock(id);
      this.app.say(`${id} is the shipped block again (the override went to the trash folder).`, "ok");
    }
    this._shaderInfo.clear();
    return this.open(id);
  }

  // the block as a cue on the clip at the playhead (the saved version: the clip plays what is saved)
  async fire() {
    if (!this.id) return -1;
    if (this.dirty) { this.app.say("Save first: a clip fires the saved block.", "warn"); return -1; }
    const i = await this.app.fx.add({ id: this.id, socket: this.at, mode: "burst", dur: 0.5, scale: 1, offset: [0, 0, 0], rot: [0, 0, 0], frame: this.app.frame });
    if (i >= 0) { this.app.selectFx(i); this.app.say(`${this.id} fires at frame ${Math.round(this.app.frame)} on ${this.app.doc.name}.`, "ok"); }
    return i;
  }

  async snapshot() {
    const p = await window.host.captureWindow(`${this.app.info.dirs.renders}/fx_${this.id}_${Date.now()}.png`);
    this.app.say(p ? `Snapshot: ${p}` : "Could not take the snapshot.", p ? "ok" : "warn");
    return p;
  }
}

// ==================================================================== the panel

export function FxStudioPanel(app) {
  const st = app.fxs;
  const el = h("div", { class: "pbody fxs" });
  const open = st.fold;   // section kind -> folded open (kept on the engine: it outlives the panel's re-renders)
  let shaderFor = "";       // the shader the uniform rows were built for (rows wait for its text)

  // ------------------------------------------------ small controls
  const ch = (rebuild = true) => st.changed(rebuild);
  const numRow = (text, get, set, lo, hi, step, { tip = "", int = false, reset = null } = {}) => {
    const v = Number(get());
    const s = slider(text, Math.min(lo, v), Math.max(hi, v), step, v, (x) => { set(int ? Math.round(x) : x); ch(); }, { title: tip });
    if (reset) s.el.append(button("↺", () => { reset(); ch(); render(); }, "Back to the shader's default"));
    return s.el;
  };
  const checkRow = (text, get, set, tip = "") => h("div", { class: "row" }, check(text, get(), (v) => { set(v); ch(); }, tip));
  const optionRow = (text, options, get, set, tip = "") => {
    const cur = String(get() ?? "");
    const opts = options.includes(cur) ? options : [...options, cur];
    return h("div", { class: "row" }, label(text), select(opts.map((o) => [o, o === "" ? "(none)" : o]), cur, (v) => { set(v); ch(); }, tip));
  };
  const textRow = (text, get, set) => {
    const i = h("input", { type: "text", value: String(get() ?? ""), style: "flex:1", onchange: () => { set(i.value); ch(); } });
    return h("div", { class: "row" }, label(text), i);
  };
  const colorRow = (text, get, set, alpha = false, tip = "", reset = null) => {
    const hex = hexOf(get());
    const rgb = hex.slice(0, 6).padEnd(6, "0");
    const a0 = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    const c = h("input", { type: "color", value: "#" + rgb, title: tip });
    const a = alpha ? h("input", { type: "number", min: 0, max: 1, step: 0.01, value: Math.round(a0 * 100) / 100, style: "width:56px", title: "alpha" }) : null;
    const push = () => { const ah = Math.round(Math.min(1, Math.max(0, Number(a.value))) * 255).toString(16).padStart(2, "0"); set(c.value.slice(1) + (alpha ? ah : "")); ch(); };
    c.oninput = () => push();
    if (a) a.onchange = () => push();
    return h("div", { class: "row" }, label(text), c, a, reset ? button("↺", () => { reset(); ch(); render(); }, "Back to the shader's default") : null);
  };
  const vec3Row = (text, get, set, lo, hi, step) => {
    const arr = () => { const v = get(); return Array.isArray(v) && v.length === 3 ? v.map(Number) : [0, 0, 0]; };
    const ins = [0, 1, 2].map((i) => {
      const n = h("input", { type: "number", step, value: Math.round(arr()[i] * 10000) / 10000, style: "width:64px", title: "xyz"[i] });
      n.onchange = () => { const a = arr(); a[i] = Number(n.value); set(a); ch(); };
      return n;
    });
    return h("div", { class: "row" }, label(text), ...ins);
  };
  const noteRow = (t) => h("div", { class: "hint" }, t);
  // a fold is remembered by the section's kind ("SHADER  shockwave" is "SHADER"), so it holds from layer to layer
  const section = (title, ...kids) => {
    const key = title.split("  ")[0];
    const d = h("details", { class: "sec", open: open.has(key) ? open.get(key) : key !== "BLOCK" }, h("summary", {}, title), ...kids.flat().filter(Boolean));
    d.addEventListener("toggle", () => open.set(key, d.open));
    return d;
  };
  const texRow = (text, get, set) => {
    const cur = String(get() ?? "");
    const base = cur.split("/").pop().replace(/\.png$/, "");
    const names = ["", ...st.textures.map((t) => t.name)];
    if (base && !names.includes(base)) names.push(base);
    const tex = st.textures.find((t) => t.name === base);
    const img = h("img", { class: "texthumb", src: tex ? tex.url : "", draggable: false, onerror: () => img.classList.add("gone") });
    return h("div", { class: "row" }, label(text), select(names.map((o) => [o, o || "(none)"]), base, (v) => { set(v ? TEX_RES + v + ".png" : ""); ch(); render(); }), img);
  };

  // curve [t, v] pairs and colour ramps
  const pairsRows = (owner, key, title, lo, hi) => {
    const arr = owner[key];
    if (!Array.isArray(arr)) return null;
    return h("div", {}, noteRow(title), ...arr.map((pr, i) => {
      const t = h("input", { type: "number", min: 0, max: 1, step: 0.01, value: pr[0], style: "width:60px", onchange: () => { pr[0] = Number(t.value); ch(); } });
      const v = slider("", Math.min(lo, pr[1]), Math.max(hi, pr[1]), 0.01, pr[1], (x) => { pr[1] = x; ch(); });
      return h("div", { class: "row" }, t, v.el, button("x", () => { if (arr.length > 2) { arr.splice(i, 1); ch(); render(); } }, "Remove this point"));
    }), button("+ point", () => { arr.splice(arr.length - 1, 0, [0.5, arr[arr.length - 1][1]]); arr.sort((a, b) => a[0] - b[0]); ch(); render(); }));
  };
  const rampRows = (owner, key, title) => {
    const arr = owner[key];
    if (!Array.isArray(arr)) return null;
    return h("div", {}, noteRow(title || key.replace(/_/g, " ") + " (left = born, right = gone)"), ...arr.map((stop, i) => {
      const t = h("input", { type: "number", min: 0, max: 1, step: 0.01, value: stop[0], style: "width:60px", onchange: () => { stop[0] = Number(t.value); ch(); } });
      const hex = hexOf(stop[1], "ffffffff").padEnd(8, "f");
      const c = h("input", { type: "color", value: "#" + hex.slice(0, 6) });
      const a = h("input", { type: "number", min: 0, max: 1, step: 0.01, value: Math.round(parseInt(hex.slice(6, 8), 16) / 2.55) / 100, style: "width:54px", title: "alpha" });
      const push = () => { stop[1] = c.value.slice(1) + Math.round(Math.min(1, Math.max(0, Number(a.value))) * 255).toString(16).padStart(2, "0"); ch(); };
      c.oninput = push; a.onchange = push;
      return h("div", { class: "row" }, t, c, a, button("x", () => { if (arr.length > 2) { arr.splice(i, 1); ch(); render(); } }, "Remove this stop"));
    }), button("+ stop", () => { arr.splice(arr.length - 1, 0, [0.5, arr[arr.length - 2][1]]); arr.sort((a, b) => a[0] - b[0]); ch(); render(); }));
  };

  // a shader's own settings (type, range, default, description) written into `params`
  function uniformRows(info, params, keyable) {
    if (!info) return [noteRow("this layer has no shader of its own (the default additive material)")];
    const out = [];
    for (const u of info.uniforms) {
      const name = u.name, text = name.replace(/_/g, " "), touched = name in params;
      if (["fade", "rmt_clock", "depth_tex", "use_ramp"].includes(name)) continue;
      const reset = touched ? () => { delete params[name]; } : null;
      if (name === "ramp_tex") { out.push(...rampParamRows(params)); continue; }
      if (u.tex) { out.push(texRow(text, () => params[name] || "", (v) => { if (v) params[name] = v; else delete params[name]; })); continue; }
      const defNums = (u.def || "").match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || [];
      if (u.type === "float" || u.type === "int") {
        const def = defNums.length ? Number(defNums[0]) : 0;
        let lo, hi, step;
        if (u.range) { [lo, hi, step] = u.range; step = step || (u.type === "int" ? 1 : (hi - lo) / 400); }
        else { const b = Math.max(Math.abs(def) * 4, 1); lo = -b; hi = b; step = 0.01; }
        step = Math.max(step, u.type === "float" ? 0.0001 : 1);
        out.push(numRow(text, () => (name in params ? params[name] : def), (v) => { params[name] = v; }, lo, hi, step, { tip: u.desc, int: u.type === "int", reset }));
      } else if (u.type === "bool") {
        out.push(checkRow(text, () => (name in params ? !!params[name] : /true/.test(u.def || "")), (v) => { params[name] = v; }, u.desc));
      } else if (u.color && (u.type === "vec3" || u.type === "vec4")) {
        const hexDef = defNums.length >= 3 ? defNums.slice(0, 3).map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("") : "ffffff";
        out.push(colorRow(text, () => (typeof params[name] === "string" ? params[name] : hexDef), (v) => { params[name] = v; }, u.type === "vec4", u.desc, reset));
      } else if (u.type === "vec2") {
        for (let ax = 0; ax < 2; ax++) {
          out.push(numRow(`${text} ${"xy"[ax]}`, () => (Array.isArray(params[name]) ? params[name][ax] : Number(defNums[ax] ?? defNums[0] ?? 0)), (v) => {
            const a = Array.isArray(params[name]) ? params[name] : [Number(defNums[0] ?? 0), Number(defNums[1] ?? defNums[0] ?? 0)];
            a[ax] = v; params[name] = a;
          }, -8, 8, 0.01, { tip: u.desc }));
        }
      } else if (u.type === "vec3" && keyable) {
        out.push(vec3Row(text, () => (Array.isArray(params[name]) ? params[name] : [Number(defNums[0] ?? 0), Number(defNums[1] ?? defNums[0] ?? 0), Number(defNums[2] ?? defNums[0] ?? 0)]), (v) => { params[name] = v; }, -4, 4, 0.01));
      } else out.push(noteRow(`${name}: ${JSON.stringify(params[name] ?? u.def)}`));
    }
    return out;
  }

  // the shader kit's multi-stop ramp texture (a stop list, or {stops, constant} for hard toon steps)
  function rampParamRows(params) {
    const on = "ramp_tex" in params;
    const out = [checkRow("multi-stop ramp", () => on, (v) => { if (v) params.ramp_tex = [[0, "3a0a00ff"], [0.5, "ff6a10ff"], [1, "fff2b0ff"]]; else delete params.ramp_tex; render(); })];
    if (!on) return out;
    if (Array.isArray(params.ramp_tex)) params.ramp_tex = { stops: params.ramp_tex, constant: false };
    out.push(checkRow("  hard steps (toon)", () => !!params.ramp_tex.constant, (v) => { params.ramp_tex.constant = v; }));
    out.push(rampRows(params.ramp_tex, "stops", "ramp stops"));
    return out;
  }

  // ------------------------------------------------ the block and one layer
  function blockSection(m) {
    const lod = m.lod || {};
    return section("BLOCK  " + m.id,
      textRow("category", () => m.category, (v) => { m.category = v; }),
      numRow("duration s", () => m.duration ?? 1, (v) => { m.duration = v; st.refreshPhases(); }, 0.1, 30, 0.05),
      checkRow("loop", () => !!m.loop, (v) => { m.loop = v; st.refreshPhases(); }),
      checkRow("auto play", () => m.auto_play !== false, (v) => { m.auto_play = v; }),
      textRow("tags", () => (m.tags || []).join(", "), (v) => { m.tags = v.split(",").map((x) => x.trim()).filter(Boolean); }),
      numRow("lod full m", () => lod.full ?? 40, (v) => { (m.lod ||= {}).full = v; }, 1, 300, 1),
      numRow("lod cull m", () => lod.cull ?? 120, (v) => { (m.lod ||= {}).cull = v; }, 1, 600, 1),
      m.phases ? noteRow(`phases: anticipation ${m.phases.anticipation} s, impact ${m.phases.impact} s, cooldown ${m.phases.cooldown} s`) : null);
  }

  function layerSections(L, info) {
    const m = st.manifest, kind = L.kind;
    const out = [];
    const span = layerSpan(L, m.phases, st.duration());
    const timing = [
      textRow("name", () => L.name, (v) => { st.renameLayer(st.sel, v); }),
      numRow("start s", () => span[0], (v) => st.setStart(st.sel, v), 0, 30, 0.01),
      h("div", { class: "row" }, check("cut at s", L.end !== undefined, (on) => { if (on) L.end = span[1]; else delete L.end; ch(); render(); }),
        L.end !== undefined ? slider("", 0, Math.max(30, L.end), 0.01, L.end, (v) => { L.end = v; ch(); }).el : null),
    ];
    if (kind === "mesh" || kind === "aura") timing.push(numRow("life s", () => (L.animate || {}).life ?? st.duration(), (v) => { (L.animate ||= {}).life = v; }, 0.05, 30, 0.01));
    timing.push(optionRow("phase", PHASES, () => L.phase || "", (v) => { if (v) L.phase = v; else delete L.phase; st.refreshPhases(); }));
    out.push(section("TIMING", ...timing));
    const tr = () => (L.transform ||= {});
    const sc = tr().scale;
    out.push(section("TRANSFORM",
      vec3Row("pos m", () => tr().pos, (v) => { tr().pos = v; }, -6, 6, 0.01),
      vec3Row("rot deg", () => tr().rot, (v) => { tr().rot = v; }, -180, 180, 0.5),
      Array.isArray(sc)
        ? vec3Row("scale", () => tr().scale, (v) => { tr().scale = v; }, 0, 4, 0.01)
        : h("div", { class: "row" }, slider("scale", 0, Math.max(4, Number(sc ?? 1)), 0.01, Number(sc ?? 1), (v) => { tr().scale = v; ch(); }).el,
          button("xyz", () => { const s = Number(tr().scale ?? 1); tr().scale = [s, s, s]; ch(); render(); }, "Scale each axis on its own"))));
    if (kind === "light") {
      out.push(section("LIGHT",
        colorRow("color", () => L.color, (v) => { L.color = v; }),
        numRow("energy", () => L.energy ?? 2, (v) => { L.energy = v; }, 0, 40, 0.05),
        numRow("range", () => L.range ?? 5, (v) => { L.range = v; }, 0, 40, 0.1),
        numRow("fade s", () => L.fade ?? 0, (v) => { L.fade = v; }, 0, 10, 0.01)));
    } else if (kind === "decal") {
      out.push(section("DECAL",
        numRow("albedo mix", () => L.albedo_mix ?? 1, (v) => { L.albedo_mix = v; }, 0, 1, 0.01),
        numRow("emission", () => L.emission_energy ?? 0, (v) => { L.emission_energy = v; }, 0, 16, 0.05),
        numRow("fade s", () => L.fade ?? 1, (v) => { L.fade = v; }, 0, 10, 0.01),
        vec3Row("size m", () => L.size, (v) => { L.size = v; }, 0.05, 8, 0.05),
        texRow("texture", () => L.texture, (v) => { L.texture = v; })));
    } else if (kind === "mesh" || kind === "aura") {
      const rows = [optionRow("shader", [...(kind === "mesh" ? [""] : []), ...st.shaders], () => L.shader || "", (v) => {
        if (!v) { delete L.shader; delete L.params; } else { L.shader = v; L.params = { fade: 1 }; }
        render();
      }, "Switching starts the settings at the shader's own defaults")];
      if (kind === "mesh") rows.push(optionRow("mesh", MESHES, () => L.mesh || "card", (v) => { L.mesh = v; }, "From the block's own GLB"));
      if (info && info.uniforms.some((u) => u.name === "ring_color")) rows.push(colorRow("color (ring_color)", () => L.color, (v) => { L.color = v; }));
      L.params ||= {};
      rows.push(...uniformRows(info, L.params, true));
      out.push(section("SHADER  " + (L.shader || "(none)"), ...rows));
    } else if (kind === "particles") {
      out.push(...particleSections(L, info));
    } else if (kind === "trail") {
      out.push(section("TRAIL",
        numRow("length s", () => L.length ?? 0.2, (v) => { L.length = v; }, 0.05, 3, 0.01),
        numRow("width m", () => L.width ?? 0.2, (v) => { L.width = v; }, 0.01, 2, 0.01),
        numRow("taper", () => L.taper ?? 1, (v) => { L.taper = v; }, 0, 1, 0.01),
        numRow("sides", () => L.sides ?? 6, (v) => { L.sides = v; }, 3, 16, 1, { int: true }),
        rampRows(L, "color_ramp")));
    } else if (kind === "block") {
      out.push(section("BLOCK LAYER", optionRow("block", st.ids, () => L.id || "", (v) => { L.id = v; }), noteRow("Another block plays here as a layer. Edit it by opening it in the Library.")));
    }
    if (L.tracks || L.keys) out.push(noteRow("This layer has keyframed tracks; they are kept as they are (edit them in the Godot Effect Studio)."));
    return out;
  }

  function particleSections(L, info) {
    const main = [];
    for (const [text, key, lo, hi, step] of [["amount", "amount", 1, 400, 1], ["lifetime s", "lifetime", 0.05, 8, 0.01], ["explosiveness", "explosiveness", 0, 1, 0.01], ["randomness", "randomness", 0, 1, 0.01]]) {
      main.push(numRow(text, () => L[key] ?? 1, (v) => { L[key] = v; }, lo, hi, step, { int: key === "amount" }));
    }
    main.push(checkRow("loop", () => L.loop !== false, (v) => { L.loop = v; }));
    main.push(checkRow("local coords", () => !!L.local_coords, (v) => { L.local_coords = v; }, "Particles ride the emitter instead of staying where they were born"));
    main.push(numRow("spread deg", () => L.spread ?? 15, (v) => { L.spread = v; }, 0, 180, 0.5));
    if (Array.isArray(L.direction)) main.push(vec3Row("direction", () => L.direction, (v) => { L.direction = v; }, -1, 1, 0.01));
    if (Array.isArray(L.gravity)) main.push(vec3Row("gravity", () => L.gravity, (v) => { L.gravity = v; }, -20, 20, 0.1));
    main.push(colorRow("tint", () => L.color || "ffffff", (v) => { L.color = v; }, true));
    main.push(optionRow("mesh", MESHES, () => L.mesh || "card", (v) => { L.mesh = v; }));
    main.push(texRow("texture", () => L.texture, (v) => { if (v) L.texture = v; else delete L.texture; }));
    const rest = [];
    for (const g of GROUPS) {
      const d = L[g];
      if (!d || typeof d !== "object" || Array.isArray(d)) continue;
      rest.push(noteRow(g));
      for (const k of Object.keys(d)) {
        const v = d[k];
        if (typeof v === "number") rest.push(numRow("  " + k, () => d[k], (x) => { d[k] = INT_KEYS.includes(k) ? Math.round(x) : x; }, k === "min" || k === "max" ? -20 : Math.min(0, -Math.abs(v) * 3 - 1), k === "min" || k === "max" ? 20 : Math.max(Math.abs(v) * 3 + 1, 1), 0.01));
        else if (typeof v === "string" && k === "shape") rest.push(optionRow("  shape", ["point", "sphere", "sphere_surface", "box", "ring"], () => d.shape, (x) => { d.shape = x; }));
        else if (typeof v === "boolean") rest.push(checkRow("  " + k, () => d[k], (x) => { d[k] = x; }));
        else if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number")) rest.push(vec3Row("  " + k, () => d[k], (x) => { d[k] = x; }, -10, 10, 0.01));
      }
    }
    if (L.scale && Array.isArray(L.scale.curve)) rest.push(pairsRows(L.scale, "curve", "scale over life (0 = born, 1 = gone)", 0, 4));
    rest.push(rampRows(L, "color_ramp"));
    const mat = L.material || {};
    const matRows = [
      optionRow("blend", ["add", "mix"], () => mat.blend || "add", (v) => { (L.material ||= {}).blend = v; }),
      optionRow("material shader", ["", ...st.shaders], () => mat.shader || "", (v) => {
        const m2 = (L.material ||= {});
        if (!v) { delete m2.shader; delete m2.params; } else { m2.shader = v; m2.params = v === "rmt_fx" ? { particle_life: true } : {}; }
        render();
      }),
    ];
    if (mat.shader) { (L.material.params ||= {}); matRows.push(...uniformRows(info, L.material.params, false)); }
    return [section("PARTICLES", ...main), section("PARTICLES, THE REST", ...rest), section("MATERIAL", ...matRows)];
  }

  // ------------------------------------------------ the layer timeline (drag a bar to move it, its right end to cut it)
  const tl = h("canvas", { class: "fxtl" });
  const tg = tl.getContext("2d");
  let tdrag = null;
  const TL = { name: 90, row: 17, head: 18 };
  const tlGeom = () => {
    const w = tl.clientWidth, dur = st.end();
    return { w, dur, x: (t) => TL.name + (t / dur) * (w - TL.name - 6), t: (x) => ((x - TL.name) / (w - TL.name - 6)) * dur };
  };
  function drawTl() {
    if (!st.manifest) return;
    const ls = st.layers();
    const H = TL.head + ls.length * TL.row + 4, dpr = window.devicePixelRatio || 1;
    tl.style.height = H + "px";
    const W = tl.clientWidth || 300;
    if (tl.width !== Math.round(W * dpr) || tl.height !== Math.round(H * dpr)) { tl.width = Math.round(W * dpr); tl.height = Math.round(H * dpr); }
    tg.setTransform(dpr, 0, 0, dpr, 0, 0);
    const G = tlGeom();
    tg.fillStyle = "#16131a"; tg.fillRect(0, 0, W, H);
    tg.font = "11px Segoe UI, sans-serif"; tg.textBaseline = "middle";
    const stepS = [0.05, 0.1, 0.25, 0.5, 1].find((s) => (s / G.dur) * (W - TL.name) >= 36) || 1;
    for (let t = 0; t <= G.dur + 1e-6; t += stepS) { const x = G.x(t); tg.fillStyle = "#3a3342"; tg.fillRect(x, TL.head - 3, 1, H); tg.fillStyle = "#9a91a6"; tg.fillText(t.toFixed(2), x + 2, 8); }
    const d = st.duration();
    tg.fillStyle = "rgba(255,201,60,.55)"; tg.fillRect(G.x(d), 0, 1, H);
    ls.forEach((L, i) => {
      const y = TL.head + i * TL.row, sel = i === st.sel, off = st.solo ? st.solo !== L.name : st.mute.has(L.name);
      if (sel) { tg.fillStyle = "rgba(255,122,26,.14)"; tg.fillRect(0, y, W, TL.row); }
      tg.fillStyle = off ? "#6b6475" : sel ? "#fff" : "#f4efe6"; tg.fillText(L.name, 6, y + TL.row / 2, TL.name - 10);
      let [a, b] = layerSpan(L, st.manifest.phases, d);
      if (tdrag && tdrag.i === i) { if (tdrag.mode === "move") { a = tdrag.a0 + tdrag.dt; b = tdrag.b0 + tdrag.dt; } else b = Math.max(a + 0.02, tdrag.b0 + tdrag.dt); }
      const col = LAYER_COLORS[L.kind] || "#9a91a6";
      tg.globalAlpha = off ? 0.25 : 0.55; tg.fillStyle = col; tg.fillRect(G.x(a), y + 3, Math.max(3, G.x(b) - G.x(a)), TL.row - 6);
      tg.globalAlpha = 1; tg.strokeStyle = col; tg.strokeRect(G.x(a) + 0.5, y + 3.5, Math.max(3, G.x(b) - G.x(a)) - 1, TL.row - 7);
    });
    const px = G.x(st.time);
    tg.fillStyle = "#ff7a1a"; tg.fillRect(px - 1, 0, 2, H);
  }
  tl.addEventListener("pointerdown", (e) => {
    if (!st.manifest) return;
    const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, G = tlGeom();
    tl.setPointerCapture(e.pointerId);
    if (y < TL.head || x < TL.name) {
      const i = Math.floor((y - TL.head) / TL.row);
      if (x < TL.name && i >= 0 && i < st.layers().length) { st.select(i); return; }
      tdrag = { mode: "scrub" }; st.scrub(G.t(x)); return;
    }
    const i = Math.floor((y - TL.head) / TL.row);
    const L = st.layers()[i];
    if (!L) return;
    st.select(i);
    const [a, b] = layerSpan(L, st.manifest.phases, st.duration());
    tdrag = { mode: Math.abs(x - G.x(b)) < 6 ? "end" : x >= G.x(a) && x <= G.x(b) ? "move" : "scrub", i, a0: a, b0: b, x0: x, dt: 0 };
    if (tdrag.mode === "scrub") st.scrub(G.t(x));
  });
  tl.addEventListener("pointermove", (e) => {
    if (!tdrag) return;
    const r = tl.getBoundingClientRect(), x = e.clientX - r.left, G = tlGeom();
    if (tdrag.mode === "scrub") st.scrub(G.t(x));
    else { tdrag.dt = snap(G.t(x) - G.t(tdrag.x0), 0.01); drawTl(); }
  });
  tl.addEventListener("pointerup", () => {
    const d = tdrag;
    tdrag = null;
    if (d && d.mode === "move" && d.dt) st.setStart(d.i, Math.max(0, d.a0 + d.dt));
    else if (d && d.mode === "end" && d.dt) { st.layers()[d.i].end = Math.max(d.a0 + 0.02, d.b0 + d.dt); st.changed(true, true); render(); }
    drawTl();
  });

  // ------------------------------------------------ the pieces that stay (transport, layer list), the layer editor that rebuilds
  const title = h("div", { class: "fxtitle" });
  const statusEl = h("span", { class: "fxstat" });
  const pickId = h("select", { title: "Any effect block of the game's library" });
  pickId.onchange = () => { if (!st.dirty || confirm(`Discard the unsaved changes to ${st.id}?`)) st.open(pickId.value); else pickId.value = st.id; };
  const playBtn = button("PAUSE", () => { st.playing = !st.playing; if (st.playing && st.time >= st.end()) st.time = 0; app.emit("fxstudio_light"); });
  const loopChk = check("loop", true, (v) => { st.loop = v; });
  const spd = select(["0.1", "0.25", "0.5", "1", "2"], "1", (v) => { st.speed = Number(v); }, "Playback speed");
  const atSel = h("select", { title: "Where the preview plays: the floor at the feet, or a socket on the body (it follows the pose)" });
  atSel.onchange = () => { st.at = atSel.value; st.seekNow(); };
  const scrub = h("input", { type: "range", min: 0, max: 1, step: 0.005, value: 0, style: "flex:1" });
  scrub.oninput = () => st.scrub(Number(scrub.value));
  const tlabel = h("span", { class: "lbl", style: "width:90px" });
  const errEl = h("div", { class: "hint err" });
  const layerBox = h("div", { class: "fxlayers" });
  const editor = h("div", { class: "fxeditor" });
  const addSel = h("select", { title: "Add a layer" });
  addSel.append(new Option("+ layer", ""), ...KINDS.map((k) => new Option(k, k)));
  addSel.onchange = () => { if (addSel.value) st.addLayer(addSel.value); addSel.value = ""; };

  el.append(h("div", { class: "heading" }, "FX STUDIO"), h("div", { class: "row" }, pickId, statusEl),
    h("div", { class: "row" }, playBtn, button("REPLAY", () => st.replay(), "From the start"), loopChk, label("speed"), spd),
    h("div", { class: "row" }, label("play at"), atSel),
    h("div", { class: "row" }, scrub, tlabel), tl, errEl,
    h("div", { class: "row" },
      button("SAVE", () => st.save(), "Write a user override next to the shipped block (the way the Godot Effect Studio does)", "gold"),
      button("REVERT", async () => { if (!st.dirty && !(st.entry && st.entry.override)) return; if (await window.host.confirm(st.entry && st.entry.override && !st.dirty ? `Go back to the shipped ${st.id}? The override moves to the trash folder.` : `Throw away the unsaved changes to ${st.id}?`)) st.revert(); }, "Back to the shipped block (or the saved override)"),
      button("FIRE ON CLIP", () => st.fire(), "Put this block on the open clip at the playhead (save it first)"),
      button("SNAPSHOT", () => st.snapshot(), "A PNG of the window (the stage shows the effect)"),
      button("IN GODOT", async () => { const ok = await app.fx.openStudio(st.id); app.say(ok ? "The RMT Effect Studio opens on this block." : "Godot was not found (set FIGHT_STUDIO_GODOT).", ok ? "ok" : "warn"); }, "Edit the keyframed tracks, or ship the block, in the Godot Effect Studio")),
    h("div", { class: "row" }, label("LAYERS", "lbl bold"), addSel, button("COPY", () => st.duplicateLayer(), "Copy the selected layer"), button("DEL", () => st.removeLayer(), "Remove the selected layer"),
      button("▲", () => st.moveLayer(st.sel, -1), "Move up"), button("▼", () => st.moveLayer(st.sel, 1), "Move down")),
    layerBox, editor);

  function fillPicker() {
    const ids = st.ids;
    if (pickId.options.length !== ids.length) { pickId.replaceChildren(...ids.map((i) => new Option(i, i))); }
    if (st.id) pickId.value = st.id;
    const names = ["origin", ...Object.keys(app.sockSpecs || {}).sort()];
    if (atSel.options.length !== names.length) atSel.replaceChildren(...names.map((n) => new Option(n, n)));
    atSel.value = st.at;
  }

  function renderLayers() {
    layerBox.replaceChildren(...st.layers().map((L, i) => {
      const off = st.solo ? st.solo !== L.name : st.mute.has(L.name);
      const sp = layerSpan(L, st.manifest.phases, st.duration());
      return h("div", { class: "fxlayer" + (i === st.sel ? " sel" : "") + (off ? " off" : ""), onclick: () => st.select(i) },
        h("button", { class: "mini" + (st.mute.has(L.name) ? "" : " on"), title: "Show / hide in the preview (not saved)", onclick: (e) => { e.stopPropagation(); st.toggleMute(L.name); } }, st.mute.has(L.name) ? "○" : "●"),
        h("button", { class: "mini" + (st.solo === L.name ? " on" : ""), title: "Solo: show only this layer", onclick: (e) => { e.stopPropagation(); st.toggleSolo(L.name); } }, "S"),
        h("span", { class: "kindchip", style: `color:${LAYER_COLORS[L.kind] || "#9a91a6"}` }, L.kind),
        h("span", { class: "lname" }, L.name), h("span", { class: "lspan" }, `${sp[0].toFixed(2)}–${sp[1].toFixed(2)}s`));
    }));
  }

  async function renderEditor() {
    editor.replaceChildren();
    if (!st.manifest) { editor.append(hint("Pick an effect in the Library (Effects tab) or the list above.")); return; }
    const L = st.layer();
    const name = L ? (L.kind === "mesh" || L.kind === "aura" ? L.shader : L.kind === "particles" ? (L.material || {}).shader : "") : "";
    shaderFor = name || "";
    const info = name ? await st.shaderInfo(name) : null;
    if (shaderFor !== (name || "") || st.layer() !== L) return;   // another layer was picked while the shader loaded
    editor.replaceChildren(blockSection(st.manifest), ...(L ? layerSections(L, info) : [noteRow("Add a layer.")]));
  }

  function render() {
    fillPicker();
    statusEl.textContent = st.status();
    statusEl.className = "fxstat " + st.status();
    errEl.textContent = st.err ? "preview: " + st.err : "";
    playBtn.textContent = st.playing ? "PAUSE" : "PLAY";
    if (st.manifest) { renderLayers(); drawTl(); }
    renderEditor();
  }
  function light() {
    statusEl.textContent = st.status();
    statusEl.className = "fxstat " + st.status();
    errEl.textContent = st.err ? "preview: " + st.err : "";
    playBtn.textContent = st.playing ? "PAUSE" : "PLAY";
    if (st.manifest) { renderLayers(); drawTl(); }
  }
  function clock() {
    scrub.max = st.end();
    scrub.value = st.time;
    tlabel.textContent = `${st.time.toFixed(2)} / ${st.end().toFixed(2)} s`;
    if (st.manifest) drawTl();
  }
  app.on((w) => {
    if (w === "fxstudio") render();
    else if (w === "fxstudio_light") { light(); clock(); }
    else if (w === "fxtime") clock();
    else if (w === "mode" || w === "fighter") { st.syncVisible(); fillPicker(); }
  });
  setTimeout(render, 0);
  new ResizeObserver(() => drawTl()).observe(el);
  return el;
}
