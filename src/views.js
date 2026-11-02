// The canvas: views in a layout (1, 2, 3, quad, the four-angle strip, quad + strip), all drawn by one WebGL renderer through
// scissor regions, with the animator overlays on a 2D canvas on top. A ViewHost can also live in a pop-out window.
// Mouse: left = pick a joint (Shift adds) and drag it (Rotate: swing in the view, Move: slide the body, IK: pull it), drag a
// ring = turn about that axis only; right-drag orbit (or Alt + left), middle-drag pan (or Shift + right), wheel zoom,
// double-click a joint to frame it, the [ ] button (or `) maximizes a view.
import * as THREE from "three";
import * as R from "./core/rig.js";
import { DEG } from "./core/clip.js";

export const PRESETS = ["Persp", "Front", "Three-Q", "Side L", "Side R", "Back", "Top", "Follow"];
const ANG = { Persp: [0.62, 0.16], Front: [0, 0.04], "Three-Q": [0.7, 0.08], "Side L": [Math.PI / 2, 0.04], "Side R": [-Math.PI / 2, 0.04], Back: [Math.PI, 0.04], Top: [0, 1.45], Follow: [0.62, 0.16] };
export const STRIP_ANGLES = [["front", 0], ["three_q", 40], ["side", 90], ["back", 180]];
export const LAYOUTS = ["1", "2", "3", "4", "strip", "4+strip"];
const DEFAULTS = { 1: ["Persp"], 2: ["Front", "Side L"], 3: ["Persp", "Front", "Side L"], 4: ["Front", "Side L", "Three-Q", "Persp"], strip: [], "4+strip": ["Front", "Side L", "Three-Q", "Persp"] };
const AXIS_COL = ["#ff4d5e", "#6be36b", "#4d8dff"];
const WORLD_AX = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const C = { gold: "#ffc93c", accent: "#ff7a1a", left: "#4fd1ff", right: "#ff5d8f", muted: "#9a91a6", purple: "#a77bff", ok: "#5ce08a" };

class View {
  constructor(host, preset) {
    this.host = host;
    this.cam = new THREE.PerspectiveCamera(34, 1, 0.03, 400);
    this.ocam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.03, 400);
    this.rect = { x: 0, y: 0, w: 10, h: 10 };
    this.ortho = false;
    this.target = new THREE.Vector3(0, 0.9, 0);
    this.dist = 4.4;
    this.setPreset(preset);
  }

  camera() { return this.ortho ? this.ocam : this.cam; }

  setPreset(p) {
    this.preset = p;
    [this.yaw, this.pitch] = ANG[p] || ANG.Persp;
    this.frameBody();
    if (this.sel) this.sel.value = p;
  }

  frameBody() {
    const h = this.host.app.stage ? this.host.app.stage.height : 1.8;
    this.target.set(0, h * 0.5, 0);
    this.dist = this.preset === "Top" ? h * 3 : h * 2.8;
    this.update();
  }

  update() {
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const pos = this.target.clone().add(dir.multiplyScalar(this.ortho ? 30 : this.dist));
    const up = Math.abs(this.pitch) < 1.4 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const aspect = this.rect.w / Math.max(1, this.rect.h);
    for (const c of [this.cam, this.ocam]) {
      c.position.copy(pos);
      c.up.copy(up);
      c.lookAt(this.target);
    }
    this.cam.aspect = aspect;
    this.cam.updateProjectionMatrix();
    const hh = this.dist * 0.31;
    Object.assign(this.ocam, { left: -hh * aspect, right: hh * aspect, top: hh, bottom: -hh });
    this.ocam.updateProjectionMatrix();
    this.host.dirty();
  }

  // world -> host pixel (CSS px); z > 1 = behind
  project(p) {
    const v = p.clone().project(this.camera());
    return { x: this.rect.x + (v.x * 0.5 + 0.5) * this.rect.w, y: this.rect.y + (-v.y * 0.5 + 0.5) * this.rect.h, behind: v.z > 1 || v.z < -1 };
  }

  ray(x, y) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((x - this.rect.x) / this.rect.w) * 2 - 1, -(((y - this.rect.y) / this.rect.h) * 2 - 1)), this.camera());
    return rc.ray;
  }

  worldPerPx(p) {
    if (this.ortho) return (this.ocam.top - this.ocam.bottom) / this.rect.h;
    const fwd = new THREE.Vector3();
    this.cam.getWorldDirection(fwd);
    const d = Math.max(0.05, p.clone().sub(this.cam.position).dot(fwd));
    return (2 * d * Math.tan((this.cam.fov * Math.PI) / 360)) / this.rect.h;
  }

  ringPx() { return Math.min(62, Math.max(26, Math.min(this.rect.w, this.rect.h) * 0.16)); }

  planeHit(x, y, point) {
    const fwd = new THREE.Vector3();
    this.camera().getWorldDirection(fwd);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(fwd, point);
    const out = new THREE.Vector3();
    return this.ray(x, y).intersectPlane(plane, out) ? out : point.clone();
  }

  contains(x, y) { const r = this.rect; return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h; }
}

