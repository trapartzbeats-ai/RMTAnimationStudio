// Fight Studio Desktop - the app: state and every edit (UI, shortcuts and agents all come through here: undo, live views,
// history). The clip format, rules and agent API match the Godot Fight Studio Animator.
import * as THREE from "three";
import { Doc, poseOfKey, fillKey, EASES } from "./core/doc.js";
import { boneRot, rotQuat, eulerOf, sub3, add3, lerp3, dist3, v3, DEG, RAD, poseAt } from "./core/clip.js";
import * as R from "./core/rig.js";
import * as R5 from "./core/rig_v5.js";
import * as R5U from "./core/rig_upgrade.js";
import * as E from "./core/evalc.js";
import { History } from "./core/history.js";
import * as A from "./core/adjust.js";
import * as M from "./core/merge.js";
import * as F from "./core/feet.js";
import * as MI from "./core/motion_import.js";
// a foot near the floor counts as hanging loose (not planted) past these (degrees): tipped, or leaning sideways on a toe pivot
const LOOSE_TILT = 12, LOOSE_ROLL = 15;
import * as FG from "./core/fingers.js";
import * as FL from "./core/fill.js";
import * as AL from "./core/alive.js";
import * as GT from "./core/gait.js";
import * as BL from "./core/balance.js";
import * as W from "./core/wrap.js";
import { Fx } from "./fx.js";
import { FxStudio } from "./fxstudio.js";
import { SetupEngine } from "./setup.js";
import { ComposeEngine } from "./compose.js";

export class App extends EventTarget {
  constructor() {
    super();
    Object.assign(this, {
      fighter: "vix", fighters: [], bones: [], doc: Doc.blank("untitled"), history: new History(), isNew: false, frame: 0, playing: false, speed: 1,
      playLoop: true, playRange: [0, -1], selBone: "hips", selBones: ["hips"], selKeys: [], selSocket: "", activeLayer: "", tool: "rotate",
      spaceGlobal: false, autokey: false, mirrorEdit: false, propagate: "pose", keepEnd: true, onion: { on: false, before: 2, after: 2, step: 3, keys: false },
      show: { bones: true, labels: true, trail: true, sockets: false, props: true, gameFeet: true, fingers: false, wrap: true, wrapCaps: false, fx: true }, stripCols: 8, stripFollow: false,
      pending: null, ctx: {}, poseCopy: null, keysCopy: [], agentFlash: 0, apiLog: [], status: "", statusKind: "info", sockSpecs: {}, ankle: 0,
      stage: null, views: null, info: null, wrapData: null, matchScale: 1, wrapStats: null, fxSel: -1, mode: "POSE", libraryTab: "Models",
      rigV5Data: null, rigSoles: null, v5Upgrade: null, v5: null, v5Axis: {}, boneTier: "simple",
    });
    this._solvers = new WeakMap();
    this._wrapTrack = null;
    this._wrapReport = null;
    this._dragStart = null;
    this._trail = { key: "", pts: [] };
    this._curves = new Map();
  }

  emit(what) { this.dispatchEvent(new CustomEvent("changed", { detail: what })); }
  on(fn) { this.addEventListener("changed", (e) => fn(e.detail)); }
  say(text, kind = "info") { this.status = text; this.statusKind = kind; this.emit("status"); }

  // ================================================================ boot
  async boot(stage, views) {
    this.stage = stage;
    this.views = views;
    this.info = await window.host.info();
    E.setClipLoader((n) => window.host.loadClip(n));
    await R.loadRigData();
    await FG.loadFingers();
    FL.setDna(await window.host.loadData("motion_dna.json"));   // learned from real motion (Fill timings, Alive)
    this.fighters = await window.host.fighters();
    const args = this.info.args;
    const arg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split("=").slice(1).join("=");
    this.fighter = this.fighters.includes(arg("fighter", "vix")) ? arg("fighter", "vix") : this.fighters[0];
    await this.setFighter(this.fighter, true);
    const sockets = (await window.host.loadData("sockets.json")) || {};
    this._sockData = sockets;
    this.loadSockets();
    this.fx = new Fx(this);   // effects on the clip (the clip's cues, the RMT effect library)
    await this.fx.init();
    this.fxs = new FxStudio(this);   // the FX mode: one effect block open for editing, playing beside the fighter
    await this.fxs.init();
    this.setup = new SetupEngine(this);   // the SETUP mode: the steps to game-ready and the fix for each
    await this.setup.refreshInfo();
    this.compose = new ComposeEngine(this);   // the COMPOSE mode: recipes and cue snaps (REVIEW's report is app.review, made with its panel)
    const clip = arg("clip", "w_walk");
    if (!(await this.openClip(clip, true))) this.say(`No clip named ${clip}.`, "warn");
  }

  // ================================================================ frame
  playRangeFrames() {
    const a = Math.max(0, Math.min(this.playRange[0], this.doc.frames));
    const b = this.playRange[1] < 0 ? this.doc.frames : Math.max(a, Math.min(this.playRange[1], this.doc.frames));
    return [a, b];
  }

  tick(dt) {
    if (this.playing) {
      const [a, b] = this.playRangeFrames();
      let f = this.frame + dt * this.doc.fps * this.speed;
      if (f > b) {
        if (this.playLoop) f = a + ((f - a) % Math.max(1, b - a));
        else { f = b; this.playing = false; this.emit("play"); }
      }
      this.frame = f;
      this.applyNow();
      this.emit("frame");
    }
    if (this.fxs) this.fxs.tick(dt);
    if (this.agentFlash > 0) this.agentFlash = Math.max(0, this.agentFlash - dt * 0.8);
  }

  setFrame(f) {
    f = Math.max(0, Math.min(Number(f), this.doc.frames));
    if (Math.abs(f - this.frame) < 1e-4 && !this.pending) return;
    if (this.pending) {
      this.pending = null;
      this.say("The pose you changed was not keyed (K keys it; AUTO KEY keys every edit).", "warn");
    }
    this.frame = f;
    this.applyNow();
    this.emit("frame");
  }

  step(n) { this.playing = false; this.setFrame(Math.round(this.frame) + n); }
  gotoKey(dir) { const k = dir > 0 ? this.doc.nextKey(this.frame) : this.doc.prevKey(this.frame); if (k >= 0) this.setFrame(k); }
  togglePlay() {
    this.playing = !this.playing;
    if (!this.playing) { this.frame = Math.round(this.frame); this.applyNow(); }
    else this.pending = null;
    this.emit("play");
  }

  // ================================================================ posing
  editablePose() {
    return this.pending ? { ...this.pending } : E.layerPose(this.doc, this.frame, this.bones);
  }

  finalPoseOn(body, f) { return E.finalPose(this.doc, f, body, this.bones, this.ctx); }

  applyNow() {
    const st = this.stage;
    if (!st || !st.body) return;
    E.solvePose(this.doc, this.frame, st.body, this.bones, this.ctx, this.editablePose());
    // the match's feet (real soles on the floor, flat) and its Body Solve (parts out of the body and the floor)
    const r = this.matchFinish(st.body, this.wrapCarry(this.frame));
    this.wrapStats = r ? r.stats : null;
    st.drawWrap(r && r.solver.wrap, this.show.wrapCaps && r ? this.wrapClashNow(st.body) : new Set(), this.show.wrapCaps && !!r);
    st.updateOnion(this);
    if (this.show.props) st.placeProps(this);
    if (this.fx) this.fx.afterPose();
    this.views && this.views.dirty();
  }

  jointWorld(n) { return this.stage.body.worldPos(n); }

  // a joint where the keys (and the feet) put it now, before the Body Solve moves anything: what IK reaches for and where a new
  // IK / aim target starts (the view shows the solved pose: jointWorld)
  keyedJoint(n) {
    const pr = this.stage.probe;
    E.solvePose(this.doc, this.frame, pr, this.bones, this.ctx, this.editablePose());
    this.matchFinish(pr, null, { solve: false });
    const p = pr.worldPos(n);
    pr.root.position.y = 0;
    pr.update();
    return p;
  }
  isBoneLocked(n) { return this.doc.isLocked(n); }

  async buildV5() {
    if (!this.rigV5Data) this.rigV5Data = await window.host.loadData("rig_v5.json");
    this.v5 = this.rigV5Data ? R5.build(this.rigV5Data, this.bones) : null;
    this.v5Axis = {};
    if (!this.v5) return;
    // natural limits for the v5-only joints (not in the game's animator_rig.json, which rig v4 wrote)
    for (const [b, lim] of Object.entries((this.rigV5Data && this.rigV5Data.limits) || {})) {
      if (!R.rigData.limits[b]) R.rigData.limits[b] = structuredClone(lim);
    }
    if (this.v5.style === "mixamo") {
      for (const actual of this.bones) {
        const rest = this.stage.body.rest.get(actual);
        if (!rest || !rest.q) continue;
        const inv = rest.q.clone().invert();
        const axes = [];
        for (let i = 0; i < 3; i++) {
          const v = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyQuaternion(inv);
          let best = 0, size = -1;
          for (let j = 0; j < 3; j++) { const a = Math.abs(v.getComponent(j)); if (a > size) { size = a; best = j; } }
          axes.push([best, v.getComponent(best) < 0 ? -1 : 1]);
        }
        this.v5Axis[actual] = axes;
      }
    }
    this.boneTier = this.boneTier === "advanced" ? "advanced" : "simple";
    const visible = this.visibleBones();
    if (!visible.includes(this.selBone)) {
      this.selBone = visible.includes("hips") ? "hips" : (visible[0] || "hips");
      this.selBones = [this.selBone];
    }
  }

  visibleBones() {
    return this.v5 ? this.v5.bones(this.boneTier) : this.bones;
  }

  boneLabel(actual) {
    const canonical = this.v5 && this.v5.reverse[actual];
    return canonical || actual;
  }

  boneSide(actual) {
    const name = this.boneLabel(actual);
    const m = /([LR])\d*$/.exec(name);
    return m ? m[1] : "";
  }

  setBoneTier(tier) {
    if (!this.v5 || !["simple", "advanced"].includes(tier)) return false;
    this.boneTier = tier;
    const visible = this.visibleBones();
    if (!visible.includes(this.selBone)) {
      this.selBone = visible.includes("hips") ? "hips" : (visible[0] || this.selBone);
      this.selBones = [this.selBone];
    }
    this.say(`${this.v5.name}: ${tier.toUpperCase()} — ${this.v5.counts[tier]} of ${this.v5.counts.advanced} bones.`);
    this.emit("bones");
    return true;
  }

