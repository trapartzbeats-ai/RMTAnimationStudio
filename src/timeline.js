// Dope sheet and graph editor on 2D canvases (the same behaviour as the Godot Animator's).
// Dope: ruler (scrub; markers, hit / clear marks), ALL KEYS (drag to retime, ease bars, purple arcs = linked keys), layer and
// constraint ranges, a row per bone grouped by body part. Click / Shift-click keys, drag empty rows to box-select, right-click
// for ease, type, link, lock, copy / paste, delete. Ctrl + wheel zooms time, middle-drag pans, wheel scrolls.
// Graph: the selected bone's X / Y / Z in degrees (or the hips shift in cm); drag a key point up / down to change it.
import * as R from "./core/rig.js";
import { EASES, TAGS } from "./core/doc.js";
import { DEG, RAD } from "./core/clip.js";

const C = { bg0: "#0d0b0f", bg1: "#16131a", bg2: "#1f1a24", bg3: "#2a2430", line: "#3a3342", text: "#f4efe6", muted: "#9a91a6", accent: "#ff7a1a",
  gold: "#ffc93c", left: "#4fd1ff", right: "#ff5d8f", ok: "#5ce08a", purple: "#a77bff", red: "#ff4d4d", fx: "#3ee0c1" };
const AX = ["#ff4d5e", "#6be36b", "#4d8dff"];
const EASE_COL = { linear: C.muted, in: C.accent, out: C.left, inout: C.ok, hold: C.red, spline: C.purple };
const FONT = "12px Inter, Segoe UI, sans-serif";

function setupCanvas(el) {
  const cv = el.ownerDocument.createElement("canvas");
  cv.tabIndex = 0;
  cv.style.cssText = "width:100%;height:100%;display:block;outline:none";
  el.append(cv);
  return cv;
}

class CanvasPanel {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.cv = setupCanvas(el);
    this.g = this.cv.getContext("2d");
    this.w = 10;
    this.h = 10;
    new (el.ownerDocument.defaultView.ResizeObserver)(() => this.resize()).observe(el);
    app.on((w) => { if (w !== "status" && w !== "api") this.draw(); });
    this.cv.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  resize() {
    const dpr = this.el.ownerDocument.defaultView.devicePixelRatio || 1;
    this.w = this.el.clientWidth;
    this.h = this.el.clientHeight;
    this.cv.width = Math.max(1, Math.round(this.w * dpr));
    this.cv.height = Math.max(1, Math.round(this.h * dpr));
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.onResize && this.onResize();
    this.draw();
  }
}

function diamond(g, x, y, r, fill, stroke) {
  g.beginPath();
  g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath();
  g.fillStyle = fill; g.fill();
  g.strokeStyle = stroke; g.lineWidth = 1.2; g.stroke();
}

export class Dope extends CanvasPanel {
  static NAME_W = 168;
  static RULER_H = 30;
  static ROW_H = 21;

  constructor(app, el, menu) {
    super(app, el);
    this.menu = menu;
    this.x0 = -1;
    this.ppf = 14;
    this.scroll = 0;
    this.collapsed = { "Hand L": true, "Hand R": true, Ears: true, Extras: true };
    this.userZoom = false;
    this.drag = null;
    this._events();
  }

  onResize() { if (!this.userZoom) this.fit(); }
  fit() { this.ppf = Math.min(60, Math.max(2, (this.w - Dope.NAME_W - 30) / Math.max(1, this.app.doc.frames))); this.x0 = -1; }
  f2x(f) { return Dope.NAME_W + (f - this.x0) * this.ppf; }
  x2f(x) { return (x - Dope.NAME_W) / this.ppf + this.x0; }

  rows() {
    const app = this.app, out = [];
    let y = Dope.RULER_H - this.scroll;
    const push = (r) => { r.y = y; out.push(r); y += Dope.ROW_H; };
    push({ kind: "summary", label: "ALL KEYS" });
    this._fx = app.fx ? app.fx.list() : [];
    if (this._fx.length) {
      push({ kind: "fxhead", label: `EFFECTS  ${this._fx.length}` });
      if (!this.collapsed.__fx) this._fx.forEach((d, i) => push({ kind: "fx", idx: i, label: `${d.id} @ ${d.socket}` }));
    }
    for (const l of app.doc.layers) push({ kind: "layer", label: "layer  " + l.name, id: l.id });
    for (const c of app.doc.constraints) push({ kind: "con", label: c.name || c.type, id: c.id });
    for (const [gname, list] of R.grouped(app.bones)) {
      push({ kind: "group", label: gname, group: gname });
      if (this.collapsed[gname]) continue;
      for (const b of list) push({ kind: "bone", label: b, bone: b });
    }
    return out;
  }