export class ViewHost {
  constructor(app, container, layout = "4", win = window) {
    this.app = app;
    this.win = win;
    this.el = container;
    const doc = container.ownerDocument;
    this.gl = doc.createElement("canvas");
    this.gl.className = "gl";
    this.ov = doc.createElement("canvas");
    this.ov.className = "ov";
    this.ov.tabIndex = 0;
    this.heads = doc.createElement("div");
    this.heads.className = "heads";
    container.append(this.gl, this.ov, this.heads);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.gl, antialias: true, preserveDrawingBuffer: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.autoClear = false;
    this.ctx = this.ov.getContext("2d");
    this.views = [];
    this.presets = {};
    this.renderScale = 1;
    this.stripCols = app.stripCols;
    this.aroundNow = false;
    this._dirty = true;
    this._stripDirty = true;
    this.drag = null;
    this.hover = -1;
    new win.ResizeObserver(() => this.resize()).observe(container);
    this._events();
    this.setLayout(layout);
  }

  dirty() { this._dirty = true; }
  stripDirty() { this._stripDirty = true; this._dirty = true; }

  setLayout(l) {
    if (!LAYOUTS.includes(l)) l = "4";
    if (this.layout) this.presets[this.layout] = this.views.map((v) => v.preset);
    this.layout = l;
    this.maximized = null;
    const ps = this.presets[l] || DEFAULTS[l];
    this.views = ps.map((p) => new View(this, p));
    this.focused = this.views[this.views.length - 1] || null;
    this._buildHeads();
    this.resize();
  }

  _buildHeads() {
    const doc = this.el.ownerDocument;
    this.heads.innerHTML = "";
    this.views.forEach((v) => {
      const h = doc.createElement("div");
      h.className = "vhead";
      const sel = doc.createElement("select");
      for (const p of PRESETS) sel.add(new Option(p, p));
      sel.value = v.preset;
      sel.onchange = () => v.setPreset(sel.value);
      const o = doc.createElement("button");
      o.textContent = "ORTHO";
      o.title = "Flat projection: measure poses against the grid";
      o.onclick = () => { v.ortho = !v.ortho; o.classList.toggle("on", v.ortho); v.update(); };
      const m = doc.createElement("button");
      m.textContent = "[ ]";
      m.title = "Maximize this view / back (also the ` key)";
      m.onclick = () => this.toggleMax(v);
      h.append(sel, o, m);
      v.sel = sel;
      v.head = h;
      this.heads.append(h);
    });
  }

  toggleMax(v) {
    this.maximized = this.maximized ? null : v;
    this.resize();
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (w < 2 || h < 2) return;
    const pr = (this.win.devicePixelRatio || 1) * this.renderScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.ov.width = Math.round(w * (this.win.devicePixelRatio || 1));
    this.ov.height = Math.round(h * (this.win.devicePixelRatio || 1));
    this.W = w;
    this.H = h;
    this._rects();
    this.stripDirty();
  }

  _rects() {
    const W = this.W, H = this.H, g = 3;
    const vs = this.views;
    this.strip = null;
    const set = (v, x, y, w, h) => { v.rect = { x, y, w, h }; v.update(); };
    if (this.maximized) {
      vs.forEach((v) => (v.hidden = v !== this.maximized));
      set(this.maximized, 0, 0, W, H);
    } else {
      vs.forEach((v) => (v.hidden = false));
      const quad = (x, y, w, h) => {
        const hw = (w - g) / 2, hh = (h - g) / 2;
        set(vs[0], x, y, hw, hh); set(vs[1], x + hw + g, y, hw, hh); set(vs[2], x, y + hh + g, hw, hh); set(vs[3], x + hw + g, y + hh + g, hw, hh);
      };
      switch (this.layout) {
        case "1": set(vs[0], 0, 0, W, H); break;
        case "2": set(vs[0], 0, 0, (W - g) / 2, H); set(vs[1], (W + g) / 2, 0, (W - g) / 2, H); break;
        case "3": { const big = W * 0.64; set(vs[0], 0, 0, big, H); set(vs[1], big + g, 0, W - big - g, (H - g) / 2); set(vs[2], big + g, (H + g) / 2, W - big - g, (H - g) / 2); break; }
        case "4": quad(0, 0, W, H); break;
        case "strip": this.strip = { x: 0, y: 0, w: W, h: H }; break;
        case "4+strip": { const sh = Math.max(200, H * 0.42); quad(0, 0, W, H - sh - g); this.strip = { x: 0, y: H - sh, w: W, h: sh }; break; }
      }
    }
    this.views.forEach((v) => {
      v.head.style.display = v.hidden ? "none" : "flex";
      v.head.style.left = v.rect.x + 6 + "px";
      v.head.style.top = v.rect.y + 6 + "px";
    });
  }