  v5Info(tier = this.boneTier) {
    return this.v5 ? { ...this.v5.info(tier), upgrade: this.v5Upgrade } : null;
  }

  // a v5 control's drives on this model: the canonical channels turned onto the model's own local axes
  v5ControlFor(ctl) {
    const drives = ctl.drives.map((d) => {
      if (typeof d[1] === "string") return d;
      const axes = this.v5Axis[d[0]];
      const m = axes && axes[d[1]];
      return m ? [d[0], m[0], d[2] * m[1], d[3]] : d;
    });
    // a slider that reads only some drives (the Crouch reads the legs) follows the same axis mapping
    const measure = Array.isArray(ctl.measure) ? ctl.measure.map((m) => {
      const actual = (this.v5 && this.v5.mapping[m[0]]) || m[0];
      if (typeof m[1] === "string") return [actual, m[1]];
      const axes = this.v5Axis[actual];
      const ax = axes && axes[m[1]];
      return ax ? [actual, ax[0]] : [actual, m[1]];
    }) : ctl.measure;
    return { ...ctl, drives, measure };
  }

  applyV5Control(name, value) {
    if (!this.v5) return { error: "Rig v5 is not loaded for this fighter" };
    const ctl = this.v5.allControls.find((c) => c.name === name);
    if (!ctl) return { error: "no control named " + name, controls: this.v5.allControls.map((c) => c.name) };
    this.setControl(this.v5ControlFor(ctl), Number(value));
    return { ok: true, control: ctl.name, tier: ctl.tier };
  }

  selectBone(b, add = false) {
    if (!this.bones.includes(b)) return;
    if (add) {
      if (this.selBones.includes(b) && b !== this.selBone) this.selBones = this.selBones.filter((x) => x !== b);
      else if (!this.selBones.includes(b)) this.selBones.push(b);
    } else this.selBones = [b];
    this.selBone = b;
    this.views && this.views.dirty();
    this.emit("sel");
  }

  // the effect cue picked in the dope sheet's FX lane / the Effects panel / the Library
  selectFx(i) {
    this.fxSel = Number.isFinite(i) ? i : -1;
    this.emit("fxsel");
  }

  selectKeys(fs, add = false) {
    const out = add ? [...this.selKeys] : [];
    for (const f of fs) if (!out.includes(Number(f))) out.push(Number(f));
    this.selKeys = out;
    this.emit("keysel");
  }

  setTool(t) { this.tool = t; this.views && this.views.dirty(); this.emit("tool"); }

  dragBegin(label) {
    this._dragLabel = label;
    this._dragStart = this.editablePose();
    this.stage.probe.apply(this._dragStart);
  }

  dragEnd() {
    this._dragStart = null;
    if (!this.pending) return;
    if (this.autokey) this.keyNow(this._dragLabel);
    else this.emit("pending");
  }

  dragRotate(bone, axisWorld, angle) {
    if (!this._dragStart) this.dragBegin("Turn " + bone);
    this._setPending(this.rotateInPose(this._dragStart, bone, axisWorld, angle, this.stage.probe));
  }

  rotateInPose(base, bone, axisWorld, angle, body) {
    const pose = { ...base };
    if (!body.has(bone) || this.doc.isLocked(bone)) return pose;
    const own = base[bone] || [0, 0, 0];
    const total = boneRot(base, bone);
    const pq = body.parentWorldQuat(bone);
    const restQ = body.rest.get(bone).q;
    const lOld = restQ.clone().multiply(FG.mapQuat(body.fmap, bone, total));
    const rw = new THREE.Quaternion().setFromAxisAngle(axisWorld.clone().normalize(), angle);
    const lNew = pq.clone().invert().multiply(rw).multiply(pq).multiply(lOld);
    let eNew = E.nearestEuler(eulerOf(FG.unmapQuat(body.fmap, bone, restQ.clone().invert().multiply(lNew))), total);
    eNew = R.clampFingerTotal(bone, eNew);   // a finger's range is on its total turn (own + the joint it follows)
    pose[bone] = this.doc.guard(bone, own, sub3(eNew, sub3(total, own)));
    this._mirrorInto(pose, bone);
    return pose;
  }

  _mirrorInto(pose, bone) {
    if (!this.mirrorEdit) return;
    const m = R.mirrorName(bone);
    if (m === bone || !this.bones.includes(m)) return;
    pose[m] = this.doc.guard(m, pose[m] || [0, 0, 0], R.mirrorEuler(pose[bone]));
  }

  dragMove(deltaWorld) {
    if (!this._dragStart) this.dragBegin("Move body");
    if (this.doc.isLocked("hips")) return;
    const pose = { ...this._dragStart };
    const hips = this.stage.probe.bone("hips");
    const pq = this.stage.probe.parentWorldQuat("hips").invert();
    const d = deltaWorld.clone().applyQuaternion(pq);
    pose._dx = (this._dragStart._dx || 0) + d.x;
    pose._dy = (this._dragStart._dy || 0) + d.y;
    pose._dz = (this._dragStart._dz || 0) + d.z;
    if (hips) this._setPending(pose);
  }

  dragIK(bone, targetWorld) {
    if (!this._dragStart) this.dragBegin("IK " + bone);
    const body = this.stage.probe;
    body.apply(this._dragStart);
    if (!body.has(bone)) return;
    const touched = new Set();
    const limb = R.limbOfEnd(bone);
    if (limb) {
      const ids = R.LIMBS[limb];
      const keep = this.keepEnd ? body.worldQuat(ids[2]) : null;
      E.solveTwoBone(body, ids[0], ids[1], ids[2], targetWorld, null, keep, 1);
      ids.forEach((n) => touched.add(n));
    } else if (bone === "hips") {
      return this.dragMove(targetWorld.clone().sub(body.worldPos("hips")));
    } else {
      E.ccd(body, bone, targetWorld).forEach((n) => touched.add(n));
    }
    const pose = E.readBack(body, this._dragStart, touched);
    for (const n of touched) {
      pose[n] = this.doc.guard(n, this._dragStart[n] || [0, 0, 0], pose[n]);
      this._mirrorInto(pose, n);
    }
    this._setPending(pose);
  }

  _setPending(pose) {
    this.pending = pose;
    this.applyNow();
    this.emit("pending");
  }

  editPose(pose, label, key = false, who = "you") {
    this._setPending(pose);
    if (this.autokey || key) return this.keyNow(label, who);
    return { frame: Math.round(this.frame), keyed: false };
  }

  setBoneEuler(bone, e, label = "") {
    const p = this.editablePose();
    p[bone] = this.doc.guard(bone, p[bone] || [0, 0, 0], e);
    this._mirrorInto(p, bone);
    this.editPose(p, label || "Set " + bone);
  }

  setHipsShift(ax, v) {
    const p = this.editablePose();
    p["_" + ax] = v;
    this.editPose(p, "Hips " + ax);
  }

  revertPending() {
    if (!this.pending) return;
    this.pending = null;
    this.applyNow();
    this.emit("pending");
    this.say("Unkeyed changes thrown away.");
  }

  // ================================================================ document changes
  mutate(label, fn, who = "you") {
    const before = this.doc.toDict();
    const r = fn();
    this.doc.normalize();
    this.history.commit(label, before, this.doc.toDict(), who);
    if (who !== "you") this.agentFlash = 1;
    this.docChanged();
    return r;
  }

  docChanged() {
    this.ctx = {};
    this._wrapTrack = null;
    this._wrapReport = null;
    this._trail.key = "";
    this._curves.clear();
    this.selKeys = this.selKeys.filter((f) => this.doc.hasKey(f));
    this.applyNow();
    this.views && this.views.stripDirty();
    this.updateTitle();
    this.emit("doc");
  }

  updateTitle() { window.host.setTitle(`RMT Animation Studio - ${this.fighter} / ${this.doc.name}${this.history.dirty() ? " *" : ""}`); }

  undo() {
    const e = this.history.undo();
    if (!e) return this.say("Nothing to undo.");
    this.doc.loadDict(e.before);
    this.pending = null;
    this.docChanged();
    this.say("Undid: " + e.label);
  }

  redo() {
    const e = this.history.redo();
    if (!e) return this.say("Nothing to redo.");
    this.doc.loadDict(e.after);
    this.pending = null;
    this.docChanged();
    this.say("Redid: " + e.label);
  }

  // ================================================================ keys
  keyNow(label = "", who = "you") {
    const f = Math.round(this.frame);
    if (this.doc.isKeyLocked(f)) {
      this.say(`The key at f${f} is locked (Key menu > Unlock).`, "warn");
      return { ok: false, error: "key locked" };
    }
    const pose = this.editablePose();
    let updated = [];
    const layer = this.activeLayer ? this.doc.layerById(this.activeLayer) : null;
    if (layer) this._keyLayer(f, pose, label, who, layer);
    else {
      this.mutate(label || `Key f${f}`, () => {
        const before = this.doc.writeKey(f, pose, this.bones);
        if (before && this.propagate !== "off") updated = this.doc.propagate(f, before, pose, this.bones, this.propagate);
      }, who);
    }
    this.pending = null;
    this.applyNow();
    this.say(`Keyed f${f}` + (updated.length ? ` - also updated the same key at f${updated.join(", f")}` : ""), who !== "you" ? "agent" : "ok");
    this.emit("pending");
    return { ok: true, frame: f, also_updated: updated };
  }

  _keyLayer(f, want, label, who, l) {
    if ((l.source || "keys") !== "keys") return this.say(`Layer ${l.name} plays a clip; pick a keys layer or the base.`, "warn");
    const now = E.layerPose(this.doc, f, this.bones);
    const w = Math.max(0.05, E.layerWeight(l, f, this.doc.frames));
    const own = E.layerValue(l, f, this.bones, this.doc.loop) || {};
    const lp = {};
    for (const b of this.bones) lp[b] = own[b] || [0, 0, 0];
    for (const b of R.maskBones(l.mask || [], this.bones)) {
      const d = sub3(want[b] || [0, 0, 0], now[b] || [0, 0, 0]);
      if (Math.hypot(...d) > 1e-6) lp[b] = add3(lp[b], d.map((x) => x / w));
    }
    for (const ax of ["_dy", "_dx", "_dz"]) lp[ax] = (own[ax] || 0) + ((want[ax] || 0) - (now[ax] || 0)) / w;
    this.mutate(label || `Key layer ${l.name} f${f}`, () => {
      const ks = l.keys || (l.keys = []);
      let k = ks.find((x) => x.f === f);
      if (!k) { k = { f }; ks.push(k); }
      fillKey(k, lp, this.bones);
    }, who);
  }