  shift(f) { return this.drag && this.drag.mode === "move" && this.app.selKeys.includes(f) ? this.drag.delta : 0; }

  draw() {
    const g = this.g, app = this.app, W = this.w, H = this.h;
    if (!app.doc) return;
    if (!this.userZoom && this._lastFrames !== app.doc.frames) { this._lastFrames = app.doc.frames; this.fit(); }
    const n = app.doc.frames, RH = Dope.ROW_H;
    this._rows = this.rows();
    g.fillStyle = C.bg0; g.fillRect(0, 0, W, H);
    g.fillStyle = C.bg1; g.fillRect(this.f2x(0), Dope.RULER_H, n * this.ppf, H);
    g.font = FONT;
    for (const r of this._rows) {
      if (r.y < Dope.RULER_H - RH || r.y > H) continue;
      if (r.kind === "summary" || r.kind === "group" || r.kind === "fxhead") { g.fillStyle = C.bg2; g.fillRect(0, r.y, W, RH - 1); }
      if (r.kind === "bone" && app.selBones.includes(r.bone)) { g.fillStyle = "rgba(255,122,26,0.12)"; g.fillRect(0, r.y, W, RH - 1); }
      g.fillStyle = "rgba(58,51,66,0.35)"; g.fillRect(0, r.y + RH - 1, W, 1);
    }
    const step = [1, 2, 5, 10, 20, 50, 100].find((s) => s * this.ppf >= 9) || 200;
    for (let f = Math.floor(this.x0 / step) * step; this.f2x(f) < W; f += step) {
      if (f < 0) continue;
      g.fillStyle = f % (step * 5) ? "rgba(58,51,66,0.25)" : "rgba(58,51,66,0.55)";
      g.fillRect(this.f2x(f), Dope.RULER_H, 1, H);
    }
    for (const r of this._rows) {
      if (r.y < Dope.RULER_H - RH || r.y > H) continue;
      const cy = r.y + RH / 2;
      if (r.kind === "summary") this._summary(g, cy);
      else if (r.kind === "bone") this._boneRow(g, r.bone, cy);
      else if (r.kind === "layer") this._layerRow(g, app.doc.layerById(r.id), r.y, cy);
      else if (r.kind === "con") this._conRow(g, app.doc.constraintById(r.id), r.y);
      else if (r.kind === "fx") this._fxRow(g, r);
    }
    if (this.drag && this.drag.mode === "box") {
      const b = this.drag.box;
      g.fillStyle = "rgba(255,122,26,0.12)"; g.fillRect(b.x, b.y, b.w, b.h);
      g.strokeStyle = C.accent; g.strokeRect(b.x, b.y, b.w, b.h);
    }
    g.fillStyle = C.bg1; g.fillRect(0, Dope.RULER_H, Dope.NAME_W, H);
    for (const r of this._rows) {
      if (r.y < Dope.RULER_H - RH || r.y > H) continue;
      let col = C.text, x = 10, label = r.label;
      if (r.kind === "group") { col = C.gold; label = (this.collapsed[r.group] ? "+ " : "- ") + label; }
      else if (r.kind === "bone") {
        x = 22;
        const side = R.sideOf(r.bone);
        col = side === "L" ? C.left : side === "R" ? C.right : C.text;
        if (r.bone === app.selBone) col = "#fff";
        if (app.doc.isLocked(r.bone)) { label += "  [lock]"; col = C.muted; }
        else if (app.doc.lockChannels(r.bone)) label += `  [${app.doc.lockChannels(r.bone)}]`;
      } else if (r.kind === "fxhead") { col = C.fx; label = (this.collapsed.__fx ? "+ " : "- ") + label; }
      else if (r.kind === "fx") { x = 22; col = app.fxSel === r.idx ? "#fff" : C.fx; }
      else if (r.kind === "summary") col = C.accent;
      else if (r.kind === "layer") col = app.activeLayer === r.id ? "#fff" : C.ok;
      else if (r.kind === "con") col = C.purple;
      g.fillStyle = col; g.fillText(label, x, r.y + RH - 6, Dope.NAME_W - x - 4);
    }
    g.fillStyle = C.line; g.fillRect(Dope.NAME_W, Dope.RULER_H, 1, H);
    this._ruler(g, n, step);
    const nx = this.f2x(app.frame);
    if (nx >= Dope.NAME_W) {
      g.fillStyle = C.accent; g.fillRect(nx - 1, 0, 2, H);
      g.fillRect(nx - 16, 2, 32, 16);
      g.fillStyle = C.bg0; g.textAlign = "center"; g.fillText(String(Math.round(app.frame)), nx, 14); g.textAlign = "left";
    }
  }