  frameAll() { this.views.forEach((v) => v.frameBody()); }

  // ---------------------------------------------------------------- render
  render(force = false) {
    const app = this.app;
    if (!app.stage || !app.stage.body) return;
    if (!this._dirty && !force) return;
    const r = this.renderer;
    const pr = r.getPixelRatio();
    const H = this.H;
    for (const v of this.views) {
      if (v.hidden) continue;
      if (v.preset === "Follow") {
        const hp = app.jointWorld("hips");
        v.target.lerp(new THREE.Vector3(hp.x, Math.max(hp.y, 0.6), hp.z), 0.25);
        v.update();
      }
      const rc = v.rect;
      r.setViewport(rc.x, H - rc.y - rc.h, rc.w, rc.h);
      r.setScissor(rc.x, H - rc.y - rc.h, rc.w, rc.h);
      r.setScissorTest(true);
      r.setClearColor(0x2a2430, 1);
      r.clear();
      r.render(app.stage.scene, v.camera());
    }
    if (this.strip && (this._stripDirty || this.aroundNow)) this._renderStrip(r, this.strip, H);
    this._stripDirty = false;
    this._dirty = false;
    r.setScissorTest(false);
    void pr;
    this.drawOverlay();
  }

  stripFrames(cols = this.stripCols) {
    const n = this.app.doc.frames;
    if (this.aroundNow) {
      const step = Math.max(1, Math.round(n / (cols * 2)));
      const start = this.app.frame - step * Math.floor(cols / 2);
      return [...Array(cols)].map((_, i) => Math.min(n, Math.max(0, start + step * i)));
    }
    return [...Array(cols)].map((_, i) => (n * i) / cols);
  }

  static LABEL_W = 70;
  static TOP_H = 40;

  // the four-angle review sheet into a rectangle of a renderer (also used for HD / 4K pictures)
  _renderStrip(r, rect, H, cols = this.stripCols) {
    const app = this.app;
    const st = app.stage;
    const cw = (rect.w - ViewHost.LABEL_W) / cols, ch = (rect.h - ViewHost.TOP_H) / STRIP_ANGLES.length;
    r.setScissorTest(true);
    r.setViewport(rect.x, H - rect.y - rect.h, rect.w, rect.h);
    r.setScissor(rect.x, H - rect.y - rect.h, rect.w, rect.h);
    r.setClearColor(0x0d0b0f, 1);
    r.clear();
    const cam = new THREE.PerspectiveCamera(34, cw / ch, 0.03, 400);
    const fs = this.stripFrames(cols);
    const scale = st.height / 1.8;
    fs.forEach((f, ci) => {
      app.finalPoseOn(st.stripBody, f);
      st.stripModel.position.set(0, 0, 0);
      if (app.show.wrap) app.matchFinish(st.stripBody, app.wrapCarry(f));   // as the match shows that frame
      if (app.fx) app.fx.showStrip(f);   // the clip's effects at that frame
      const c = new THREE.Vector3(0, 0.85 * scale, 0);
      if (app.stripFollow) { const hp = st.stripBody.worldPos("hips"); c.x = hp.x; c.z = hp.z; }
      STRIP_ANGLES.forEach(([, deg], ri) => {
        const yaw = (deg * Math.PI) / 180;
        cam.position.copy(c).add(new THREE.Vector3(Math.sin(yaw), 0.12, Math.cos(yaw)).multiplyScalar(4.4 * scale));
        cam.lookAt(c);
        const x = rect.x + ViewHost.LABEL_W + ci * cw, y = rect.y + ViewHost.TOP_H + ri * ch;
        r.setViewport(x, H - y - ch + 1, cw - 2, ch - 2);
        r.setScissor(x, H - y - ch + 1, cw - 2, ch - 2);
        r.render(st.stripScene, cam);
      });
    });
    this._stripLabels = { rect, fs, cw, ch };
  }

  // ---------------------------------------------------------------- overlay
  drawOverlay() {
    const g = this.ctx, app = this.app;
    const dpr = this.win.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    if (this.strip && this._stripLabels) this._stripText(g, this._stripLabels);
    const joints = this._joints();
    for (const v of this.views) {
      if (v.hidden) continue;
      g.save();
      g.beginPath();
      g.rect(v.rect.x, v.rect.y, v.rect.w, v.rect.h);
      g.clip();
      this._drawView(g, v, joints);
      g.restore();
      g.strokeStyle = this.focused === v ? "rgba(255,122,26,0.55)" : "rgba(58,51,66,0.9)";
      g.lineWidth = 1;
      g.strokeRect(v.rect.x + 0.5, v.rect.y + 0.5, v.rect.w - 1, v.rect.h - 1);
    }
  }

