// Effect blocks placed on a unit at times in its clip, the way the game fires clip cues (CBFxRmt.cue): the port of the game's
// addons/rmt_effects/core/placements.gd, so the Desktop, the Godot Animator, the Effect Studio and the game agree.
//
// This group IS the game's frame: its origin is the unit's feet, +X ahead (the unit facing right), +Y up, +Z toward the game
// camera; the Desktop's fighter faces +Z, so the app turns it -72 degrees and scales it to the Desktop's size (fx.js).
// A placement is {id, socket, mode, t, dur, offset, rot, scale}:
//   burst  - fires at t where the socket is at that moment and stays there for the block's duration (the game's pool then
//            hides it); offset [ahead, up, toward camera] m, rot degrees
//   follow - rides the socket's bone from t for dur seconds, then stops emitting; offset / rot in the bone's own frame
// The host gives `source` = {socketAt(name, t) -> Vector3 (world), socketNode(name) -> Object3D | null, floorNode() -> Object3D}
// and owns the clock: setTime(t) jumps, advance(t1) steps on (once per drawn frame). Blocks are prepared (rmtfx.prepare) first.
import * as THREE from "three";
import { RmtEffect } from "./rmtfx.js";

export const EPS = 1e-6;
export const FOLLOW_FADE = 0.8;
export const FIELDS = ["id", "socket", "mode", "t", "dur", "offset", "rot", "scale"];

const v3 = (v) => (Array.isArray(v) && v.length >= 3 ? new THREE.Vector3(Number(v[0]), Number(v[1]), Number(v[2])) : v && v.isVector3 ? v.clone() : new THREE.Vector3());
const a3 = (v) => [v.x, v.y, v.z].map((x) => Math.round(x * 1000) / 1000);
const rotQ = (deg) => new THREE.Quaternion().setFromEuler(new THREE.Euler(...[deg.x, deg.y, deg.z].map(THREE.MathUtils.degToRad), "YXZ"));   // Basis.from_euler

export class Placements extends THREE.Group {
  constructor(blocks) {
    super();
    this.blocks = blocks;        // id -> prepared block (rmtfx.prepare)
    this.source = null;
    this.list = [];
    this.t = 0;
    this._seeds = 0;
  }

  // a placement; returns its index (-1: the block is not prepared). preview = a block passed in (held in memory)
  place(p, block = null) {
    const b = block || this.blocks.get(String(p.id || ""));
    if (!b) return -1;
    const d = { id: String(p.id || b.id), socket: String(p.socket || "origin"), mode: String(p.mode || "burst"), t: Number(p.t || 0),
      dur: Number(p.dur ?? 0.5), offset: v3(p.offset), rot: v3(p.rot), scale: Number(p.scale ?? 1), preview: !!p.preview, seed: Number(p.seed || 0) };
    if (!d.seed) d.seed = ++this._seeds;
    d.anchor = new THREE.Group();
    d.node = new RmtEffect(b);
    d.anchor.add(d.node);
    this.add(d.anchor);
    this.list.push(d);
    this._attach(d);
    return this.list.length - 1;
  }

  edit(i, p) {
    const d = this.list[i];
    if (!d) return false;
    for (const k of ["socket", "mode"]) if (k in p) d[k] = String(p[k]);
    for (const k of ["t", "dur", "scale"]) if (k in p) d[k] = Number(p[k]);
    for (const k of ["offset", "rot"]) if (k in p) d[k] = v3(p[k]);
    if ("id" in p && String(p.id) !== d.id && !d.preview && this.blocks.get(String(p.id))) {
      d.id = String(p.id);
      d.anchor.remove(d.node);
      d.node.dispose();
      d.node = new RmtEffect(this.blocks.get(d.id));
      d.anchor.add(d.node);
    }
    this._attach(d);
    return true;
  }

  remove(i) {
    const d = this.list[i];
    if (!d) return;
    d.anchor.parent && d.anchor.parent.remove(d.anchor);
    d.node.dispose();
    this.list.splice(i, 1);
  }

  clear(keepPreview = true) {
    for (let i = this.list.length - 1; i >= 0; i--) if (!(keepPreview && this.list[i].preview)) this.remove(i);
  }

  describe(i, fps) {
    const d = this.list[i];
    return { index: i, id: d.id, socket: d.socket, mode: d.mode, t: Math.round(d.t * 1000) / 1000, frame: Math.round(d.t * fps * 10) / 10,
      dur: d.dur, offset: a3(d.offset), rot: a3(d.rot), scale: d.scale, preview: d.preview };
  }