  deleteKeys(fs, who = "you") {
    if (!fs.length) fs = [Math.round(this.frame)];
    const locked = fs.filter((f) => this.doc.isKeyLocked(f));
    this.mutate("Delete keys", () => fs.forEach((f) => !this.doc.isKeyLocked(f) && this.doc.deleteKey(f)), who);
    this.selKeys = [];
    this.say(`Deleted ${fs.length - locked.length} key(s)${locked.length ? ` (${locked.length} locked kept)` : ""}.`);
  }

  moveKeys(fs, delta, who = "you") {
    if (!this.doc.canMove(fs, delta)) {
      this.say("Keys cannot land on other keys, go before frame 0, or move while locked.", "warn");
      return false;
    }
    this.mutate(`Move keys ${delta > 0 ? "+" : ""}${delta}`, () => this.doc.moveKeys(fs, delta), who);
    this.selKeys = fs.map((f) => f + delta);
    this.emit("keysel");
    return true;
  }

  setKeysField(fs, field, value, who = "you") {
    if (!fs.length) fs = [Math.round(this.frame)];
    this.mutate("Key " + field, () => fs.forEach((f) => this.doc.setKeyField(f, field, value)), who);
  }

  setKeyChannel(f, bone, axis, value, who = "you") {
    const k = this.doc.keyAt(f);
    if (!k || this.doc.isKeyLocked(f) || this.doc.isLocked(bone, axis)) return this.say("Locked.", "warn");
    const before = poseOfKey(k, this.bones);
    const after = { ...before };
    const e = [...(after[bone] || [0, 0, 0])];
    e[axis] = value;
    after[bone] = R.clampLimits(bone, e);
    this.mutate(`Set ${bone} ${"XYZ"[axis]} f${f}`, () => {
      this.doc.writeKey(f, after, this.bones);
      if (this.propagate !== "off") this.doc.propagate(f, before, after, this.bones, this.propagate);
    }, who);
  }

  setKeyHips(f, ax, value, who = "you") {
    const k = this.doc.keyAt(f);
    if (!k || this.doc.isKeyLocked(f)) return;
    const before = poseOfKey(k, this.bones);
    const after = { ...before, ["_" + ax]: value };
    this.mutate(`Hips ${ax} f${f}`, () => {
      this.doc.writeKey(f, after, this.bones);
      if (this.propagate !== "off") this.doc.propagate(f, before, after, this.bones, this.propagate);
    }, who);
  }

  linkKeys(fs, who = "you") {
    if (fs.length < 2) return this.say("Select two or more keys to link (they become the same key: edit one, all follow).", "warn");
    const id = this.mutate("Link keys", () => this.doc.linkKeys(fs, this.bones, true), who);
    this.say(`Linked f${fs.join(", f")} as ${id}: they now share one pose.`, "ok");
  }

  unlinkKeys(fs, who = "you") { this.mutate("Unlink keys", () => this.doc.unlinkKeys(fs), who); }

  copyKeys(fs) {
    const lo = Math.min(...fs);
    this.keysCopy = fs.map((f) => { const k = structuredClone(this.doc.keyAt(f)); k.f -= lo; delete k.link; delete k.lock; return k; });
    this.say(`Copied ${this.keysCopy.length} key(s).`);
  }

  pasteKeys(at, who = "you") {
    if (!this.keysCopy.length) return this.say("No keys copied.", "warn");
    this.mutate(`Paste keys at f${at}`, () => {
      for (const k of this.keysCopy) {
        const nf = at + k.f;
        if (this.doc.isKeyLocked(nf)) continue;
        this.doc.writeKey(nf, poseOfKey(k, this.bones), this.bones);
        for (const fld of ["ease", "tag"]) if (k[fld]) this.doc.setKeyField(nf, fld, k[fld]);
      }
    }, who);
  }

  mirrorKeys(fs, who = "you") {
    this.mutate("Mirror keys", () => {
      for (const f of fs) {
        const k = this.doc.keyAt(f);
        if (k && !k.lock) this.doc.writeKey(f, this.mirrored(poseOfKey(k, this.bones), "flip"), this.bones);
      }
    }, who);
  }

  // ================================================================ frames / clip
  insertFrames(at, n, who = "you") { this.mutate(`Insert ${n} frames at f${at}`, () => this.doc.insertFrames(at, n), who); }
  deleteFrames(at, n, who = "you") { this.mutate(`Delete ${n} frames at f${at}`, () => this.doc.deleteFrames(at, n), who); this.setFrame(Math.min(this.frame, this.doc.frames)); }
  scaleTime(factor, fs = [], who = "you") { this.mutate(`Scale time x${factor}`, () => this.doc.scaleTime(factor, fs.length ? Math.min(...fs) : 0, fs), who); }
  reverseRange(a, b, who = "you") { this.mutate(`Reverse f${a}-f${b}`, () => this.doc.reverse(a, b), who); }

  setClipProp(prop, value, who = "you") {
    this.mutate("Clip " + prop, () => {
      const d = this.doc;
      if (prop === "frames") d.frames = Math.max(1, value | 0);
      else if (prop === "fps") d.fps = Math.max(1, value | 0);
      else if (prop === "note") d.extra.note = String(value);
      else if (prop === "marks") d.extra.marks = value;
      else d[prop] = value;
    }, who);
    if (this.frame > this.doc.frames) this.setFrame(this.doc.frames);
  }

  closeLoop(who = "you") {
    const k0 = this.doc.keys[0];
    this.mutate("Close loop", () => {
      this.doc.writeKey(this.doc.frames, poseOfKey(k0, this.bones), this.bones);
      this.doc.loop = true;
      this.doc.linkKeys([k0.f, this.doc.frames], this.bones, false);
    }, who);
    this.say(`Frame ${this.doc.frames} is now the same key as frame ${k0.f} (linked): the loop is seamless.`, "ok");
  }

  setLock(bone, channels, who = "you") { this.mutate(`Lock ${bone} ${channels || "off"}`, () => this.doc.setLock(bone, channels), who); }

  toggleLockSelected() {
    const lockAll = !this.doc.isLocked(this.selBone);
    this.mutate(lockAll ? "Lock" : "Unlock", () => this.selBones.forEach((b) => this.doc.setLock(b, lockAll ? "xyz" : "")));
    this.say((lockAll ? "Locked " : "Unlocked ") + this.selBones.join(", "));
  }

  // ================================================================ pose tools
  mirrored(pose, mode) {
    const out = { ...pose };
    for (const b of this.bones) {
      const m = R.mirrorName(b);
      const e = pose[b] || [0, 0, 0];
      if (m === b) { if (mode === "flip") out[b] = R.mirrorEuler(e); continue; }
      const side = R.sideOf(b);
      if (mode === "flip" || (mode === "l2r" && side === "L") || (mode === "r2l" && side === "R")) out[m] = R.mirrorEuler(e);
    }
    if (mode === "flip") out._dx = -(pose._dx || 0);
    return out;
  }

  poseMirror(mode, who = "you") {
    const p = this.editablePose();
    const m = this.mirrored(p, mode);
    for (const b of this.bones) m[b] = this.doc.guard(b, p[b] || [0, 0, 0], m[b] || [0, 0, 0], false);
    return this.editPose(m, { flip: "Flip pose", l2r: "Mirror L to R", r2l: "Mirror R to L" }[mode] || "Mirror", false, who);
  }

  resetBones(list, who = "you") {
    const p = this.editablePose();
    for (const b of list) {
      if (b === "hips_move") { p._dx = 0; p._dy = 0; p._dz = 0; }
      else if (!this.doc.isLocked(b)) p[b] = this.doc.guard(b, p[b] || [0, 0, 0], [0, 0, 0], false);
    }
    return this.editPose(p, "Reset " + (list.length < 4 ? list.join(", ") : `${list.length} bones`), false, who);
  }

  copyPose() { this.poseCopy = this.editablePose(); this.say(`Pose copied (f${Math.round(this.frame)}).`); }

  pastePose(mirror = false, onlySel = false) {
    if (!this.poseCopy) return this.say("No pose copied.", "warn");
    const src = mirror ? this.mirrored(this.poseCopy, "flip") : this.poseCopy;
    this.editPose(this.applyPoseDict(this.editablePose(), src, onlySel ? this.selBones : [], 1), "Paste pose");
  }

  applyPoseDict(base, src, only, weight) {
    const out = { ...base };
    for (const b of only.length ? only : this.bones) {
      const cur = base[b] || [0, 0, 0];
      out[b] = this.doc.guard(b, cur, lerp3(cur, src[b] || [0, 0, 0], weight));
    }
    if (!only.length || only.includes("hips")) for (const ax of ["_dy", "_dx", "_dz"]) out[ax] = (base[ax] || 0) + ((src[ax] || 0) - (base[ax] || 0)) * weight;
    return out;
  }

  breakdown(t, who = "you") {
    const a = this.doc.prevKey(this.frame + 0.001), b = this.doc.nextKey(this.frame);
    if (a < 0 || b < 0) return this.say("A breakdown needs a key before and after this frame.", "warn");
    const pa = poseOfKey(this.doc.keyAt(a), this.bones), pb = poseOfKey(this.doc.keyAt(b), this.bones);
    const mid = {};
    for (const n of this.bones) mid[n] = lerp3(pa[n], pb[n], t);
    for (const ax of ["_dy", "_dx", "_dz"]) mid[ax] = pa[ax] + (pb[ax] - pa[ax]) * t;
    return this.editPose(this.applyPoseDict(this.editablePose(), mid, [], 1), `Breakdown ${Math.round(t * 100)}%`, false, who);
  }