  _stripText(g, s) {
    const app = this.app;
    g.font = "13px Inter, Segoe UI, sans-serif";
    g.fillStyle = C.gold;
    g.fillText(`${app.fighter}  ${app.doc.name}`, s.rect.x + 6, s.rect.y + 16);
    STRIP_ANGLES.forEach(([name], ri) => {
      g.fillStyle = "#f4efe6";
      g.fillText(name, s.rect.x + 6, s.rect.y + ViewHost.TOP_H + ri * s.ch + s.ch / 2);
    });
    s.fs.forEach((f, ci) => {
      const fr = Math.round(f);
      const key = app.doc.hasKey(fr) && Math.abs(f - fr) < 0.01;
      const x = s.rect.x + ViewHost.LABEL_W + ci * s.cw;
      g.fillStyle = key ? C.gold : "#b3a9bf";
      g.font = "12px Inter, Segoe UI, sans-serif";
      g.fillText(`f ${fr}${key ? "  KEY" : ""}`, x + 4, s.rect.y + 34);
      if (Math.abs(f - app.frame) < 0.5) {
        g.strokeStyle = C.accent;
        g.lineWidth = 2;
        g.strokeRect(x, s.rect.y + ViewHost.TOP_H - 2, s.cw - 2, s.ch * 4 + 2);
      }
    });
  }

  _joints() {
    const app = this.app, body = app.stage.body;
    const conBones = new Set();
    for (const c of app.doc.constraints) {
      if (c.enabled === false) continue;
      if (c.limb) (R.LIMBS[c.limb] || []).forEach((b) => conBones.add(b));
      if (c.bone) conBones.add(c.bone);
    }
    const selGroup = app.v5 ? app.v5.groupOf(app.selBone) : R.groupOf(app.selBone);
    const out = [];
    for (const n of app.visibleBones()) {
      if (n === "root" || n.startsWith("nail")) continue;
      const pos = body.worldPos(n);
      const kids = body.children(n);
      let tip;
      if (kids.length) tip = body.worldPos(kids[0]);
      else {
        const p = body.parentName(n);
        const pp = p ? body.worldPos(p) : pos.clone().add(new THREE.Vector3(0, -0.1, 0));
        tip = pos.clone().add(pos.clone().sub(pp).normalize().multiplyScalar(Math.min(0.08, pos.distanceTo(pp) * 0.6)));
      }
      const side = app.boneSide ? app.boneSide(n) : R.sideOf(n), grp = app.v5 ? app.v5.groupOf(n) : R.groupOf(n);
      let shown = true;
      if ((grp === "Hand L" || grp === "Hand R") && !app.show.fingers && !(app.v5 && app.boneTier === "advanced")) shown = selGroup === grp || ["fingersL", "fingersR", "thumbL", "thumbR"].includes(n);
      const locked = app.doc.isLocked(n);
      out.push({ n, pos, tip, color: locked ? C.muted : side === "L" ? C.left : side === "R" ? C.right : C.gold, sel: app.selBones.includes(n), locked, ik: conBones.has(n), shown });
    }
    return out;
  }

