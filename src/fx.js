// Effects on the clip: RMT effect blocks (the game's addons/rmt_effects library) fired at sockets at frames of the clip, the
// way the game fires a clip's cues (data/clip_fx.json, CBFxRmt.cue). They play in the views and the strip as the clip plays
// or scrubs, frozen in between (the same frame always shows the same effect frame), and save as the clip's cues. The port of
// the Godot Animator's core/fx.gd on the same engine (core/placements.js = rmt_effects/core/placements.gd).
//
// The fighter faces +Z here. The game's frame (+X ahead, +Y up, +Z toward the camera) is a group at the fighter's feet turned
// -72 degrees (a match fighter facing right is turned +72) and scaled to the Desktop's size (the match scales the model to its
// height_m), so a burst's offset, turn and size against the body are what the match shows.
import * as THREE from "three";
import { Placements, boxDict, FIELDS } from "./core/placements.js";
import * as FX from "./core/rmtfx.js";

export const TURN_DEG = 72;

export class Fx {
  constructor(app) {
    this.app = app;
    this.library = new Map();   // id -> {id, category, manifest, dir, resUrl}
    this.blocks = new Map();    // id -> prepared block
    this._shaders = new Map();
    this.pl = new Placements(this.blocks);
    this.pl.name = "Effects";
    this.pl.source = this;
    this.floorN = new THREE.Group();
    this.socks = {};            // socket -> Object3D placed from the pose shown (follows ride them)
    this.offsets = {};          // socket -> {bone, offset: Vector3 in the bone's own axes, ground}
    this.dirty = false;
    this.clip = "";
    this._t = 0;
    this.strip = new Placements(this.blocks);   // the strip's copy, re-timed for each column
    this.strip.source = { socketAt: (n, t) => this.socketAt(n, t), socketNode: (n) => this.stripSocks[n] || null, floorNode: () => this.stripFloor };
    this.stripSocks = {};
    this.stripFloor = new THREE.Group();
    this._stripCues = "";
  }