  _ruler(g, n, step) {
    const app = this.app, W = this.w;
    g.fillStyle = C.bg2; g.fillRect(0, 0, W, Dope.RULER_H);
    g.font = "11px Inter, Segoe UI, sans-serif";
    for (let f = Math.floor(this.x0 / step) * step; this.f2x(f) < W; f += step) {
      if (f < 0 || this.f2x(f) < Dope.NAME_W) continue;
      const x = this.f2x(f), major = f % (step * 5) === 0;
      g.fillStyle = C.muted; g.fillRect(x, Dope.RULER_H - (major ? 10 : 5), 1, major ? 10 : 5);
      if (major || step * this.ppf > 28) { g.fillStyle = f <= n ? C.muted : "rgba(154,145,166,0.4)"; g.fillText(String(f), x + 2, 13); }
    }
    const ex = this.f2x(n);
    if (ex > Dope.NAME_W) { g.fillStyle = "rgba(255,201,60,0.6)"; g.fillRect(ex, 0, 1, this.h); }
    const [pa, pb] = app.playRangeFrames();
    if (pa > 0 || pb < n) { g.fillStyle = C.ok; g.fillRect(this.f2x(pa), Dope.RULER_H - 4, (pb - pa) * this.ppf, 4); }
    const marks = app.doc.extra.marks || {};
    for (const mk in marks) {
      const x = this.f2x(Number(marks[mk]));
      if (x <= Dope.NAME_W) continue;
      g.fillStyle = mk === "hit" ? C.red : C.left;
      g.beginPath(); g.moveTo(x, Dope.RULER_H - 2); g.lineTo(x - 5, Dope.RULER_H - 10); g.lineTo(x + 5, Dope.RULER_H - 10); g.fill();
      g.fillText(mk, x + 6, Dope.RULER_H - 3);
    }
    for (const m of app.doc.markers) {
      const x = this.f2x(m.f);
      if (x <= Dope.NAME_W) continue;
      g.fillStyle = C.gold; g.fillRect(x, 14, 1.5, 16); g.fillRect(x, 14, 7, 6); g.fillText(m.name, x + 9, 22);
    }
    g.fillStyle = C.bg2; g.fillRect(0, 0, Dope.NAME_W, Dope.RULER_H);
    g.fillStyle = C.gold; g.font = FONT; g.fillText(`${app.doc.name}  ${n} f @ ${app.doc.fps}`, 8, 19, Dope.NAME_W - 10);
  }

  keyColor(k) { return k.lock ? C.muted : k.tag === "breakdown" ? C.left : k.tag === "extreme" ? C.right : C.gold; }

  _summary(g, cy) {
    const app = this.app, ks = app.doc.keys, links = {};
    ks.forEach((k, i) => {
      const x = this.f2x(k.f + this.shift(k.f));
      if (i + 1 < ks.length) {
        const nk = ks[i + 1];
        const ez = k.ease || app.doc.ease;
        g.strokeStyle = EASE_COL[ez] || C.muted; g.globalAlpha = 0.7; g.lineWidth = ez === "hold" ? 3 : 2;
        g.beginPath(); g.moveTo(x + 7, cy + 6); g.lineTo(this.f2x(nk.f + this.shift(nk.f)) - 7, cy + 6); g.stroke(); g.globalAlpha = 1;
      }
      if (k.link) (links[k.link] ||= []).push(x);
    });
    g.strokeStyle = "rgba(167,123,255,0.7)"; g.lineWidth = 1.2;
    for (const l in links) for (let j = 1; j < links[l].length; j++) {
      const a = links[l][j - 1], b = links[l][j];
      g.beginPath(); g.ellipse((a + b) / 2, cy - 6, (b - a) / 2, Math.min(14, (b - a) / 2), 0, Math.PI, Math.PI * 2); g.stroke();
    }
    for (const k of ks) {
      const x = this.f2x(k.f + this.shift(k.f));
      if (x < Dope.NAME_W - 8 || x > this.w + 8) continue;
      const sel = app.selKeys.includes(k.f);
      const r = k.tag === "breakdown" ? 5.5 : k.tag === "extreme" ? 8 : 7;
      diamond(g, x, cy, r, sel ? "#fff" : this.keyColor(k), sel ? C.accent : C.bg0);
      if (k.link) { g.strokeStyle = C.purple; g.lineWidth = 1.5; g.beginPath(); g.arc(x, cy, r + 3, 0, Math.PI * 2); g.stroke(); }
    }
  }