  _drawView(g, v, joints) {
    const app = this.app;
    const P = (p) => v.project(p);
    // trail
    if (app.show.trail) {
      const tr = app.trail();
      g.strokeStyle = "rgba(255,201,60,0.55)";
      g.lineWidth = 1.5;
      g.beginPath();
      tr.forEach((p, i) => { const s = P(p); if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y); });
      g.stroke();
      g.fillStyle = C.gold;
      for (const k of app.doc.keys) if (k.f < tr.length) { const s = P(tr[k.f]); g.beginPath(); g.arc(s.x, s.y, 3.5, 0, Math.PI * 2); g.fill(); }
      const cf = Math.round(app.frame);
      if (cf < tr.length) { const s = P(tr[cf]); g.strokeStyle = "#fff"; g.beginPath(); g.arc(s.x, s.y, 6, 0, Math.PI * 2); g.stroke(); }
    }
    // bones
    if (app.show.bones) {
      for (const j of joints) {
        if (!j.shown) continue;
        const a = P(j.pos), b = P(j.tip);
        if (a.behind) continue;
        g.lineCap = "round";
        g.strokeStyle = "rgba(0,0,0,0.55)";
        g.lineWidth = j.sel ? 5 : 4;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
        g.strokeStyle = j.sel ? "#fff" : j.color;
        g.lineWidth = j.sel ? 3 : 2;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      }
      for (const j of joints) {
        if (!j.shown) continue;
        const a = P(j.pos);
        if (a.behind) continue;
        const r = j.sel ? 5.5 : 3.8;
        g.fillStyle = "rgba(0,0,0,0.6)";
        g.beginPath(); g.arc(a.x, a.y, r + 1.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = j.sel ? "#fff" : j.color;
        g.beginPath(); g.arc(a.x, a.y, r, 0, Math.PI * 2); g.fill();
        if (j.ik) { g.strokeStyle = C.purple; g.lineWidth = 1.6; g.strokeRect(a.x - 8, a.y - 8, 16, 16); }
        if (j.locked) { g.fillStyle = C.muted; g.fillRect(a.x + 5, a.y - 10, 7, 6); }
        if (j.sel && app.show.labels) { g.fillStyle = "#fff"; g.font = "13px Inter, Segoe UI, sans-serif"; g.fillText(j.n, a.x + 9, a.y - 8); }
      }
    }
    if (app.tool === "ik") for (const j of joints) if (R.limbOfEnd(j.n)) { const a = P(j.pos); g.strokeStyle = C.accent; g.lineWidth = 2; g.strokeRect(a.x - 9, a.y - 9, 18, 18); }
    // constraint targets
    for (const t of app.overlayTargets()) {
      const a = P(t.pos);
      if (a.behind) continue;
      g.strokeStyle = t.color;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(a.x - 9, a.y); g.lineTo(a.x + 9, a.y); g.moveTo(a.x, a.y - 9); g.lineTo(a.x, a.y + 9); g.stroke();
      g.beginPath(); g.arc(a.x, a.y, 6, 0, Math.PI * 2); g.stroke();
      g.fillStyle = t.color; g.font = "11px Inter, Segoe UI, sans-serif"; g.fillText(t.label, a.x + 9, a.y + 14);
    }
    if (app.show.sockets) for (const n in app.sockSpecs) {
      const a = P(app.socketWorld(n));
      if (a.behind) continue;
      g.fillStyle = n === app.selSocket ? "#fff" : "#ff4fe6";
      g.beginPath(); g.moveTo(a.x, a.y - 5); g.lineTo(a.x + 5, a.y); g.lineTo(a.x, a.y + 5); g.lineTo(a.x - 5, a.y); g.fill();
      g.font = "11px Inter, Segoe UI, sans-serif"; g.fillText(n, a.x + 7, a.y + 4);
    }
    this._drawGizmo(g, v);
    // axes corner
    const o = { x: v.rect.x + v.rect.w - 34, y: v.rect.y + 40 };
    const cam = v.camera();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    WORLD_AX.forEach((w, i) => {
      const dx = w.dot(right) * 20, dy = -w.dot(up) * 20;
      g.strokeStyle = AXIS_COL[i]; g.lineWidth = 2;
      g.beginPath(); g.moveTo(o.x, o.y); g.lineTo(o.x + dx, o.y + dy); g.stroke();
      g.fillStyle = AXIS_COL[i]; g.font = "11px Inter, sans-serif"; g.fillText("XYZ"[i], o.x + dx * 1.25 - 4, o.y + dy * 1.25 + 4);
    });
    const info = `${v.preset.toUpperCase()}   f ${Math.round(app.frame)} / ${app.doc.frames}`;
    g.font = "12px Inter, Segoe UI, sans-serif";
    const iw = g.measureText(info).width;
    g.fillStyle = "rgba(13,11,15,0.7)";
    g.fillRect(v.rect.x + 6, v.rect.y + v.rect.h - 24, iw + 10, 18);
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.fillText(info, v.rect.x + 11, v.rect.y + v.rect.h - 10);
    if (app.agentFlash > 0) {
      g.strokeStyle = `rgba(167,123,255,${app.agentFlash * 0.8})`;
      g.lineWidth = 3;
      g.strokeRect(v.rect.x + 2, v.rect.y + 2, v.rect.w - 4, v.rect.h - 4);
      g.fillStyle = C.purple;
      g.fillText("AGENT EDITING", v.rect.x + v.rect.w - 120, v.rect.y + v.rect.h - 10);
    }
  }

  gizmoAxis(bone, h) {
    if (this.app.spaceGlobal) return WORLD_AX[h].clone();
    const q = this.app.stage.body.worldQuat(bone);
    return WORLD_AX[h].clone().applyQuaternion(q).normalize();
  }

  static ringBasis(a) {
    let u = a.clone().cross(new THREE.Vector3(0, 1, 0));
    if (u.length() < 0.1) u = a.clone().cross(new THREE.Vector3(1, 0, 0));
    u.normalize();
    return [u, a.clone().cross(u).normalize()];
  }

  _gizmoOn() {
    const app = this.app;
    return app.selBone && (app.tool === "rotate" || (app.tool === "move" && app.selBone === "hips"));
  }