  asCues() {
    return this.list.filter((d) => !d.preview).map((d) => {
      const c = { t: Math.round(d.t * 1000) / 1000, fx: d.id, socket: d.socket, scale: Math.round(d.scale * 100) / 100, mode: d.mode, dur: Math.round(d.dur * 100) / 100 };
      if (d.offset.lengthSq() > 0) c.offset = a3(d.offset);
      if (d.rot.lengthSq() > 0) c.rot = a3(d.rot);
      return c;
    });
  }

  fromCues(cues) {
    this.clear(true);
    return this.addCues(cues);
  }

  // clip cues as placements after the ones there (prepared blocks only); returns how many
  addCues(cues) {
    let n = 0;
    for (const c of cues || []) {
      if (this.place({ id: c.fx, socket: c.socket || "mid", mode: c.mode || "burst", t: c.t || 0, dur: c.dur ?? 0.4, offset: c.offset, rot: c.rot, scale: c.scale ?? 1 }) >= 0) n++;
    }
    return n;
  }

  detachFollows() {
    for (const d of this.list) if (d.anchor.parent !== this) { d.anchor.parent && d.anchor.parent.remove(d.anchor); this.add(d.anchor); }
  }

  reattach() { for (const d of this.list) this._attach(d); }

  _attach(d) {
    let parent = this;
    if (d.mode === "follow" && this.source) parent = this.source.socketNode(d.socket) || this.source.floorNode() || this;
    if (d.anchor.parent !== parent) { d.anchor.parent && d.anchor.parent.remove(d.anchor); parent.add(d.anchor); }
    if (parent !== this) { d.anchor.position.copy(d.offset); d.anchor.quaternion.copy(rotQ(d.rot)); d.anchor.scale.set(1, 1, 1); }
    d.node.scale.setScalar(d.scale);
    // a follow's trail can be drawn back along its socket's path on a jump
    d.node.trailSampler = d.mode === "follow" && this.source && parent !== this ? (tau) => this.source.socketAt(d.socket, d.t + tau) : null;
  }

  _isBurst(d) { return d.anchor.parent === this; }

  // a burst's spot: the socket at the burst's own time, plus the offset, in this frame
  _burstSpot(d) {
    const at = this.source ? this.source.socketAt(d.socket, d.t) : this.getWorldPosition(new THREE.Vector3());
    this.updateWorldMatrix(true, false);
    const local = this.worldToLocal(at.clone()).add(d.offset);
    d.anchor.position.copy(local);
    d.anchor.quaternion.copy(rotQ(d.rot));
    d.anchor.scale.set(1, 1, 1);
  }

  setTime(t) {
    this.t = t;
    for (const d of this.list) {
      if (this._isBurst(d)) this._burstSpot(d);
      let tau = t - d.t;
      d.anchor.visible = this._alive(d, tau);
      if (d.mode === "follow" && tau > d.dur) tau = d.dur;
      d.node.seek(Math.max(tau, 0), d.seed);
    }
  }

  advance(t1) {
    for (const d of this.list) {
      const tau0 = this.t - d.t;
      let tau1 = t1 - d.t;
      if (tau1 < -EPS) { d.anchor.visible = false; continue; }
      tau1 = Math.max(tau1, 0);
      if (tau0 < -EPS) {
        if (this._isBurst(d)) this._burstSpot(d);
        d.node.seek(0, d.seed);
        d.node.step(tau1, d.seed);
      } else d.node.step(tau1 - tau0, d.seed);
      if (d.mode === "follow" && tau0 <= d.dur && tau1 > d.dur) d.node.release();
      d.anchor.visible = this._alive(d, tau1);
    }
    this.t = t1;
  }

  _alive(d, tau) {
    if (tau < -EPS) return false;
    if (d.mode === "follow") return tau <= d.dur + FOLLOW_FADE;
    const m = d.node.manifest;   // a burst: the game's pool hides it after the block's duration (RmtEffectPool); a loop plays on
    return !!m.loop || tau <= Math.max(0.2, Number(m.duration ?? 1)) + EPS;
  }

  // where placement i is now: {live, layers: [{name, kind, box: Box3}], box: Box3 | null} (world)
  boxes(i) {
    const d = this.list[i];
    let vis = d.anchor.visible;
    for (let o = d.anchor.parent; o && vis; o = o.parent) vis = o.visible;
    const out = { live: vis, layers: [], box: null };
    if (!vis) return out;
    for (const l of d.node.boxes()) {
      out.layers.push(l);
      if (l.kind === "particles" || l.kind === "mesh" || l.kind === "trail")   // the effect's own shape; a decal's projector box and a light are listed, not added
        out.box = out.box ? out.box.union(l.box.clone()) : l.box.clone();
    }
    return out;
  }
}

export function boxDict(b) {
  const r = (v) => a3(v);
  return { min: r(b.min), max: r(b.max), size: r(b.getSize(new THREE.Vector3())), center: r(b.getCenter(new THREE.Vector3())) };
}