  _boneRow(g, b, cy) {
    const app = this.app;
    for (const k of app.doc.keys) {
      let has = !!(k.rot && k.rot[b]);
      if (b === "hips" && !has) has = Math.abs(k.hips_dy || 0) + Math.abs(k.hips_dx || 0) + Math.abs(k.hips_dz || 0) > 0;
      const x = this.f2x(k.f + this.shift(k.f));
      if (x < Dope.NAME_W - 6 || x > this.w + 6) continue;
      if (has) diamond(g, x, cy, 5, app.selKeys.includes(k.f) ? "#fff" : this.keyColor(k), C.bg0);
      else { g.fillStyle = "rgba(154,145,166,0.5)"; g.beginPath(); g.arc(x, cy, 1.8, 0, Math.PI * 2); g.fill(); }
    }
  }

  _layerRow(g, l, y, cy) {
    if (!l) return;
    const a = Number(l.start || 0), b = Number(l.end ?? -1) < 0 ? this.app.doc.frames : Number(l.end);
    const c = l.mute ? C.muted : C.ok;
    const x = this.f2x(a), w = (b - a) * this.ppf, h = Dope.ROW_H - 9;
    g.globalAlpha = 0.18; g.fillStyle = c; g.fillRect(x, y + 4, w, h);
    const wt = Math.min(1, Math.max(0, Number(l.weight ?? 1)));
    g.globalAlpha = 0.35; g.fillRect(x, y + 4 + h * (1 - wt), w, h * wt);
    g.globalAlpha = 1; g.strokeStyle = c; g.strokeRect(x, y + 4, w, h);
    if ((l.source || "keys") === "keys") for (const k of l.keys || []) diamond(g, this.f2x(k.f), cy, 5, C.ok, C.bg0);
    else { g.fillStyle = C.text; g.font = "10px Inter, sans-serif"; g.fillText("clip " + l.clip, x + 4, y + 15, Math.max(10, w - 6)); g.font = FONT; }
  }

  _conRow(g, c, y) {
    if (!c) return;
    const a = Number(c.start || 0), b = Number(c.end ?? -1) < 0 ? this.app.doc.frames : Number(c.end);
    const col = c.enabled !== false ? C.purple : C.muted;
    g.globalAlpha = 0.3 * Number(c.influence ?? 1) + 0.1; g.fillStyle = col; g.fillRect(this.f2x(a), y + 5, (b - a) * this.ppf, Dope.ROW_H - 11);
    g.globalAlpha = 1; g.strokeStyle = col; g.strokeRect(this.f2x(a), y + 5, (b - a) * this.ppf, Dope.ROW_H - 11);
    if (c.pin_frame !== undefined) { g.fillStyle = "#fff"; g.fillRect(this.f2x(c.pin_frame) - 1, y + 3, 2, Dope.ROW_H - 6); }
  }

  // an effect cue: a diamond at its frame, a bar for how long it runs (a follow: its dur; a burst: the block's own length)
  fxSpan(d) {
    const app = this.app, fps = app.doc.fps || 30;
    let f = d.frame;
    let len;
    if (d.mode === "follow") len = d.dur * fps;
    else { const e = app.fx.library.get(d.id); len = Number((e && e.manifest && e.manifest.duration) ?? 1) * fps; }
    const dr = this.drag;
    if (dr && dr.mode === "fx" && dr.idx === d.index) f = Math.max(0, Math.min(app.doc.frames, dr.f0 + dr.delta));
    if (dr && dr.mode === "fxdur" && dr.idx === d.index) len = dr.len;
    return { f, len: Math.max(len, 1) };
  }