  setControl(ctl, value, who = "you") {
    const p = this.editablePose();
    // A grounded control folds the legs and the hips come down by exactly what the fold takes. The hips dy in
    // the file is a hint for the Godot Animator (which plays the drives raw); here the feet decide the height.
    // Measure on the posed body (with the match's Body Solve), so a full crouch plants the soles where they
    // already stand instead of lifting them.
    if (ctl.grounded && this.stage && this.stage.body) {
      const body = this.stage.body;
      body.update();
      const h0 = this.footLow(body);
      let np = R.setControl(ctl, p, value);
      for (const b of this.bones) np[b] = this.doc.guard(b, p[b] || [0, 0, 0], np[b] || [0, 0, 0]);
      const h1 = this.measurePose(np);
      if (Number.isFinite(h0) && Number.isFinite(h1) && Math.abs(h1 - h0) > 1e-5) {
        np = { ...np, _dy: (np._dy || 0) + (h0 - h1) };
        for (const b of this.bones) np[b] = this.doc.guard(b, p[b] || [0, 0, 0], np[b] || [0, 0, 0]);
      }
      return this.editPose(np, "Control " + ctl.name, false, who);
    }
    const np = R.setControl(ctl, p, value);
    for (const b of this.bones) np[b] = this.doc.guard(b, p[b] || [0, 0, 0], np[b] || [0, 0, 0]);
    return this.editPose(np, "Control " + ctl.name, false, who);
  }

  // pose the match (feet + Body Solve) on the body without touching the views; returns the lower sole's height
  measurePose(pose) {
    const body = this.stage.body;
    if (!body) return Infinity;
    E.solvePose(this.doc, this.frame, body, this.bones, this.ctx, pose);
    this.matchFinish(body, this.wrapCarry(this.frame));
    return this.footLow(body);
  }

  // the lowest point of the lower sole on a posed body (metres, world)
  footLow(body) {
    let lo = Infinity;
    for (const b of ["footL", "footR"]) if (body.has(b)) lo = Math.min(lo, F.lowest(body, b));
    return lo;
  }

  async listPoses() { return window.host.listPoses(); }

  async saveLibraryPose(name, onlySel = false) {
    name = String(name).trim().replace(/ /g, "_");
    if (!/^[A-Za-z0-9_\-]+$/.test(name)) { this.say("Not a good pose name.", "warn"); return false; }
    const p = this.editablePose();
    const rot = {};
    for (const b of onlySel ? this.selBones : this.bones) {
      const e = p[b] || [0, 0, 0];
      if (onlySel || Math.hypot(...e) > 1e-5) rot[b] = e.map((x) => Math.round(x * 10000) / 10000);
    }
    const ok = await window.host.savePose({ name, rot, hips_dy: p._dy || 0, hips_dx: p._dx || 0, hips_dz: p._dz || 0, partial: onlySel, from: `${this.doc.name} f${Math.round(this.frame)}` });
    this.say(ok ? `Saved pose "${name}".` : "Could not save the pose.", ok ? "ok" : "error");
    this.emit("poses");
    return ok;
  }

  async applyLibraryPose(name, onlySel, weight, mirror, who = "you") {
    const d = await window.host.loadPose(name);
    if (!d) return false;
    let p = poseOfKey({ rot: d.rot, hips_dy: d.hips_dy, hips_dx: d.hips_dx, hips_dz: d.hips_dz }, this.bones);
    if (mirror) p = this.mirrored(p, "flip");
    let only = onlySel ? this.selBones : [];
    if (d.partial && !only.length) only = Object.keys(d.rot || {});
    this.editPose(this.applyPoseDict(this.editablePose(), p, only, weight), "Pose " + name, false, who);
    return true;
  }

  // ================================================================ layers / constraints
  async addLayer(def, who = "you") {
    if (def.source === "clip") await E.preloadClip(def.clip);
    return this.mutate("Add layer", () => this.doc.addLayer(def), who);
  }

  async setLayer(id, props, who = "you") {
    const l = this.doc.layerById(id);
    if (!l) return;
    if (props.clip) await E.preloadClip(props.clip);
    this.mutate("Layer " + Object.keys(props).join(", "), () => Object.assign(l, props), who);
  }

  removeLayer(id, who = "you") {
    if (this.activeLayer === id) this.activeLayer = "";
    this.mutate("Remove layer", () => this.doc.removeById(this.doc.layers, id), who);
  }

  setActiveLayer(id) {
    this.activeLayer = id;
    this.pending = null;
    this.applyNow();
    const l = this.doc.layerById(id);
    this.say(l ? `Keys now go into layer "${l.name}".` : "Keys now go into the base clip.");
    this.emit("layer");
  }

  addConstraint(def, who = "you") {
    def = structuredClone(def);
    const r3 = (p) => [p.x, p.y, p.z].map((x) => Math.round(x * 1000) / 1000);
    if (def.type === "ik" && (!def.target || !Object.keys(def.target).length)) {
      const end = (R.LIMBS[def.limb] || [])[2];
      if (end) def.target = { pos: r3(this.keyedJoint(end)) };
    }
    if (def.type === "aim" && (!def.target || !Object.keys(def.target).length)) def.target = { pos: r3(this.keyedJoint(def.bone || "head").add(new THREE.Vector3(0, 0, 1.5))) };
    if (def.type === "pin" && def.pin_frame === undefined) { def.pin_frame = Math.round(this.frame); if (def.start === undefined) def.start = def.pin_frame; }
    return this.mutate("Add " + (def.type || "constraint"), () => this.doc.addConstraint(def), who);
  }

  setConstraint(id, props, who = "you") {
    const c = this.doc.constraintById(id);
    if (c) this.mutate("Constraint " + Object.keys(props).join(", "), () => Object.assign(c, props), who);
  }

  removeConstraint(id, who = "you") { this.mutate("Remove constraint", () => this.doc.removeById(this.doc.constraints, id), who); }

  moveInList(list, id, dir, label) {
    this.mutate(label, () => {
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return;
      const j = Math.max(0, Math.min(list.length - 1, i + dir));
      const [it] = list.splice(i, 1);
      list.splice(j, 0, it);
    });
  }

  pinSelected(end = -1, who = "you") {
    const f = Math.round(this.frame);
    const c = this.addConstraint({ type: "pin", bone: this.selBone, what: "both", pin_frame: f, start: f, end, name: "FREEZE " + this.selBone }, who);
    this.say(`${this.selBone} is frozen in the world from f${f}.`, "ok");
    return c;
  }

  bakeToKeys(who = "you") {
    const baked = E.bake(this.doc, this.stage.probe, this.bones, this.ctx);
    this.mutate("Bake layers + constraints into keys", () => {
      this.doc.keys = baked;
      this.doc.layers.forEach((l) => (l.mute = true));
      this.doc.constraints.forEach((c) => (c.enabled = false));
    }, who);
    this.say(`Baked ${baked.length} frames into keys; layers muted, constraints off (undo brings them back).`, "ok");
  }

  // Adjust (core/adjust.js): `bone` turned by `turn` (radians, the total for this span) on top of its keys, over a scope: "all"
  // frames, "frame" = around frame `at` (-1: the current one) easing over `ease` frames, "range" = from..to (to -1: the end).
  // mirror: the other side gets the mirrored turn. A zero turn removes the adjustment. Returns the adjustment layers.
  adjustPart(bone, turn, scope = "all", at = -1, from = 0, to = -1, ease = 6, mirror = false, who = "you") {
    if (!this.bones.includes(bone)) { this.say(`No bone ${bone} on ${this.fighter}.`, "warn"); return []; }
    if (at < 0) at = Math.round(this.frame);
    if (to < 0) to = this.doc.frames;
    const sp = A.span(scope, at, from, to, ease);
    const targets = [[bone, turn]];
    if (mirror && R.sideOf(bone) && this.bones.includes(R.mirrorName(bone))) targets.push([R.mirrorName(bone), R.mirrorEuler(turn)]);
    const out = [];
    this.mutate(`Adjust ${bone}`, () => {
      for (const [b, v] of targets) {
        const l = A.find(this.doc, b, scope, sp);
        if (Math.hypot(...v) < 1e-5) { if (l) this.doc.removeById(this.doc.layers, l.id); continue; }
        const def = A.layerDef(b, scope, sp, v);
        if (!l) out.push(this.doc.addLayer(def));
        else { Object.assign(l, def); out.push(l); }
      }
    }, who);
    return out;
  }

  // the turn an adjustment of `bone` with this scope has now (radians; zero = none)
  adjustValue(bone, scope = "all", at = -1, from = 0, to = -1, ease = 6) {
    if (at < 0) at = Math.round(this.frame);
    if (to < 0) to = this.doc.frames;
    return A.value(A.find(this.doc, bone, scope, A.span(scope, at, from, to, ease)));
  }

  // take an adjustment off (its id), or every adjustment of a bone, or all of them (bone "")
  adjustRestore(id = "", bone = "", who = "you") {
    const gone = A.adjustLayers(this.doc).filter((l) => (id ? l.id === id : !bone || l.bone === bone));
    if (!gone.length) return 0;
    this.mutate(`Restore ${bone || (id ? "adjustment" : "all adjustments")}`, () => gone.forEach((l) => this.doc.removeById(this.doc.layers, l.id)), who);
    this.say(`Restored ${gone.length} adjustment${gone.length === 1 ? "" : "s"}: the keys are as they were.`, "ok");
    return gone.length;
  }

  // Merge (core/merge.js): `clip` on top of the open clip, giving only `parts` (M.PARTS), its frame 0 at `start` (-1: the
  // current frame), blending in and out over that many frames
  async mergeAdd(clip, parts = M.DEFAULT_PARTS, start = -1, blendIn = 10, blendOut = 10, weight = 1, cycle = false, who = "you") {
    if (!(await E.preloadClip(clip))) { this.say(`No clip named ${clip}.`, "warn"); return null; }
    if (start < 0) start = Math.round(this.frame);
    const l = await this.addLayer(M.layerDef(clip, parts, start, blendIn, blendOut, weight, cycle), who);
    this.say(`${clip} on top from f${start} (${parts.join(", ")}). Play to see it; Bake makes one clip.`, who !== "you" ? "agent" : "ok");
    return l;
  }

  // change a clip on top: parts, start, blend_in / blend_out, weight, cycle, speed, mute (the fields that follow move with it)
  async mergeSet(id, props, who = "you") {
    const l = this.doc.layerById(id);
    if (!l) return;
    const p = { ...props };
    if ("blend_in" in p) { p.fade_in = p.blend_in; delete p.blend_in; }
    if ("blend_out" in p) { p.fade_out = p.blend_out; delete p.blend_out; }
    await this.setLayer(id, M.follow(l, p), who);
  }