  _drawGizmo(g, v) {
    const app = this.app;
    if (!this._gizmoOn()) return;
    const c = app.jointWorld(app.selBone);
    const cs = v.project(c);
    if (cs.behind) return;
    const r = v.ringPx() * v.worldPerPx(c);
    const active = this.drag && this.drag.view === v ? this.drag.axis : this.hover;
    if (app.tool === "move") {
      WORLD_AX.forEach((ax, h) => {
        const tip = v.project(c.clone().add(ax.clone().multiplyScalar(r)));
        g.strokeStyle = h === active ? "#fff" : AXIS_COL[h];
        g.lineWidth = 2.5;
        g.beginPath(); g.moveTo(cs.x, cs.y); g.lineTo(tip.x, tip.y); g.stroke();
        const d = { x: tip.x - cs.x, y: tip.y - cs.y }, l = Math.hypot(d.x, d.y) || 1;
        const ux = d.x / l, uy = d.y / l;
        g.fillStyle = g.strokeStyle;
        g.beginPath(); g.moveTo(tip.x + ux * 10, tip.y + uy * 10); g.lineTo(tip.x - uy * 5, tip.y + ux * 5); g.lineTo(tip.x + uy * 5, tip.y - ux * 5); g.fill();
      });
      return;
    }
    const campos = v.camera().position;
    for (let h = 0; h < 3; h++) {
      const [u, w] = ViewHost.ringBasis(this.gizmoAxis(app.selBone, h));
      let prev = null, prevFront = true;
      for (let i = 0; i <= 48; i++) {
        const t = (Math.PI * 2 * i) / 48;
        const wp = c.clone().add(u.clone().multiplyScalar(Math.cos(t) * r)).add(w.clone().multiplyScalar(Math.sin(t) * r));
        const sp = v.project(wp);
        const front = wp.clone().sub(c).dot(campos.clone().sub(c)) >= -1e-4;
        if (prev) {
          g.strokeStyle = h === active ? "#fff" : AXIS_COL[h];
          g.globalAlpha = front && prevFront ? 1 : 0.28;
          g.lineWidth = front ? 2.2 : 1.2;
          g.beginPath(); g.moveTo(prev.x, prev.y); g.lineTo(sp.x, sp.y); g.stroke();
        }
        prev = sp;
        prevFront = front;
      }
      g.globalAlpha = 1;
    }
    g.strokeStyle = active === 3 ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.35)";
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(cs.x, cs.y, v.ringPx() * 1.22, 0, Math.PI * 2); g.stroke();
  }

  // ---------------------------------------------------------------- input
  viewAt(x, y) { return this.views.find((v) => !v.hidden && v.contains(x, y)) || null; }

  _hitGizmo(v, x, y) {
    const app = this.app;
    if (!this._gizmoOn()) return -1;
    const c = app.jointWorld(app.selBone);
    const cs = v.project(c);
    if (cs.behind) return -1;
    const r = v.ringPx() * v.worldPerPx(c);
    const segDist = (p, a, b) => {
      const abx = b.x - a.x, aby = b.y - a.y, l2 = abx * abx + aby * aby;
      const t = l2 < 1e-6 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2));
      return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
    };
    const p = { x, y };
    if (app.tool === "move") {
      for (let h = 0; h < 3; h++) if (segDist(p, cs, v.project(c.clone().add(WORLD_AX[h].clone().multiplyScalar(r)))) < 9) return h;
      return -1;
    }
    let best = -1, bd = 8;
    for (let h = 0; h < 3; h++) {
      const [u, w] = ViewHost.ringBasis(this.gizmoAxis(app.selBone, h));
      let prev = null;
      for (let i = 0; i <= 48; i++) {
        const t = (Math.PI * 2 * i) / 48;
        const sp = v.project(c.clone().add(u.clone().multiplyScalar(Math.cos(t) * r)).add(w.clone().multiplyScalar(Math.sin(t) * r)));
        if (prev) { const d = segDist(p, prev, sp); if (d < bd) { bd = d; best = h; } }
        prev = sp;
      }
    }
    if (best >= 0) return best;
    if (Math.abs(Math.hypot(x - cs.x, y - cs.y) - v.ringPx() * 1.22) < 7) return 3;
    return -1;
  }

  _pick(v, x, y) {
    const joints = this._joints();
    let best = "", bd = 13;
    for (const j of joints) {
      if (!j.shown) continue;
      const s = v.project(j.pos);
      if (s.behind) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = j.n; }
    }
    if (best) return best;
    bd = 9;
    for (const j of joints) {
      if (!j.shown) continue;
      const a = v.project(j.pos), b = v.project(j.tip);
      const abx = b.x - a.x, aby = b.y - a.y, l2 = abx * abx + aby * aby;
      const t = l2 < 1 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby) / l2));
      const d = Math.hypot(x - (a.x + abx * t), y - (a.y + aby * t));
      if (d < bd) { bd = d; best = j.n; }
    }
    return best;
  }

  _events() {
    const ov = this.ov;
    const pos = (e) => ({ x: e.offsetX, y: e.offsetY });
    ov.addEventListener("contextmenu", (e) => e.preventDefault());
    ov.addEventListener("wheel", (e) => {
      const p = pos(e);
      const v = this.viewAt(p.x, p.y);
      if (!v) return;
      e.preventDefault();
      v.dist = Math.min(60, Math.max(0.25, v.dist * (e.deltaY < 0 ? 0.9 : 1.1)));
      v.update();
      this.drawOverlay();
    }, { passive: false });
    ov.addEventListener("dblclick", (e) => {
      const p = pos(e);
      const v = this.viewAt(p.x, p.y);
      if (!v) return;
      const b = this._pick(v, p.x, p.y);
      if (b) { v.target.copy(this.app.jointWorld(b)); v.dist = 1.1; v.update(); }
    });
    ov.addEventListener("pointerdown", (e) => {
      ov.focus();
      const p = pos(e);
      if (this.strip && p.y >= this.strip.y && this._stripLabels) {
        const s = this._stripLabels;
        const ci = Math.floor((p.x - this.strip.x - ViewHost.LABEL_W) / s.cw);
        if (ci >= 0 && ci < s.fs.length) this.app.setFrame(s.fs[ci]);
        return;
      }
      const v = this.viewAt(p.x, p.y);
      if (!v) return;
      this.focused = v;
      ov.setPointerCapture(e.pointerId);
      const app = this.app;
      this.drag = { view: v, press: p, last: p, mode: "", axis: -1 };
      if (e.button === 2) this.drag.mode = e.shiftKey ? "pan" : "orbit";
      else if (e.button === 1) this.drag.mode = "pan";
      else if (e.button === 0) {
        if (e.altKey) this.drag.mode = "orbit";
        else {
          const h = app.selBone ? this._hitGizmo(v, p.x, p.y) : -1;
          if (h >= 0) this._beginGizmo(v, h, p);
          else {
            const b = this._pick(v, p.x, p.y);
            if (b) {
              app.selectBone(b, e.shiftKey);
              this.drag.bone = b;
              this.drag.mode = app.tool !== "select" ? "maybe" : "";
            }
          }
        }
      }
      this.drawOverlay();
    });
    ov.addEventListener("pointermove", (e) => {
      const p = pos(e);
      const d = this.drag;
      const app = this.app;
      if (!d) {
        const v = this.viewAt(p.x, p.y);
        const h = v ? this._hitGizmo(v, p.x, p.y) : -1;
        if (h !== this.hover) { this.hover = h; this.drawOverlay(); }
        return;
      }
      const v = d.view;
      const dx = p.x - d.last.x, dy = p.y - d.last.y;
      d.last = p;
      switch (d.mode) {
        case "orbit":
          v.yaw -= dx * 0.008;
          v.pitch = Math.max(-1.45, Math.min(1.52, v.pitch + dy * 0.008));
          if (v.preset !== "Persp" && v.preset !== "Follow") { v.preset = "Persp"; v.sel.value = "Persp"; }
          v.update();
          break;
        case "pan": {
          const k = v.worldPerPx(v.target);
          const cam = v.camera();
          const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
          v.target.add(right.multiplyScalar(-dx * k)).add(up.multiplyScalar(dy * k));
          v.update();
          break;
        }
        case "maybe":
          if (Math.hypot(p.x - d.press.x, p.y - d.press.y) > 4) this._startToolDrag(d, p);
          break;
        case "ring": {
          const ang = ((p.x - d.press.x) * d.tangent.x + (p.y - d.press.y) * d.tangent.y) / Math.max(1e-3, d.pxPerUnit);
          app.dragRotate(d.bone, d.axisWorld, ang);
          break;
        }
        case "swing":
        case "view_ring": {
          const c = v.project(app.jointWorld(d.bone));
          const a0 = Math.atan2(d.press.y - c.y, d.press.x - c.x), a1 = Math.atan2(p.y - c.y, p.x - c.x);
          let da = a1 - a0;
          da = Math.atan2(Math.sin(da), Math.cos(da));
          const toward = new THREE.Vector3();
          v.camera().getWorldDirection(toward);
          app.dragRotate(d.bone, toward.negate(), -da);
          break;
        }
        case "move_axis": {
          const s = ((p.x - d.press.x) * d.tangent.x + (p.y - d.press.y) * d.tangent.y) / Math.max(1e-3, d.pxPerUnit);
          app.dragMove(d.axisWorld.clone().multiplyScalar(s));
          break;
        }
        case "move_free":
          app.dragMove(v.planeHit(p.x, p.y, d.plane).sub(v.planeHit(d.press.x, d.press.y, d.plane)));
          break;
        case "ik":
          app.dragIK(d.bone, v.planeHit(p.x, p.y, d.plane));
          break;
      }
      this.drawOverlay();
    });
    const up = () => {
      const d = this.drag;
      if (d && ["ring", "view_ring", "swing", "move_axis", "move_free", "ik"].includes(d.mode)) this.app.dragEnd();
      this.drag = null;
      this.drawOverlay();
    };
    ov.addEventListener("pointerup", up);
    ov.addEventListener("pointercancel", up);
  }

  _startToolDrag(d, p) {
    const app = this.app;
    if (app.isBoneLocked(d.bone)) { app.say(`${d.bone} is locked.`, "warn"); d.mode = ""; return; }
    d.plane = app.jointWorld(d.bone);
    d.press = p;
    if (app.tool === "rotate") { d.mode = "swing"; app.dragBegin("Turn " + d.bone); }
    else if (app.tool === "move") { d.mode = "move_free"; app.dragBegin("Move body"); }
    else if (app.tool === "ik") { d.mode = "ik"; app.dragBegin("IK " + d.bone); }
    else d.mode = "";
  }

  _beginGizmo(v, h, p) {
    const app = this.app, d = this.drag;
    const bone = app.selBone;
    d.bone = bone;
    d.axis = h;
    const c = app.jointWorld(bone);
    const r = v.ringPx() * v.worldPerPx(c);
    if (app.tool === "move") {
      d.axisWorld = WORLD_AX[h].clone();
      const tip = v.project(c.clone().add(d.axisWorld.clone().multiplyScalar(r))), base = v.project(c);
      const l = Math.hypot(tip.x - base.x, tip.y - base.y) || 1;
      d.tangent = { x: (tip.x - base.x) / l, y: (tip.y - base.y) / l };
      d.pxPerUnit = l / r;
      d.mode = "move_axis";
      app.dragBegin("Move body");
      return;
    }
    if (h === 3) { d.mode = "view_ring"; app.dragBegin("Turn " + bone); return; }
    d.axisWorld = this.gizmoAxis(bone, h);
    const [u, w] = ViewHost.ringBasis(d.axisWorld);
    let bt = 0, bd = Infinity;
    for (let i = 0; i < 64; i++) {
      const t = (Math.PI * 2 * i) / 64;
      const sp = v.project(c.clone().add(u.clone().multiplyScalar(Math.cos(t) * r)).add(w.clone().multiplyScalar(Math.sin(t) * r)));
      const dd = Math.hypot(sp.x - p.x, sp.y - p.y);
      if (dd < bd) { bd = dd; bt = t; }
    }
    const at = (t) => v.project(c.clone().add(u.clone().multiplyScalar(Math.cos(t) * r)).add(w.clone().multiplyScalar(Math.sin(t) * r)));
    const p0 = at(bt), p1 = at(bt + 0.02);
    const tv = { x: (p1.x - p0.x) / 0.02, y: (p1.y - p0.y) / 0.02 };
    d.pxPerUnit = Math.max(8, Math.hypot(tv.x, tv.y));
    d.tangent = { x: tv.x / d.pxPerUnit, y: tv.y / d.pxPerUnit };
    d.mode = "ring";
    app.dragBegin(`Turn ${bone} ${"XYZ"[h]}`);
  }
}