  _fxRow(g, r) {
    const d = this._fx[r.idx];
    if (!d) return;
    const { f, len } = this.fxSpan(d), y = r.y, cy = y + Dope.ROW_H / 2;
    const sel = this.app.fxSel === r.idx;
    const x = this.f2x(f), w = len * this.ppf, h = Dope.ROW_H - 9;
    g.globalAlpha = d.mode === "follow" ? 0.3 : 0.14; g.fillStyle = C.fx; g.fillRect(x, y + 4, w, h);
    g.globalAlpha = 1; g.strokeStyle = C.fx; g.setLineDash(d.mode === "follow" ? [] : [3, 3]); g.strokeRect(x, y + 4, w, h); g.setLineDash([]);
    if (d.mode === "follow") { g.fillStyle = C.fx; g.fillRect(x + w - 3, y + 4, 3, h); }
    diamond(g, x, cy, sel ? 8 : 6.5, sel ? "#fff" : C.fx, sel ? C.accent : C.bg0);
    if (w > 46) { g.fillStyle = C.text; g.font = "10px Inter, sans-serif"; g.fillText(d.id, x + 10, y + 15, Math.max(10, w - 14)); g.font = FONT; }
  }

  // the effect cue under a point: {idx, part: "key" | "end" | "bar"}
  fxAt(x, y) {
    const r = this.rowAt(y);
    if (!r || r.kind !== "fx") return null;
    const d = this._fx[r.idx];
    if (!d) return null;
    const { f, len } = this.fxSpan(d), x0 = this.f2x(f), x1 = x0 + len * this.ppf;
    if (Math.abs(x - x0) <= 9) return { idx: r.idx, part: "key", d };
    if (d.mode === "follow" && Math.abs(x - x1) <= 6) return { idx: r.idx, part: "end", d };
    if (x > x0 && x < x1) return { idx: r.idx, part: "bar", d };
    return null;
  }

  fxMenu(e, idx) {
    const app = this.app;
    app.selectFx(idx);
    const d = app.fx.describe(idx);
    app.ui.contextMenu(e.clientX, e.clientY, [
      [`${d.id} (frame ${d.frame})`, () => app.setFrame(d.frame)],
      null,
      ["Move to the playhead", async () => { await app.fx.edit(idx, { frame: Math.round(app.frame) }); }],
      ["Open in Effects panel", () => app.ui.showPanel("Effects")],
      ["Open in the Effect Studio", () => app.fx.openStudio(d.id)],
      null,
      ["Remove this cue", () => { app.fx.remove(idx); app.selectFx(-1); }],
    ]);
  }

  keyAt(x, y) {
    for (const r of this._rows || []) {
      if (y < r.y || y > r.y + Dope.ROW_H || !(r.kind === "summary" || r.kind === "bone")) continue;
      let best = -1, bd = 8;
      for (const k of this.app.doc.keys) { const d = Math.abs(this.f2x(k.f) - x); if (d < bd) { bd = d; best = k.f; } }
      return best;
    }
    return -1;
  }

  rowAt(y) { return (this._rows || []).find((r) => y >= r.y && y < r.y + Dope.ROW_H) || null; }