  // the merge as ONE new clip (opens unsaved; the base clip is not touched)
  mergeBake(name, who = "you") {
    if (!/^[A-Za-z0-9_\-]+$/.test(String(name))) return { error: "bad clip name" };
    if (!M.mergeLayers(this.doc).length) { this.say("Add a clip on top first (Merge panel).", "warn"); return { error: "no clips on top" }; }
    const base = this.doc.name;
    const nd = M.bake(this.doc, this.stage.probe, this.bones, name);
    this._setDoc(nd, true);
    if (who !== "you") this.agentFlash = 1;
    this.say(`Merged into ${name}: ${nd.frames} frames, ${nd.keys.length} keys (${base} is unchanged). Save it to keep it.`, who !== "you" ? "agent" : "ok");
    return { name, frames: nd.frames, keys: nd.keys.length, base };
  }

  // a merged clip's recipe back as a live setup: its base opens with the clips on top again (changes to the open clip are lost)
  async mergeRebuild(who = "you") {
    const r = this.doc.extra.merge;
    if (!r) return false;
    const madeFrom = this.doc.name;
    if (!(await this.openClip(String(r.base || ""), true))) { this.say(`The base clip ${r.base} is gone.`, "warn"); return false; }
    for (const d of r.layers || []) {
      await E.preloadClip(String(d.clip));
      await this.addLayer(M.layerDef(String(d.clip), d.parts || M.DEFAULT_PARTS, Number(d.start || 0), Number(d.blend_in || 0), Number(d.blend_out || 0),
        Number(d.weight ?? 1), !!d.cycle, Number(d.speed ?? 1)), who);
    }
    this.say(`Rebuilt the merge behind ${madeFrom}: ${this.doc.name} with ${(r.layers || []).length} clips on top.`, "ok");
    return true;
  }

  // Fill (core/fill.js): the span to fill. opts from / to (frames), else the keys around the current frame; [] when there is none
  fillSpan(opts = {}) {
    if ("from" in opts && "to" in opts) {
      const a = Math.trunc(Number(opts.from)), b = Math.trunc(Number(opts.to));
      return a >= 0 && b <= this.doc.frames && b - a >= 2 ? [a, b] : [];
    }
    return FL.spanAround(this.doc, this.frame);
  }

  // make the frames between two keys (FL.DEFAULTS for the settings). Filling the same span again replaces its fill and keeps
  // the settings you did not pass, so turning a knob refills live (one undo step while you drag). Returns {id, from, to, keys,
  // engine, match, feet, settings} or {error}
  async fillApply(opts = {}, who = "you") {
    const sp = this.fillSpan(opts);
    if (!sp.length) { this.say("Fill needs a key before and after this frame, at least 2 frames apart (or from / to).", "warn"); return { error: "no span" }; }
    const [a, b] = sp;
    if (FL.lockedInside(this.doc, a, b)) { this.say(`A locked key sits between f${a} and f${b}: unlock it to fill there.`, "warn"); return { error: "locked key" }; }
    const old = FL.atSpan(this.doc, a, b);
    const want = { ...(old ? old.settings : {}) };
    for (const k in opts) want[k] = opts[k];
    const s = FL.settings(want);
    if (s.engine === "library") await this.fillLibrary();
    const made = FL.make(this.doc, this.bones, this.stage.probe, a, b, s);
    if (made.error) { this.say(`Fill: ${made.error}.`, "warn"); return { error: made.error }; }
    const n = Object.keys(made.poses).length;
    if (!n) { this.say(`Fill: f${a} to f${b} has no frame in between at this key step.`, "warn"); return { error: "nothing between" }; }
    const id = old ? old.id : FL.nextId(this.doc);
    this.mutate(`Fill f${a}-f${b}`, () => FL.write(this.doc, this.bones, a, b, made, s, id), who);
    this.say(`Filled ${FL.describe(FL.find(this.doc, id))} (${n} keys).`, who !== "you" ? "agent" : "ok");
    return { id, from: a, to: b, keys: n, engine: s.engine, match: made.match, feet: made.feet, settings: s };
  }

  // the clip library for Fill, read once (again when a clip file changed)
  async fillLibrary(force = false) {
    return FL.libraryIndex((have) => window.host.clipLibrary(have), force);
  }

  // the library stretches that best join the two poses (FL.matches); opts from / to, n
  async fillMatches(opts = {}) {
    const sp = this.fillSpan(opts);
    if (!sp.length) return [];
    await this.fillLibrary();
    return FL.matches(this.doc, this.bones, sp[0], sp[1], Number(opts.n ?? 5));
  }

  // take a fill out ("" = every fill); returns how many keys went
  fillRemove(id = "", who = "you") {
    const ids = id ? [id] : this.doc.fills.map((fl) => fl.id);
    if (!ids.length || (id && !FL.find(this.doc, id))) return 0;
    const gone = this.mutate(ids.length === 1 ? "Remove fill" : "Remove fills", () => ids.reduce((n, i) => n + FL.remove(this.doc, i), 0), who);
    this.say(`Fill removed: ${gone} keys went, the keys around it are as they were.`, who !== "you" ? "agent" : "ok");
    return gone;
  }

  // the real-motion folder Fill's library searches too (the Motion Library's clips, as real/<clip>); a path sets it
  // ("" = our clips only). Returns {folder, clips}
  async fillRealFolder(folder = null) {
    const f = await window.host.realFolder(folder);
    await this.fillLibrary(folder !== null);
    return { folder: f, clips: FL.realCount() };
  }

  // ================================================================ alive (core/alive.js)
  // put breathing and life on the clip (AL): one Alive layer, replacing the one there was. opts mood calm|fight|tired, amount
  // (1 = like real idles), holds (quieter while the base moves), seed, from / to (default the whole clip).
  // Returns {id, keys, mood, periods, bones, settings} or {error}
  aliveAdd(opts = {}, who = "you") {
    const old = AL.layers(this.doc);
    const want = { ...(old.length ? old[0].alive : {}) };
    for (const k in opts) want[k] = opts[k];
    const def = AL.makeLayer(this.doc, this.bones, want);
    if (def.error) { this.say(`Alive: ${def.error}.`, "warn"); return { error: def.error }; }
    const made = this.mutate(`Alive (${def.alive.mood})`, () => {
      for (const o of old) this.doc.removeById(this.doc.layers, o.id);
      return this.doc.addLayer(def);
    }, who);
    const l = this.doc.layerById(made.id) || made;
    this.say(`Alive: ${AL.describe(l)} (${l.keys.length} keys on ${l.mask.join(", ")}).`, who !== "you" ? "agent" : "ok");
    return { id: l.id, keys: l.keys.length, mood: def.alive.mood, periods: l.periods, bones: l.mask, settings: def.alive };
  }

  // ================================================================ gait (core/gait.js)
  // put a real walk / run's upper-body motion on the clip in time with its steps (GT): one Gait layer, replacing the one there
  // was. opts kind auto|walk|run, speed (H/s, 0 = from the stride), amount, from / to. The clip's own motion is measured on its
  // base keys (layers left out), so the old Gait never counts as the clip's. Returns {id, keys, kind, speed, stride_s, strides,
  // bones, settings} or {error}
  gaitAdd(opts = {}, who = "you") {
    const old = GT.layers(this.doc);
    const want = {};
    if (old.length) for (const k in GT.DEFAULTS) want[k] = old[0].gait[k] ?? GT.DEFAULTS[k];
    for (const k in opts) want[k] = opts[k];
    const def = GT.makeLayer(this.doc, this.bones, want);
    if (def.error) { this.say(`Gait: ${def.error}.`, "warn"); return { error: def.error }; }
    const made = this.mutate(`Gait (${def.gait.kind})`, () => {
      for (const o of old) this.doc.removeById(this.doc.layers, o.id);
      return this.doc.addLayer(def);
    }, who);
    const l = this.doc.layerById(made.id) || made;
    this.say(`Gait: ${GT.describe(l)} (${l.keys.length} keys on ${l.mask.join(", ")}).`, who !== "you" ? "agent" : "ok");
    const g = l.gait;
    return { id: l.id, keys: l.keys.length, kind: g.kind, speed: g.speed, stride_s: g.stride_s, strides: g.strides, bones: l.mask, settings: g };
  }

  // ================================================================ balance (core/balance.js)
  // lean the torso and chest away from every kick in the clip, learned from real swing kicks (BL): one Balance layer, replacing
  // the one there was. opts amount, from / to. Returns {id, keys, kicks, bones, settings} or {error}
  balanceAdd(opts = {}, who = "you") {
    const old = BL.layers(this.doc);
    const want = {};
    if (old.length) for (const k in BL.DEFAULTS) want[k] = old[0].balance[k] ?? BL.DEFAULTS[k];
    for (const k in opts) want[k] = opts[k];
    const def = BL.makeLayer(this.doc, this.bones, want);
    if (def.error) { this.say(`Balance: ${def.error}.`, "warn"); return { error: def.error }; }
    const made = this.mutate("Balance", () => {
      for (const o of old) this.doc.removeById(this.doc.layers, o.id);
      return this.doc.addLayer(def);
    }, who);
    const l = this.doc.layerById(made.id) || made;
    this.say(`Balance: ${BL.describe(l)} (on ${l.mask.join(", ")}).`, who !== "you" ? "agent" : "ok");
    return { id: l.id, keys: l.keys.length, kicks: BL.describe(l), bones: l.mask, settings: l.balance };
  }

  // take the Balance layer off; returns how many layers went
  balanceRemove(who = "you") {
    const old = BL.layers(this.doc);
    if (!old.length) return 0;
    this.mutate("Remove Balance", () => { for (const o of old) this.doc.removeById(this.doc.layers, o.id); }, who);
    this.say("Balance is off: the kicks lean as keyed.", who !== "you" ? "agent" : "ok");
    return old.length;
  }

  // take the Gait layer off; returns how many layers went
  gaitRemove(who = "you") {
    const old = GT.layers(this.doc);
    if (!old.length) return 0;
    this.mutate("Remove Gait", () => { for (const o of old) this.doc.removeById(this.doc.layers, o.id); }, who);
    this.say("Gait is off: the clip walks as keyed.", who !== "you" ? "agent" : "ok");
    return old.length;
  }

  // take the Alive layer off; returns how many layers went
  aliveRemove(who = "you") {
    const old = AL.layers(this.doc);
    if (!old.length) return 0;
    this.mutate("Remove Alive", () => { for (const o of old) this.doc.removeById(this.doc.layers, o.id); }, who);
    this.say("Alive is off: the clip holds still again.", who !== "you" ? "agent" : "ok");
    return old.length;
  }