// ---------------------------------------------------------------- pictures at any size (HD / 4K), for the Render panel and agents
export async function renderPicture(app, host, kind, w, h, cols = 8) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(w, h, false);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.autoClear = false;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const g = out.getContext("2d");
  if (kind === "sheet") {
    const fake = Object.create(ViewHost.prototype);
    Object.assign(fake, { app, stripCols: cols, aroundNow: false });
    fake._renderStrip(r, { x: 0, y: 0, w, h }, h, cols);
    g.drawImage(canvas, 0, 0);
    ViewHost.prototype._stripText.call(fake, g, fake._stripLabels);
  } else {
    const v = (host && host.focused) || (host && host.views[0]);
    const cam = v ? v.camera().clone() : new THREE.PerspectiveCamera(34, w / h, 0.03, 400);
    if (cam.isPerspectiveCamera) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
    else { const hh = (cam.top - cam.bottom) / 2; cam.left = -hh * (w / h); cam.right = hh * (w / h); cam.updateProjectionMatrix(); }
    r.setClearColor(0x2a2430, 1);
    r.clear();
    r.render(app.stage.scene, cam);
    g.drawImage(canvas, 0, 0);
  }
  r.dispose();
  return out.toDataURL("image/png").split(",")[1];
}

export { DEG };