  _events() {
    const cv = this.cv, app = this.app;
    const P = (e) => ({ x: e.offsetX, y: e.offsetY });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = P(e), up = e.deltaY < 0;
      if (e.ctrlKey) {
        this.userZoom = true;
        const fm = this.x2f(p.x);
        this.ppf = Math.min(120, Math.max(1, this.ppf * (up ? 1.15 : 1 / 1.15)));
        this.x0 = fm - (p.x - Dope.NAME_W) / this.ppf;
      } else if (e.shiftKey) this.x0 += ((up ? -4 : 4) * 10) / this.ppf;
      else this.scroll = Math.max(0, this.scroll + (up ? -2 : 2) * Dope.ROW_H);
      this.draw();
    }, { passive: false });
    cv.addEventListener("pointerdown", (e) => {
      cv.focus();
      const p = P(e);
      try { cv.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer (the self-test) has nothing to capture */ }
      if (e.button === 1) { this.drag = { mode: "pan", last: p }; return; }
      if (e.button === 2) {
        const hit = p.x > Dope.NAME_W ? this.fxAt(p.x, p.y) : null;
        const rr = p.x <= Dope.NAME_W ? this.rowAt(p.y) : null;
        if (hit || rr?.kind === "fx") { this.fxMenu(e, hit ? hit.idx : rr.idx); return; }
        const kf = this.keyAt(p.x, p.y);
        if (kf >= 0 && !app.selKeys.includes(kf)) app.selectKeys([kf]);
        this.menu && this.menu(e.clientX, e.clientY);
        return;
      }
      if (p.y < Dope.RULER_H && p.x > Dope.NAME_W) {
        this.drag = { mode: "scrub" };
        app.setFrame(Math.round(this.x2f(p.x)));
      } else if (p.x < Dope.NAME_W) {
        const r = this.rowAt(p.y);
        if (r?.kind === "group") this.collapsed[r.group] = !this.collapsed[r.group];
        else if (r?.kind === "bone") app.selectBone(r.bone, e.shiftKey);
        else if (r?.kind === "layer") app.setActiveLayer(r.id);
        else if (r?.kind === "summary") app.setActiveLayer("");
        else if (r?.kind === "fxhead") this.collapsed.__fx = !this.collapsed.__fx;
        else if (r?.kind === "fx") { app.selectFx(r.idx); app.setFrame(this._fx[r.idx].frame); }
        this.draw();
      } else if (this.fxAt(p.x, p.y)) {
        const hit = this.fxAt(p.x, p.y), fps = app.doc.fps || 30;
        app.selectFx(hit.idx);
        if (e.detail === 2) app.setFrame(hit.d.frame);
        this.drag = hit.part === "end" ? { mode: "fxdur", idx: hit.idx, press: p, len0: this.fxSpan(hit.d).len, len: this.fxSpan(hit.d).len, fps }
          : { mode: "fx", idx: hit.idx, press: p, f0: hit.d.frame, delta: 0 };
      } else {
        const kf = this.keyAt(p.x, p.y);
        if (kf >= 0) {
          if (e.detail === 2) app.setFrame(kf);
          if (e.shiftKey) app.selectKeys(app.selKeys.includes(kf) ? app.selKeys.filter((f) => f !== kf) : [...app.selKeys, kf]);
          else if (!app.selKeys.includes(kf)) app.selectKeys([kf]);
          this.drag = { mode: "move", press: p, delta: 0 };
        } else {
          this.drag = { mode: "box", press: p, box: { x: p.x, y: p.y, w: 0, h: 0 }, add: e.shiftKey };
          if (!e.shiftKey) app.selectKeys([]);
        }
      }
    });
    cv.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d) return;
      const p = P(e);
      if (d.mode === "pan") { this.x0 -= (p.x - d.last.x) / this.ppf; this.scroll = Math.max(0, this.scroll - (p.y - d.last.y)); d.last = p; this.userZoom = true; }
      else if (d.mode === "scrub") app.setFrame(Math.round(this.x2f(p.x)));
      else if (d.mode === "move") d.delta = Math.round((p.x - d.press.x) / this.ppf);
      else if (d.mode === "fx") d.delta = Math.round((p.x - d.press.x) / this.ppf);
      else if (d.mode === "fxdur") d.len = Math.max(1, d.len0 + Math.round((p.x - d.press.x) / this.ppf));
      else if (d.mode === "box") d.box = { x: Math.min(p.x, d.press.x), y: Math.min(p.y, d.press.y), w: Math.abs(p.x - d.press.x), h: Math.abs(p.y - d.press.y) };
      this.draw();
    });
    cv.addEventListener("pointerup", () => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.mode === "move" && d.delta) app.moveKeys(app.selKeys, d.delta);
      else if (d.mode === "fx") { if (d.delta) app.fx.edit(d.idx, { frame: Math.max(0, Math.min(app.doc.frames, d.f0 + d.delta)) }); }
      else if (d.mode === "fxdur") { if (d.len !== d.len0) app.fx.edit(d.idx, { dur: Math.max(0.05, d.len / d.fps) }); }
      else if (d.mode === "box") {
        const picked = d.add ? [...app.selKeys] : [];
        for (const r of this._rows) {
          const y = r.y + Dope.ROW_H / 2;
          if (y < d.box.y || y > d.box.y + d.box.h || !(r.kind === "summary" || r.kind === "bone")) continue;
          for (const k of app.doc.keys) { const x = this.f2x(k.f); if (x >= d.box.x && x <= d.box.x + d.box.w && !picked.includes(k.f)) picked.push(k.f); }
        }
        app.selectKeys(picked);
      }
      this.draw();
    });
  }
}

export class Graph extends CanvasPanel {
  static RULER_H = 26;
  static LEFT_W = 52;

  constructor(app, el) {
    super(app, el);
    this.x0 = -0.5;
    this.ppf = 12;
    this.vMid = 0;
    this.ppd = 2;
    this.channels = [true, true, true];
    this.showFinal = true;
    this.showHips = false;
    this.drag = null;
    this._fitNext = true;
    this._events();
  }

  onResize() { this._fitNext = true; }
  f2x(f) { return Graph.LEFT_W + (f - this.x0) * this.ppf; }
  x2f(x) { return (x - Graph.LEFT_W) / this.ppf + this.x0; }
  v2y(v) { return Graph.RULER_H + (this.h - Graph.RULER_H) / 2 - (v - this.vMid) * this.ppd; }