  async makeTransitionClip(clipB, at, blend, name, who = "you") {
    const cb = await E.preloadClip(clipB);
    if (!cb) { this.say(`No clip named ${clipB}.`, "warn"); return false; }
    const tmp = Doc.fromClip(this.doc.toClip());
    tmp.addLayer({ name: "to " + clipB, mode: "override", source: "clip", clip: clipB, offset: at, cycle: !!cb.loop, start: at, fade_in: blend });
    tmp.frames = at + Number(cb.frames || 24);
    tmp.constraints = [];
    const baked = E.bake(tmp, this.stage.probe, this.bones, {});
    const nd = Doc.blank(name, tmp.frames, this.doc.fps);
    nd.keys = baked;
    nd.plant = this.doc.plant;
    nd.extra.note = `Blend Lab: ${this.doc.name} -> ${clipB} at f${at} over ${blend} frames`;
    this._setDoc(nd, true);
    this.say(`Made ${name} (${nd.frames} frames). Save it to keep it.`, "ok");
    return true;
  }

  // outside motion (a Mixamo FBX, a GLB / glTF with a Mixamo-style skeleton) onto our rig as a new, unsaved clip
  // (core/motion_import.js). opts: name, anim, in_place, limits, fingers, plant, loop, tolerance. Returns the import report or {error}.
  async importMotion(path, opts = {}, who = "you") {
    const url = await window.host.motionUrl(String(path));
    if (!url) { this.say(`Import: no FBX / GLB / glTF at ${path}.`, "error"); return { error: "no FBX / GLB / glTF at " + path }; }
    if (opts.name && !/^[A-Za-z0-9_\-]+$/.test(String(opts.name))) return { error: "bad clip name" };
    const src = await MI.loadSource(url, String(path));
    const r = MI.retarget(src, this.stage.probe, opts);
    if (r.error) { this.say(`Import: ${r.error}.`, "error"); return r; }
    this._setDoc(Doc.fromClip(r.clip), true);
    const rep = r.report;
    if (who !== "you") this.agentFlash = 1;
    const file = String(path).split(/[\\/]/).pop();
    this.say(`Imported ${rep.name} from ${file}: ${rep.bones} bones, ${rep.frames} frames, ${rep.keys} keys${rep.loop ? ", loops" : ""}${rep.plant ? ", planted" : ""}` +
      `${rep.clamped > 0 ? `, ${rep.clamped} joint turns kept inside the rig limits` : ""}. Save it to keep it.`, who !== "you" ? "agent" : "ok");
    return rep;
  }

  // ================================================================ clips and fighters
  async listClips(filter = "") { return (await window.host.listClips()).filter((n) => !filter || n.includes(filter)); }

  async openClip(name, discard = false) {
    if (this.history.dirty() && !discard) {
      if (!(await window.host.confirm(`"${this.doc.name}" has changes that are not saved. Open "${name}" anyway (changes are lost)?`))) return false;
    }
    const c = await window.host.loadClip(name);
    if (!c) return false;
    const d = Doc.fromClip(c);
    for (const l of d.layers) if (l.source === "clip") await E.preloadClip(l.clip);
    this._setDoc(d, false);
    this.say(d.outsideEdit ? `${name} was changed outside after a bake: those keys are the base now, layers and constraints are off.` : `Opened ${name} (${d.frames} frames @ ${d.fps} fps, ${d.keys.length} keys).`, d.outsideEdit ? "warn" : "info");
    return true;
  }

  _setDoc(d, asNew) {
    this.doc = d;
    this.isNew = asNew;
    this.history.clear();
    if (asNew) this.history.savedAt = -1;
    Object.assign(this, { pending: null, selKeys: [], activeLayer: "", frame: 0, playing: false, playRange: [0, -1] });
    this.docChanged();
    if (this.fx) this.fx.loadClip(d.name);
    this.emit("clip");
  }

  newClip(name, frames, fps, loop, fromPose, who = "you") {
    name = String(name).trim();
    if (!/^[A-Za-z0-9_\-]+$/.test(name)) { this.say("Clip names use letters, digits, _ and - only.", "warn"); return false; }
    const start = this.editablePose();
    const d = Doc.blank(name, frames, fps, loop);
    if (fromPose) {
      d.writeKey(0, start, this.bones);
      if (loop) { d.writeKey(frames, start, this.bones); d.linkKeys([0, frames], this.bones, false); }
    }
    this._setDoc(d, true);
    if (who !== "you") this.agentFlash = 1;
    this.say(`New clip ${name}. Pose it, key it (K), save it (Ctrl+S).`, "ok");
    return true;
  }

  async save(who = "you") {
    if (!this.doc.name || this.doc.name === "untitled") return { ok: false, error: "needs a name (Save as)" };
    let baked = [];
    if (this.doc.needsBake()) {
      this.doc.bakedOn = this.fighter;
      baked = E.bake(this.doc, this.stage.probe, this.bones, {});
    }
    const was = this.doc.saved;
    this.doc.saved = Doc.stamp();
    const r = await window.host.saveClip(this.doc.toClip(baked));
    if (!r.ok) { this.doc.saved = was; this.say("Could not save: " + r.error, "error"); return r; }
    E.forgetClips();
    this.history.markSaved();
    this.isNew = false;
    if (this.fx) {   // the clip's effect cues are kept by its name
      if (this.fx.clip !== this.doc.name) { this.fx.clip = this.doc.name; this.fx.dirty = this.fx.count() > 0; }
      if (this.fx.dirty) await this.fx.save();
    }
    this.updateTitle();
    this.say(`Saved ${this.doc.name}${baked.length ? " (layers + constraints baked for the game)" : ""}.` +
      (was ? "" : " It is yours now: the clip generators (gen_*.py) leave it alone."), who !== "you" ? "agent" : "ok");
    this.emit("saved");
    return { ok: true, path: r.path, baked: baked.length > 0, saved: this.doc.saved };
  }

  async saveAs(name, who = "you") {
    if (!/^[A-Za-z0-9_\-]+$/.test(String(name))) return { ok: false, error: "bad name" };
    this.doc.name = name;
    this.history.savedAt = -1;
    return this.save(who);
  }

  async trashClip(name) {
    const ok = await window.host.trashClip(name);
    if (ok) { this.say(`Moved ${name} to the trash folder.`); this.emit("clips"); }
    return ok;
  }

  async setFighter(k, first = false) {
    const url = await window.host.modelUrl(k);
    if (!url) { this.say(`No model for ${k}.`, "warn"); return false; }
    if (!this.rigV5Data) this.rigV5Data = await window.host.loadData("rig_v5.json");
    if (!this.rigSoles) this.rigSoles = await window.host.loadData("feet_soles.json");
    FG.useFighter(k);
    this.v5Upgrade = null;
    await this.stage.loadFighter(url, k, (scene) => { this.v5Upgrade = R5U.upgradeRigV4(scene, this.rigV5Data, this.rigSoles, k); });
    this.fighter = k;
    // its Collision Wrap and match height: the Body Solve runs on the model scaled the way a match scales it
    this.wrapData = await window.host.wrapData(k);
    this.matchScale = this.wrapData ? this.wrapData.height_m / W.meshHeight(this.stage.wrapBody.root) : 1;
    this._solvers = new WeakMap();
    this._wrapTrack = null;
    this._wrapReport = null;
    this.bones = this.stage.body.names;
    await this.buildV5();
    this.stage.body.apply({});
    let lo = Infinity;
    for (const b of ["footL", "footR"]) if (this.stage.body.has(b)) lo = Math.min(lo, this.jointWorld(b).y);
    this.ankle = lo === Infinity ? 0 : Math.max(0, lo);
    if (!this.bones.includes(this.selBone)) { this.selBone = "hips"; this.selBones = ["hips"]; }
    if (!first) { this.loadSockets(); this.fx && this.fx.bindFighter(); this.views && this.views.frameAll(); this.docChanged(); }
    this.emit("fighter");
    return true;
  }

  // ================================================================ sockets
  loadSockets() {
    const d = this._sockData || {};
    this.sockSpecs = {};
    for (const n in d.sockets || {}) this.sockSpecs[n] = { ...d.sockets[n], ...(((d.fighters || {})[this.fighter] || {})[n] || {}) };
  }

  socketWorld(n) {
    const sp = this.sockSpecs[n];
    const body = this.stage.body;
    if (!sp || !body.has(sp.bone)) return new THREE.Vector3();
    const p = body.worldPos(sp.bone);
    const off = new THREE.Vector3(...v3(sp.offset || [0, 0, 0]));
    if (sp.t !== undefined && sp.to && body.has(sp.to)) p.lerp(body.worldPos(sp.to), Number(sp.t));
    p.add(off.applyQuaternion(body.worldQuat(sp.bone)));
    if (sp.ground) p.y = 0;
    return p;
  }

  async saveSockets(thisFighterOnly) {
    const d = structuredClone(this._sockData || { sockets: {} });
    if (thisFighterOnly) {
      const fd = (d.fighters ||= {})[this.fighter] || {};
      for (const n in this.sockSpecs) {
        const shared = d.sockets[n] || {};
        const diff = {};
        for (const k in this.sockSpecs[n]) if (JSON.stringify(shared[k]) !== JSON.stringify(this.sockSpecs[n][k])) diff[k] = this.sockSpecs[n][k];
        if (Object.keys(diff).length) fd[n] = diff;
      }
      d.fighters[this.fighter] = fd;
    } else for (const n in this.sockSpecs) d.sockets[n] = this.sockSpecs[n];
    await window.host.saveData("sockets.json", d);
    this._sockData = d;
    this.loadSockets();
    if (this.fx) this.fx.bindFighter();
    this.say(`Sockets saved (${thisFighterOnly ? "this fighter only" : "every fighter"}).`, "ok");
  }

  // ================================================================ overlay data, curves, checks
  overlayTargets() {
    const out = [];
    for (const c of this.doc.constraints) {
      if (c.enabled === false) continue;
      if (c.type === "ik" || c.type === "aim") out.push({ pos: E.targetPoint(c.target, this.frame, this.stage.body), color: "#a77bff", label: c.name });
      else if (c.type === "pin" && this.ctx["pin:" + c.id]) out.push({ pos: this.ctx["pin:" + c.id].p, color: "#5ce08a", label: c.name });
    }
    return out;
  }