  async init() {
    const lib = await window.host.fxLibrary();
    const res = lib.resRoot;
    for (const b of lib.blocks) this.library.set(b.id, { ...b, resUrl: (p) => res + String(p).replace(/^res:\/\//, "") });
    const st = this.app.stage;
    st.scene.add(this.pl, this.floorN);
    st.stripScene.add(this.strip, this.stripFloor);
    this.bindFighter();
  }

  async ensure(id) {
    if (this.blocks.has(id)) return this.blocks.get(id);
    const e = this.library.get(id);
    if (!e) return null;
    const b = await FX.prepare(e, async (name) => {
      if (!this._shaders.has(name)) this._shaders.set(name, await window.host.fxShader(name));
      return this._shaders.get(name);
    });
    this.blocks.set(id, b);
    return b;
  }

  // a new fighter: its sockets measured the game's way (CBSockets.offset on the rest pose), the game's frame at its match scale
  bindFighter() {
    const app = this.app;
    const st = app.stage;
    this.pl.detachFollows();
    this.strip.detachFollows();
    for (const o of [...Object.values(this.socks), ...Object.values(this.stripSocks)]) o.parent && o.parent.remove(o);
    this.socks = {};
    this.stripSocks = {};
    this.offsets = {};
    const probe = st.probe;
    probe.apply({});
    probe.root.position.set(0, 0, 0);
    probe.update();
    for (const n in app.sockSpecs) {
      const sp = app.sockSpecs[n];
      if (!probe.has(sp.bone)) continue;
      const bone = probe.bone(sp.bone);
      const space = skeletonSpace(bone);
      const rest = space.clone().invert().multiply(bone.matrixWorld);   // the bone's rest pose in its skeleton's space
      const restInv = new THREE.Matrix3().setFromMatrix4(rest).invert();
      const ro = new THREE.Vector3().setFromMatrixPosition(rest);
      const off = new THREE.Vector3();
      if (sp.to && probe.has(sp.to)) {
        const to = new THREE.Vector3().setFromMatrixPosition(space.clone().invert().multiply(probe.bone(sp.to).matrixWorld));
        off.copy(to.sub(ro).applyMatrix3(restInv).multiplyScalar(Number(sp.t || 0)));
      }
      if (sp.sole) off.add(new THREE.Vector3(0, -ro.y, 0).applyMatrix3(restInv));
      const ex = sp.extra || [0, 0, 0];
      off.add(new THREE.Vector3(Number(ex[0]), Number(ex[1]), Number(ex[2])));
      this.offsets[n] = { bone: sp.bone, offset: off, ground: !!sp.ground };
      if (!sp.ground) {
        this.socks[n] = new THREE.Group();
        st.scene.add(this.socks[n]);
        this.stripSocks[n] = new THREE.Group();
        st.stripScene.add(this.stripSocks[n]);
      }
    }
    const k = 1 / Math.max(app.matchScale || 1, 1e-4);
    for (const g of [this.pl, this.floorN, this.strip, this.stripFloor]) {
      g.rotation.set(0, THREE.MathUtils.degToRad(-TURN_DEG), 0);
      g.scale.setScalar(k);
    }
    this._place(st.body, this.socks);
    this.pl.reattach();
    this.strip.reattach();
  }

  // a socket on a body now (world): the bone's pose times the socket's offset in its own axes; floor sockets on the floor
  socketOn(body, n) {
    const o = this.offsets[n];
    if (!o || !body.has(o.bone)) return this.floorN.getWorldPosition(new THREE.Vector3());
    const p = o.offset.clone().applyMatrix4(body.bone(o.bone).matrixWorld);
    if (o.ground) p.y = 0;
    return p;
  }

  _place(body, socks) {
    for (const n in socks) {
      const o = this.offsets[n];
      const m = body.bone(o.bone).matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(o.offset.x, o.offset.y, o.offset.z));
      m.decompose(socks[n].position, socks[n].quaternion, socks[n].scale);
      socks[n].updateMatrixWorld(true);
    }
  }

  // ---------------------------------------------------------------- placements.js's source

  // a socket t seconds into the clip: the pose shown when t is the playhead, else the probe body posed there as the views
  // show that frame (the match's Body Solve when the Collision Wrap is on: it can move a kicking foot a lot)
  socketAt(name, t) {
    if (!name || name === "origin") return this.floorN.getWorldPosition(new THREE.Vector3());
    const app = this.app;
    const f = t * app.doc.fps;
    if (Math.abs(f - app.frame) < 1e-3 && !app.pending) return this.socketOn(app.stage.body, name);
    const pr = app.stage.probe;
    app.finalPoseOn(pr, f);
    app.matchFinish(pr, app.show.wrap ? app.wrapCarry(f) : null);
    const p = this.socketOn(pr, name);
    pr.root.position.y = 0;
    pr.update();
    return p;
  }

  socketNode(name) { return this.socks[name] || null; }
  floorNode() { return this.floorN; }

  // ---------------------------------------------------------------- the clock

  // after every pose (app.applyNow): sockets to the pose shown, effects to the playhead (stepped while playing forward)
  afterPose() {
    const app = this.app;
    if (!app.stage || !app.stage.body) return;
    this._place(app.stage.body, this.socks);
    this.sync(false);
  }

  sync(jump) {
    const app = this.app;
    const t = app.frame / Math.max(app.doc.fps, 1);
    this.pl.visible = app.show.fx !== false;
    if (!jump && app.playing && t > this._t && t - this._t < 0.15) this.pl.advance(t);
    else this.pl.setTime(t);
    this._t = t;
    app.views && app.views.dirty();
  }

  // the strip's column at frame f, after its body is posed there
  showStrip(f) {
    const app = this.app;
    this._place(app.stage.stripBody, this.stripSocks);
    const cues = JSON.stringify(this.pl.asCues());
    if (cues !== this._stripCues) { this._stripCues = cues; this.strip.fromCues(this.pl.asCues()); }
    this.strip.visible = app.show.fx !== false;
    this.strip.setTime(f / Math.max(app.doc.fps, 1));
  }

  // ---------------------------------------------------------------- the clip's cues

  // the clip's saved cues: the old clip's go at once, the file's come when it is read (anything added meanwhile is kept)
  async loadClip(name) {
    this.clip = name;
    const seq = (this._seq = (this._seq || 0) + 1);
    this.pl.clear(true);
    this.dirty = false;
    this.sync(true);
    const data = (await window.host.loadData("clip_fx.json")) || {};
    const cues = ((data.cues || {})[name] || []).slice();
    for (const c of cues) await this.ensure(String(c.fx || ""));
    if (seq !== this._seq) return;   // another clip opened meanwhile
    const edited = this.dirty;
    this.pl.addCues(cues);
    this.dirty = edited;
    this.sync(true);
    this.app.views && this.app.views.stripDirty();
    this.app.emit("fx");
  }

  async save() {
    if (!this.clip || this.clip === "untitled") return false;
    const data = (await window.host.loadData("clip_fx.json")) || { cues: {} };
    data.cues = data.cues || {};
    const cues = this.pl.asCues();
    if (cues.length) data.cues[this.clip] = cues;
    else delete data.cues[this.clip];
    const ok = await window.host.saveData("clip_fx.json", data);
    if (ok) this.dirty = false;
    this.app.emit("fx");
    return ok;
  }

  // ---------------------------------------------------------------- editing (the Effects panel and the agent API)

  _fields(p) {
    const q = {};
    for (const k of FIELDS) if (k in p) q[k] = p[k];
    if ("frame" in p) q.t = Number(p.frame) / Math.max(this.app.doc.fps, 1);
    return q;
  }

  async add(p) {
    if (!(await this.ensure(String(p.id || "")))) return -1;
    const i = this.pl.place(this._fields(p));
    if (i >= 0) this._edited();
    return i;
  }

  async edit(i, p) {
    if (p.id && !(await this.ensure(String(p.id)))) return false;
    const ok = this.pl.edit(i, this._fields(p));
    if (ok) this._edited();
    return ok;
  }

  remove(i) {
    if (i < 0 || i >= this.pl.list.length) return;
    this.pl.remove(i);
    this._edited();
  }

  _edited() {
    this.dirty = true;
    this.sync(true);
    this.app.views && this.app.views.stripDirty();
    this.app.emit("fx");
  }

  count() { return this.pl.list.length; }
  describe(i) { return this.pl.describe(i, this.app.doc.fps); }
  list() { return this.pl.list.map((_, i) => this.describe(i)); }
  frames() { return this.pl.list.map((d) => d.t * this.app.doc.fps); }

  blockList(q = "") {
    q = String(q).toLowerCase();
    const out = [];
    for (const e of this.library.values()) {
      const m = e.manifest;
      const tags = (m.tags || []).join(" ");
      if (q && !e.id.toLowerCase().includes(q) && !tags.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q)) continue;
      out.push({ id: e.id, category: e.category, duration: m.duration ?? 1, loop: !!m.loop, layers: (m.layers || []).map((l) => `${l.name}:${l.kind}`), tags: m.tags || [] });
    }
    return out;
  }

  // where each effect is now in the game's frame (metres at match size: x ahead, y up, z toward the camera), the nearest
  // sockets, whether it covers the head
  measure() {
    const app = this.app;
    const k = app.matchScale || 1;
    this.pl.updateWorldMatrix(true, true);
    const inv = this.pl.matrixWorld.clone().invert();
    return this.pl.list.map((_, i) => {
      const b = this.pl.boxes(i);
      const m = this.describe(i);
      m.live = b.live;
      if (b.box) {
        m.box = boxDict(b.box.clone().applyMatrix4(inv));
        const c = b.box.getCenter(new THREE.Vector3());
        const near = Object.keys(this.offsets).map((n) => ({ socket: n, m: Math.round(this.socketOn(app.stage.body, n).distanceTo(c) * k * 100) / 100 }));
        near.sort((x, y) => x.m - y.m);
        m.nearest_sockets = near.slice(0, 3);
        m.covers_head = b.box.containsPoint(this.socketOn(app.stage.body, "head"));
        m.height_vs_fighter = Math.round((b.box.max.y - b.box.min.y) / Math.max(app.stage.height, 0.01) * 100) / 100;
        m.layers = b.layers.map((l) => ({ name: l.name, kind: l.kind, box: boxDict(l.box.clone().applyMatrix4(inv)) }));
      }
      return m;
    });
  }

  // a block's manifest changed (the FX Studio saved it): build it again and put it in every cue that fires it
  async reloadBlock(id) {
    this.blocks.delete(id);
    const cues = this.pl.asCues();
    const dirty = this.dirty;
    await this.ensure(id);
    this.pl.fromCues(cues);
    this.dirty = dirty;
    this._stripCues = "";
    this.sync(true);
    this.app.views && this.app.views.stripDirty();
    this.app.emit("fx");
  }

  openStudio(effect = "") {
    const app = this.app;
    return window.host.openEffectStudio(app.fighter, app.doc.name, app.frame / Math.max(app.doc.fps, 1), effect);
  }
}

// the space a bone's skeleton lives in (the parent of its top bone): Godot's skeleton space
function skeletonSpace(bone) {
  let b = bone;
  while (b.parent && b.parent.isBone) b = b.parent;
  return b.parent ? b.parent.matrixWorld.clone() : new THREE.Matrix4();
}