  series() {
    const c = this.app.graphCurves(this.app.selBone);
    const k = this.showHips ? 100 : DEG;
    const m = (arr) => arr.map((v) => v.map((x) => x * k));
    return { layer: m(this.showHips ? c.hips : c.layer), final: m(this.showHips ? c.hipsFinal : c.final), k };
  }

  fit() {
    const s = this.series();
    let lo = Infinity, hi = -Infinity;
    for (const v of [...s.layer, ...s.final]) for (let i = 0; i < 3; i++) if (this.channels[i]) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
    if (lo === Infinity) { lo = -10; hi = 10; }
    if (hi - lo < 10) { const m = (hi + lo) / 2; lo = m - 5; hi = m + 5; }
    this.vMid = (lo + hi) / 2;
    this.ppd = (this.h - Graph.RULER_H - 40) / (hi - lo);
    this.ppf = Math.min(80, Math.max(1, (this.w - Graph.LEFT_W - 20) / Math.max(1, this.app.doc.frames)));
    this.x0 = -0.5;
  }

  keyVals(k, bone, s) {
    if (this.showHips) return [k.hips_dx || 0, k.hips_dy || 0, k.hips_dz || 0].map((x) => x * s);
    const r = (k.rot || {})[bone] || [0, 0, 0];
    return r.map((x) => x * s);
  }

  draw() {
    const g = this.g, app = this.app, W = this.w, H = this.h;
    if (!app.doc || !app.stage?.probe) return;
    if (this._fitNext && W > 50) { this._fitNext = false; this.fit(); }
    g.fillStyle = C.bg0; g.fillRect(0, 0, W, H);
    g.fillStyle = C.bg1; g.fillRect(this.f2x(0), Graph.RULER_H, app.doc.frames * this.ppf, H);
    const vstep = [1, 2, 5, 10, 15, 30, 45, 90].find((s) => s * this.ppd >= 22) || 180;
    g.font = "10px Inter, sans-serif";
    const vtop = this.vMid + (this.v2y(this.vMid) - Graph.RULER_H) / this.ppd;
    for (let v = Math.floor((this.vMid - (H - this.v2y(this.vMid)) / this.ppd) / vstep) * vstep; v <= vtop; v += vstep) {
      const y = this.v2y(v);
      g.fillStyle = Math.abs(v) < 1e-6 ? "rgba(58,51,66,0.8)" : "rgba(58,51,66,0.35)";
      g.fillRect(Graph.LEFT_W, y, W, 1);
      g.fillStyle = C.muted; g.fillText(`${Math.round(v)}${this.showHips ? "cm" : "°"}`, 4, y + 4);
    }
    const s = this.series();
    for (let ax = 0; ax < 3; ax++) {
      if (!this.channels[ax]) continue;
      if (this.showFinal && s.final.length) {
        g.strokeStyle = AX[ax]; g.globalAlpha = 0.35; g.setLineDash([4, 4]); g.lineWidth = 1;
        g.beginPath(); s.final.forEach((v, f) => (f ? g.lineTo(this.f2x(f), this.v2y(v[ax])) : g.moveTo(this.f2x(f), this.v2y(v[ax])))); g.stroke();
        g.setLineDash([]); g.globalAlpha = 1;
      }
      g.strokeStyle = AX[ax]; g.lineWidth = 2;
      g.beginPath(); s.layer.forEach((v, f) => (f ? g.lineTo(this.f2x(f), this.v2y(v[ax])) : g.moveTo(this.f2x(f), this.v2y(v[ax])))); g.stroke();
    }
    for (const k of app.doc.keys) {
      const vals = this.keyVals(k, app.selBone, s.k);
      for (let ax = 0; ax < 3; ax++) {
        if (!this.channels[ax]) continue;
        let v = vals[ax];
        if (this.drag?.mode === "point" && this.drag.f === k.f && this.drag.axis === ax) v = this.drag.val;
        const sel = app.selKeys.includes(k.f);
        g.fillStyle = sel ? "#fff" : AX[ax];
        g.beginPath(); g.arc(this.f2x(k.f), this.v2y(v), sel ? 5.5 : 4.5, 0, Math.PI * 2); g.fill();
        g.strokeStyle = C.bg0; g.lineWidth = 1; g.stroke();
      }
    }
    g.fillStyle = C.bg2; g.fillRect(0, 0, W, Graph.RULER_H);
    const step = [1, 2, 5, 10, 20, 50].find((st) => st * this.ppf >= 9) || 100;
    g.fillStyle = C.muted; g.font = "11px Inter, sans-serif";
    for (let f = Math.floor(this.x0 / step) * step; this.f2x(f) < W; f += step) if (f >= 0 && f % (step * 5) === 0 && this.f2x(f) >= Graph.LEFT_W) g.fillText(String(f), this.f2x(f) + 2, 13);
    const nx = this.f2x(app.frame);
    g.fillStyle = C.accent; g.fillRect(nx - 1, 0, 2, H);
    g.fillStyle = C.gold; g.font = "14px Inter, sans-serif";
    g.fillText(`${app.selBone}  ${this.showHips ? "hips shift" : "rotation"}`, Graph.LEFT_W + 6, Graph.RULER_H + 44);
    g.fillStyle = C.muted; g.font = "11px Inter, sans-serif";
    g.fillText(R.hint(app.selBone), Graph.LEFT_W + 6, Graph.RULER_H + 60, W - Graph.LEFT_W - 20);
  }