  trail() {
    const key = `${this.selBone}|${this.history.undoStack.length}|${this.doc.name}|${this.fighter}`;
    if (this._trail.key !== key) {
      const pts = [];
      const body = this.stage.probe;
      if (body.has(this.selBone)) for (let f = 0; f <= this.doc.frames; f++) { this.finalPoseOn(body, f); pts.push(body.worldPos(this.selBone)); }
      this._trail = { key, pts };
    }
    return this._trail.pts;
  }

  graphCurves(bone) {
    const key = `${bone}|${this.history.undoStack.length}|${this.doc.name}`;
    if (this._curves.has(key)) return this._curves.get(key);
    const lay = [], fin = [], hips = [], hipsF = [];
    const live = E.hasLiveConstraints(this.doc);
    for (let f = 0; f <= this.doc.frames; f++) {
      const lp = E.layerPose(this.doc, f, this.bones);
      lay.push(lp[bone] || [0, 0, 0]);
      hips.push([lp._dx || 0, lp._dy || 0, lp._dz || 0]);
      if (live) {
        const fp = E.solvePose(this.doc, f, this.stage.probe, this.bones, this.ctx, lp);
        fin.push(fp[bone] || [0, 0, 0]);
        hipsF.push([fp._dx || 0, fp._dy || 0, fp._dz || 0]);
      }
    }
    const out = { layer: lay, final: fin, hips, hipsFinal: hipsF };
    this._curves.clear();
    this._curves.set(key, out);
    return out;
  }

  // ================================================================ the Collision Wrap (core/wrap.js, the game's RMT Wrap)
  // the fighter's Body Solve on a body (one per body: each keeps its own carried corrections), null when it has no wrap
  solverOf(body) {
    if (!this._solvers.has(body)) this._solvers.set(body, W.makeSolver(body, this.fighter, this.wrapData, R.rigData.limits, R.hingeList(), body.root));
    return this._solvers.get(body);
  }

  // what a match does after the clip has posed body: the feet (a planted clip stands on its soles) and the Body Solve going on
  // from carry (the corrections carried from the frame before), with the model at its match height while they run so their
  // metres are the game's. opts: solve (default the Collision Wrap view), feet (default Game feet), matchHeight (the feet at
  // match height without the solve). Returns {solver, stats} (stats null without the solve), or null (the feet as before)
  matchFinish(body, carry = null, opts = {}) {
    const solve = opts.solve ?? this.show.wrap;
    const feet = (opts.feet ?? this.show.gameFeet) && this.doc.plant;
    const model = body.root;
    model.position.y = 0;
    body.update();
    const s = this.solverOf(body);
    if (!s || (!solve && !opts.matchHeight)) {
      if (feet) F.ground(body, model, 0, true);
      return null;
    }
    const stats = W.atMatchScale(model, this.matchScale, () => {
      if (feet) F.ground(body, model, 0, true);
      if (!solve) return null;
      s.setCarry(carry);
      return s.solve(feet ? 0 : NaN);
    });
    return { solver: s, stats };
  }

  // the corrections the match carries into frame f: the clip played from its first frame (8 settling solves on frame 0, then
  // every frame in turn: the clash test's order) on the hidden wrap body, kept per frame until the clip changes. A frame in
  // between two goes on from the whole frame before it
  wrapCarry(f) {
    const body = this.stage && this.stage.wrapBody;
    if (!this.show.wrap || !body || !this.solverOf(body)) return null;
    const key = `${this.fighter}|${this.show.gameFeet}`;
    let t = this._wrapTrack;
    if (!t || t.key !== key) t = this._wrapTrack = { key, warm: null, carry: [], stats: [] };
    if (!t.warm) {
      let c = null;
      for (let w = 0; w < 8; w++) {
        this.finalPoseOn(body, 0);
        c = this.matchFinish(body, c).solver.carry();
      }
      t.warm = c;
    }
    const want = Math.min(Math.ceil(Number(f) - 1e-6) - 1, this.doc.frames);   // the whole frame before f
    while (t.carry.length <= want) {
      const i = t.carry.length;
      this.finalPoseOn(body, i);
      const r = this.matchFinish(body, i ? t.carry[i - 1] : t.warm);
      t.carry.push(r.solver.carry());
      t.stats.push(r.stats);
    }
    return want < 0 ? t.warm : t.carry[want];
  }

  // the pieces still in the body or under the floor on body's pose now (1 cm past their rest overlap), for the capsule view
  wrapClashNow(body) {
    const s = this.solverOf(body);
    const out = new Set();
    if (!s) return out;
    const cl = W.atMatchScale(body.root, this.matchScale, () => W.clashesNow(s.wrap, 0.01, this.show.gameFeet && this.doc.plant));
    for (const x of cl.self) { out.add(x.i); out.add(x.j); }
    for (const u of cl.floor) out.add(u.i);
    return out;
  }

  // the Collision Wrap report for the open clip, the way the game's clash test (ult_clash.gd) reports it: the clashes as keyed
  // (parts going into each other past their rest overlap, parts under the floor of a planted clip) and after the Body Solve,
  // each pair with its worst depth (cm), that frame and how many frames; and the most the solve turns a joint away from the
  // keys (max_corr). A clip whose solve turns a joint more than 45° is flagged: the keys put that part deep in the body. The clip
  // plays from its first frame as in the clash test (8 settling solves on frame 0), with the match's feet, at match height.
  // top: rows per list (0 = all); tolCm: how deep a clash must go to count
  wrapReport(top = 0, tolCm = 1) {
    const cut = (r) => (top > 0 && r.wrap ? { ...r, keyed: { ...r.keyed, rows: r.keyed.rows.slice(0, top) }, solved: { ...r.solved, rows: r.solved.rows.slice(0, top) } } : r);
    if (this._wrapReport && this._wrapReport.tol_cm === tolCm) return cut(this._wrapReport);
    const body = this.stage.wrapBody;
    const s = body && this.solverOf(body);
    if (!s) return { fighter: this.fighter, clip: this.doc.name, wrap: false, error: `${this.fighter} has no Collision Wrap (data/wraps/${this.fighter}.collide.json): bake one with tools/wrap_bake.gd -- --who=${this.fighter}` };
    const tol = tolCm / 100, planted = this.doc.plant, P = s.wrap.pieces, n = this.doc.frames;
    const pass = (solve) => {
      const worst = new Map();
      const add = (k, cm, f) => {
        const w = worst.get(k);
        if (!w) worst.set(k, [cm, f, 1]);
        else { w[2]++; if (cm > w[0]) { w[0] = cm; w[1] = f; } }
      };
      let carry = null, mc = 0, mb = "", mf = -1;
      if (solve) for (let w = 0; w < 8; w++) { this.finalPoseOn(body, 0); carry = this.matchFinish(body, carry, { solve: true, feet: true }).solver.carry(); }
      for (let f = 0; f <= n; f++) {
        this.finalPoseOn(body, f);
        const r = this.matchFinish(body, carry, { solve, feet: true, matchHeight: true });
        if (solve) {
          carry = r.solver.carry();
          if (r.stats.max_corr > mc) { mc = r.stats.max_corr; mb = r.stats.max_corr_bone; mf = f; }
        }
        const cl = W.atMatchScale(body.root, this.matchScale, () => W.clashesNow(s.wrap, tol, planted));
        for (const x of cl.self) add(`${P[x.i].id}|${P[x.j].id}`, x.excess * 100, f);
        for (const u of cl.floor) add(`${P[u.i].id}|FLOOR`, u.excess * 100, f);
      }
      const rows = [...worst].map(([pair, w]) => ({ pair, cm: Math.round(w[0] * 10) / 10, f: w[1], frames: w[2] })).sort((a, b) => b.cm - a.cm);
      return { rows, mc, mb, mf };
    };
    const k = pass(false), sv = pass(true);
    const deg = Math.round(sv.mc * DEG * 10) / 10;
    const flagged = deg > 45;
    const head = `Collision Wrap: ${k.rows.length ? k.rows.length + " clash" + (k.rows.length === 1 ? "" : "es") : "no clashes"} as keyed, ` +
      `${sv.rows.length ? sv.rows.length : "none"} after the Body Solve; ` +
      (sv.mb ? `the solve turns ${sv.mb} ${Math.round(deg)}° at f${sv.mf}` : "the solve turns nothing") +
      (flagged ? ", more than 45°: the keys put that part deep in the body (re-key it out; View > Wrap capsules shows where)" : "");
    this._wrapReport = { fighter: this.fighter, clip: this.doc.name, wrap: true, frames: n, planted, match_scale: Math.round(this.matchScale * 10000) / 10000,
      tol_cm: tolCm, keyed: { pairs: k.rows.length, rows: k.rows }, solved: { pairs: sv.rows.length, rows: sv.rows },
      max_corr_deg: deg, max_corr_bone: sv.mb, max_corr_f: sv.mf, flagged, text: head };
    return cut(this._wrapReport);
  }

  // the Checks entries from the wrap report: what it found, its worst clashes as keyed and after the solve, the 45° flag
  wrapChecks() {
    const r = this.wrapReport();
    if (!r.wrap) return [{ level: "warn", f: -1, text: r.error }];
    const row = (x, after) => ({ level: after ? "warn" : "info", f: x.f,
      text: `  ${after ? "after the solve" : "keyed"}: ${x.pair} ${x.cm.toFixed(1)} cm at f${x.f} (${x.frames} frame${x.frames === 1 ? "" : "s"})` });
    return [{ level: r.flagged ? "error" : r.solved.pairs ? "warn" : "ok", f: r.max_corr_f, text: r.text },
      ...r.keyed.rows.slice(0, 6).map((x) => row(x, false)), ...r.solved.rows.slice(0, 6).map((x) => row(x, true))];
  }

  // the wrists and the upper arms' roll through the clip (Al and Guru 2026-10-30, the user: "the loose and crazy arm looks and
  // hands"): IK that keeps the hand's world turn (ik_pose keep_end, the default) leaves the wrists twisted up to +-80° in the
  // keys and the upper arms rolled, and the fills swing between them. A WARNING: a wrist swinging more than 70° on an axis over
  // the clip, or turning more than 20° in one 60 fps frame; an upper arm rolling more than 20° in a frame or 100° over the clip.
  // A NOTE (does not stop "All good"): 12-20° in a frame - fast landings and catches do that on purpose. (Al after the fix:
  // wrists 9° a frame, 44° at most; the match clips: 63 of 665 over 12°, mostly landings / ledge catches at 14-18°.)
  twistChecks() {
    const out = [];
    const n = this.doc.frames;
    if (n < 2) return out;
    const fps = Number(this.doc.fps) || 60;
    const NOTE = 12, STEP = 20;   // degrees in one 60 fps frame
    const LIM = { handL: [STEP, 70], handR: [STEP, 70], armL: [STEP, 100], armR: [STEP, 100] };
    const names = Object.keys(LIM).filter((b) => this.bones.includes(b));
    if (!names.length) return out;
    const poses = [];
    for (let f = 0; f <= n; f++) poses.push(E.layerPose(this.doc, f, this.bones));
    for (const b of names) {
      const wrist = b.startsWith("hand");
      const stepLim = LIM[b][0] * 60 / fps, swingLim = LIM[b][1];
      let step = 0, sf = 0;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let f = 0; f <= n; f++) {
        const e = v3(poses[f][b] || [0, 0, 0]);
        for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], e[a]); hi[a] = Math.max(hi[a], e[a]); }
        if (f > 0) {
          const p = v3(poses[f - 1][b] || [0, 0, 0]);
          const d = wrist ? rotQuat(e).angleTo(rotQuat(p)) : Math.abs(e[1] - p[1]);   // the wrist's whole turn, the arm's roll (y)
          if (d > step) { step = d; sf = f; }
        }
      }
      const swing = wrist ? Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : hi[1] - lo[1];
      const what = wrist ? `${b} (the wrist)` : `${b} (the upper arm's roll)`;
      const fix = wrist ? "IK that keeps the hand's world turn twists the wrist: re-solve with keep_end off, or soften the wrist keys"
        : "IK rolled the upper arm: re-solve with keep_end off, or key the arm's roll (y) back";
      if (step * DEG > stepLim) out.push({ level: "warn", f: sf, text: `${what} turns ${Math.round(step * DEG)}° in one frame at f${sf} (over ${Math.round(stepLim)}°): ${fix}` });
      else if (step * DEG > NOTE * 60 / fps) out.push({ level: "info", f: sf, text: `${what} turns ${Math.round(step * DEG)}° in one frame at f${sf} (fast - fine for a snap or a landing)` });
      if (swing * DEG > swingLim) out.push({ level: "warn", f: -1, text: `${what} swings ${Math.round(swing * DEG)}° over the clip (over ${swingLim}°): ${fix}` });
    }
    return out;
  }

  // planted feet that are not planted (Repo Bruiser 2026-10-30): a foot just off the floor and tipped that the match will not
  // stand flat (it is not the lower foot, or the clip keys it onto its toes while the sole leans sideways). A WARNING per foot
  // with its worst frame; the fix: both soles on the floor and level (ankle turned level, the foot reached down by IK with
  // keep_end), or lift the foot clear of the floor.
  feetChecks() {
    const out = [];
    let rep;
    try { rep = this.feetReport(1); } catch (e) { return out; }
    for (const b of ["footL", "footR"]) {
      let n = 0, wf = -1, wt = 0, wr = 0;
      for (const row of rep.frames) {
        const r = row[b];
        if (!r || r.state !== "loose") continue;
        n++;
        const t = Math.max(r.tilt, Math.abs(r.roll));
        if (t > wt) { wt = t; wr = r.roll; wf = row.f; }
      }
      if (n) out.push({ level: "warn", f: wf, text: `${b} hangs tipped ${Math.round(wt)}° just off the floor (sideways ${Math.round(Math.abs(wr))}°) at f${wf}, ${n} frames: not planted - stand both soles on the floor, level, or lift it clear` });
    }
    return out;
  }

  runChecks() {
    const out = [];
    for (const k of this.doc.keys) {
      const kp = {};
      for (const b in k.rot || {}) kp[b] = v3(k.rot[b]);
      for (const b of this.bones) if (R.fingerBreaks(b, boneRot(kp, b))) out.push({ level: "warn", f: k.f, text: `${b} bends past a finger's natural range at f${k.f}` });
      for (const b in k.rot || {}) {
        const e = v3(k.rot[b]);
        if (b.startsWith("knee") && e[0] < -0.01) out.push({ level: "error", f: k.f, text: `${b} bends FORWARD at f${k.f} (${Math.round(e[0] * DEG)}°): a knee never does` });
        else if (R.breaksLimits(b, e)) out.push({ level: "warn", f: k.f, text: `${b} is past its limit at f${k.f}` });
      }
      if (k.f > this.doc.frames) out.push({ level: "warn", f: k.f, text: `key at f${k.f} is after the end (f${this.doc.frames})` });
    }
    if (this.doc.loop) {
      const a = E.layerPose(this.doc, 0, this.bones), b = E.layerPose(this.doc, this.doc.frames, this.bones);
      let worst = 0, wb = "";
      for (const n of this.bones) { const d = dist3(a[n], b[n]); if (d > worst) { worst = d; wb = n; } }
      if (worst > 0.02) out.push({ level: "warn", f: this.doc.frames, text: `loop seam: ${wb} jumps ${Math.round(worst * DEG)}° from the last frame to the first (Key > Close loop)` });
    }
    if (this.doc.plant) {
      const slide = this.footSlide();
      if (slide > 0.04) out.push({ level: "warn", f: -1, text: `planted foot slides ${(slide * 100).toFixed(1)} cm while on the floor (freeze it: Rig > Freeze)` });
    }
    out.push(...this.twistChecks());
    if (this.doc.plant) out.push(...this.feetChecks());
    if (this.doc.outsideEdit) out.push({ level: "warn", f: -1, text: "keys were edited outside after a bake; layers / constraints were switched off" });
    if (this.pending) out.push({ level: "warn", f: Math.round(this.frame), text: `the pose at f${Math.round(this.frame)} is changed but not keyed` });
    // the Collision Wrap (one block per clip) first: a flag must not hide under the per-key findings
    const wrap = this.wrapChecks();
    const good = !out.some((r) => r.level === "warn" || r.level === "error") && !wrap.some((r) => r.level === "warn" || r.level === "error");
    return [...(good ? [{ level: "ok", f: -1, text: "All good: knees, limits, wrists, loop seam, feet planted, Collision Wrap." }] : []), ...wrap, ...out];
  }

  // per frame, how the feet stand once the match grounds them (CBFeet on the probe body; changes nothing):
  // {planted, soles: {footL: {tilt0 (degrees the model's own sole is off level at rest), ankle_cm (ankle over the sole)}},
  //  frames: [{f, footL: {state, low_cm, tilt}, footR}], counts: {state: foot-frames}}
  // state: "flat" standing levelled on the floor | "pivot" on its toes / heel (the clip keys the ankle there) | "loose" just
  // off the floor and tipped, not keyed onto the toes / heel: the leg leaves it hanging over the floor, so the match never
  // stands it flat (Repo Bruiser 2026-10-30, the user: "this man feet leaning sideways ... they suppose to be planted to the
  // ground") | "limit" standing with the heel up, the ankle at its natural bend | "sink" into the floor (a clip that is not
  // planted) | "air" off the floor. roll: degrees the sole leans sideways (about the foot's length; a toe / heel pivot is not roll)
  feetReport(step = 1) {
    const body = this.stage.probe;
    const model = body.root;
    const soles = F.soleInfo(body);
    const out = { planted: this.doc.plant, soles: {}, frames: [], counts: {} };
    const r1 = (x) => Math.round(x * 10) / 10;
    for (const b in soles) out.soles[b] = { tilt0: r1(soles[b].tilt0), ankle_cm: r1(soles[b].h * body.bone(b).getWorldScale(new THREE.Vector3()).y * 100) };
    for (let f = 0; f <= this.doc.frames; f += Math.max(1, step | 0)) {
      this.finalPoseOn(body, f);
      model.position.y = 0;
      body.update();
      const st = F.standing(body, soles);
      const did = this.doc.plant ? F.ground(body, model, 0, true) : {};
      const row = { f };
      for (const b in soles) {
        const low = F.lowest(body, b, soles);
        const tilt = soles[b].n.clone().applyQuaternion(body.worldQuat(b)).angleTo(new THREE.Vector3(0, 1, 0)) * DEG;
        const roll = F.soleRoll(body, b, soles);
        let state = "air";
        if (low < -0.01) state = "sink";
        else if (low < 0.05) {
          if (st[b].pivot >= 0.5) state = Math.abs(roll) > LOOSE_ROLL ? "loose" : "pivot";
          else if (st[b].w < 0.5) state = tilt > LOOSE_TILT ? "loose" : "pivot";
          else if (did[b] && did[b].limit && tilt > 8) state = "limit";
          else state = "flat";
        }
        row[b] = { state, low_cm: r1(low * 100), tilt: r1(tilt), roll: r1(roll) };
        out.counts[state] = (out.counts[state] || 0) + 1;
      }
      out.frames.push(row);
    }
    model.position.y = 0;
    body.update();
    return out;
  }

  // the most the planted foot drifts in one stretch of contact, after taking out the clip's own steady travel (a walk cycle
  // slides its planted foot back by the stride on the spot: the game moves the body forward at that speed)
  footSlide() {
    const body = this.stage.probe;
    if (!body.has("footL") || !body.has("footR")) return 0;
    const runs = [];
    let cur = -1, run = null;
    for (let f = 0; f <= this.doc.frames; f++) {
      this.finalPoseOn(body, f);
      const a = body.worldPos("footL"), b = body.worldPos("footR");
      const low = a.y <= b.y ? 0 : 1;
      const p = low ? b : a;
      if (low !== cur) { cur = low; run = { f0: f, p0: p, f1: f, p1: p }; runs.push(run); }
      run.f1 = f;
      run.p1 = p;
    }
    let dx = 0, dz = 0, dt = 0;
    for (const r of runs) { dx += r.p1.x - r.p0.x; dz += r.p1.z - r.p0.z; dt += r.f1 - r.f0; }
    const vx = dt ? dx / dt : 0, vz = dt ? dz / dt : 0;
    let worst = 0;
    for (const r of runs) {
      const t = r.f1 - r.f0;
      worst = Math.max(worst, Math.hypot(r.p1.x - r.p0.x - vx * t, r.p1.z - r.p0.z - vz * t));
    }
    return worst;
  }
}