  hitPoint(p) {
    const k = this.showHips ? 100 : DEG;
    let best = null, bd = 9;
    for (const key of this.app.doc.keys) {
      const vals = this.keyVals(key, this.app.selBone, k);
      for (let ax = 0; ax < 3; ax++) {
        if (!this.channels[ax]) continue;
        const d = Math.hypot(p.x - this.f2x(key.f), p.y - this.v2y(vals[ax]));
        if (d < bd) { bd = d; best = { f: key.f, axis: ax, start: vals[ax], val: vals[ax] }; }
      }
    }
    return best;
  }

  _events() {
    const cv = this.cv, app = this.app;
    const P = (e) => ({ x: e.offsetX, y: e.offsetY });
    cv.addEventListener("keydown", (e) => { if (e.key === "f" || e.key === "F") { this.fit(); this.draw(); e.stopPropagation(); } });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = P(e), up = e.deltaY < 0;
      if (e.ctrlKey) { const fm = this.x2f(p.x); this.ppf = Math.min(200, Math.max(0.5, this.ppf * (up ? 1.15 : 1 / 1.15))); this.x0 = fm - (p.x - Graph.LEFT_W) / this.ppf; }
      else { const vm = this.vMid - (p.y - this.v2y(this.vMid)) / this.ppd; this.ppd = Math.min(80, Math.max(0.05, this.ppd * (up ? 1.15 : 1 / 1.15))); this.vMid += vm - (this.vMid - (p.y - this.v2y(this.vMid)) / this.ppd); }
      this.draw();
    }, { passive: false });
    cv.addEventListener("pointerdown", (e) => {
      cv.focus();
      cv.setPointerCapture(e.pointerId);
      const p = P(e);
      if (e.button === 1) { this.drag = { mode: "pan", last: p }; return; }
      if (e.button !== 0) return;
      const hit = p.y > Graph.RULER_H ? this.hitPoint(p) : null;
      if (hit) { app.selectKeys([hit.f], e.shiftKey); this.drag = { mode: "point", press: p, ...hit }; }
      else { this.drag = { mode: "scrub" }; app.setFrame(Math.round(this.x2f(p.x))); }
    });
    cv.addEventListener("pointermove", (e) => {
      const d = this.drag, p = P(e);
      if (!d) return;
      if (d.mode === "pan") { this.x0 -= (p.x - d.last.x) / this.ppf; this.vMid += (p.y - d.last.y) / this.ppd; d.last = p; }
      else if (d.mode === "scrub") app.setFrame(Math.round(this.x2f(p.x)));
      else if (d.mode === "point" && (Math.abs(p.y - d.press.y) > Math.abs(p.x - d.press.x) || e.shiftKey)) d.val = d.start + (d.press.y - p.y) / this.ppd;
      this.draw();
    });
    cv.addEventListener("pointerup", (e) => {
      const d = this.drag, p = P(e);
      this.drag = null;
      if (d?.mode === "point") {
        const df = Math.round((p.x - d.press.x) / this.ppf);
        if (Math.abs(d.val - d.start) > 1e-5) {
          if (this.showHips) app.setKeyHips(d.f, ["dx", "dy", "dz"][d.axis], d.val / 100);
          else app.setKeyChannel(d.f, app.selBone, d.axis, d.val * RAD);
        } else if (df) app.moveKeys([d.f], df);
      }
      this.draw();
    });
  }
}

export { EASES, TAGS };
