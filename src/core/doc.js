// One clip being animated: the game's format plus a "studio" block (base keys, layers, constraints, locks, markers, props),
// byte-compatible with the Godot Animator (game/packs/city_breaker/animator/core/doc.gd) so either app opens the other's files.
import { FORMAT, poseAt, blankClip, dist3, add3, sub3, v3 } from "./clip.js";
import { clampLimits } from "./rig.js";

export const KNOWN = ["version", "name", "fps", "frames", "loop", "override", "plant", "ease", "keys", "studio"];
export const EASES = ["linear", "in", "out", "inout", "hold", "spline"];
export const TAGS = ["key", "breakdown", "extreme"];
export const SNAP = 0.0001;
export const MATCH_TOL = 0.002;
const snap = (v) => Math.round(v / SNAP) * SNAP;
const clone = (o) => structuredClone(o);

export class Doc {
  constructor() {
    Object.assign(this, { name: "", fps: 30, frames: 24, loop: false, override: false, plant: false, ease: "linear", keys: [], layers: [],
      constraints: [], locks: {}, markers: [], props: [], fills: [], extra: {}, bakedOn: "", outsideEdit: false, saved: "" });
  }

  // local time like Godot's Time.get_datetime_string_from_system(): the studio.saved stamp
  static stamp(t = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  }

  static fromClip(c) {
    const d = new Doc();
    for (const k in c) if (!KNOWN.includes(k)) d.extra[k] = clone(c[k]);
    d.name = String(c.name || "");
    d.fps = Math.max(1, Number(c.fps || 30) | 0);
    d.frames = Math.max(1, Number(c.frames || 24) | 0);
    d.loop = !!c.loop;
    d.override = !!c.override;
    d.plant = !!c.plant;
    d.ease = String(c.ease || "linear");
    const st = c.studio && typeof c.studio === "object" ? c.studio : {};
    const gameKeys = clone(c.keys || []);
    if (st.base) {
      if (String(st.bake_sig || "") !== sig(gameKeys)) {
        d.outsideEdit = true;
        d.keys = gameKeys;
      } else d.keys = clone(st.base);
    } else d.keys = gameKeys;
    d.layers = clone(st.layers || []);
    d.constraints = clone(st.constraints || []);
    d.locks = clone(st.locks || {});
    d.markers = clone(st.markers || []);
    d.props = clone(st.props || []);
    d.fills = clone(st.fills || []);   // in-betweens made by Fill (core/fill.js); their keys carry fill: id
    d.bakedOn = String(st.baked_on || "");
    d.saved = String(st.saved || "");   // stamped on every Fight Studio save; the gen_*.py generators skip such a clip
    if (d.outsideEdit) {
      d.layers.forEach((l) => (l.mute = true));
      d.constraints.forEach((x) => (x.enabled = false));
    }
    d.normalize();
    return d;
  }

  static blank(name, frames = 30, fps = 30, loop = false) {
    const d = Doc.fromClip(blankClip(name, frames, fps));
    d.loop = loop;
    return d;
  }

  toDict() {
    return clone({ name: this.name, fps: this.fps, frames: this.frames, loop: this.loop, override: this.override, plant: this.plant, ease: this.ease,
      keys: this.keys, layers: this.layers, constraints: this.constraints, locks: this.locks, markers: this.markers, props: this.props,
      fills: this.fills, extra: this.extra, bakedOn: this.bakedOn });
  }

  loadDict(d) {
    Object.assign(this, clone(d));
    this.normalize();
  }

  toClip(baked = []) {
    const c = clone(this.extra);
    Object.assign(c, { version: FORMAT, name: this.name, fps: this.fps, frames: this.frames, loop: this.loop, override: this.override });
    if (this.plant) c.plant = true;
    if (this.ease !== "linear") c.ease = this.ease;
    const st = { v: 2 };
    if (this.saved) st.saved = this.saved;
    if (Object.keys(this.locks).length) st.locks = clone(this.locks);
    if (this.markers.length) st.markers = clone(this.markers);
    if (this.props.length) st.props = clone(this.props);
    if (this.fills.length) st.fills = clone(this.fills);
    if (this.layers.length) st.layers = clone(this.layers);
    if (this.constraints.length) st.constraints = clone(this.constraints);
    if (!baked.length) c.keys = clone(this.keys);
    else {
      c.keys = baked;
      st.base = clone(this.keys);
      st.baked_on = this.bakedOn;
      st.bake_sig = sig(baked);
    }
    if (Object.keys(st).length > 1) c.studio = st;
    return c;
  }

  needsBake() {
    return this.layers.some((l) => !l.mute && Number(l.weight ?? 1) > 0) || this.constraints.some((c) => c.enabled !== false && Number(c.influence ?? 1) > 0);
  }

  normalize() {
    const by = new Map();
    for (const k of this.keys) {
      k.f = Math.round(Number(k.f || 0));
      if (!k.rot || typeof k.rot !== "object") k.rot = {};
      by.set(k.f, k);
    }
    this.keys = [...by.keys()].sort((a, b) => a - b).map((f) => by.get(f));
    if (!this.keys.length) this.keys.push({ f: 0, rot: {}, hips_dy: 0 });
    for (const list of [this.layers, this.constraints, this.props]) for (const it of list) if (!it.id) it.id = newId(list, "x");
    for (const l of this.layers) if (l.keys) {
      l.keys.forEach((k) => (k.f = Math.round(Number(k.f || 0))));
      l.keys.sort((a, b) => a.f - b.f);
    }
  }

  // ---------------------------------------------------------------- keys
  keyFrames() { return this.keys.map((k) => k.f); }
  keyIndex(f) { return this.keys.findIndex((k) => k.f === f); }
  hasKey(f) { return this.keyIndex(f) >= 0; }
  keyAt(f) { const i = this.keyIndex(f); return i >= 0 ? this.keys[i] : null; }
  isKeyLocked(f) { const k = this.keyAt(f); return !!(k && k.lock); }
  prevKey(f) { let best = -1; for (const k of this.keys) if (k.f < f - 0.001) best = k.f; return best; }
  nextKey(f) { for (const k of this.keys) if (k.f > f + 0.001) return k.f; return -1; }
  source() { return { keys: this.keys, loop: this.loop, ease: this.ease, fps: this.fps, frames: this.frames }; }
  basePose(f, bones) { return poseAt(this.source(), f, bones); }

  writeKey(f, pose, bones) {
    const i = this.keyIndex(f);
    if (i >= 0) {
      const before = poseOfKey(this.keys[i], bones);
      fillKey(this.keys[i], pose, bones);
      return before;
    }
    const nk = { f };
    fillKey(nk, pose, bones);
    let at = this.keys.findIndex((k) => k.f > f);
    if (at < 0) at = this.keys.length;
    this.keys.splice(at, 0, nk);
    return null;
  }

  deleteKey(f) {
    const i = this.keyIndex(f);
    if (i < 0 || this.keys.length <= 1) return false;
    this.keys.splice(i, 1);
    return true;
  }

  canMove(fs, delta) {
    const moving = new Set(fs.map(Number));
    for (const f of moving) {
      const nf = f + delta;
      if (nf < 0 || this.isKeyLocked(f) || (this.hasKey(nf) && !moving.has(nf))) return false;
    }
    return true;
  }

  moveKeys(fs, delta) {
    if (!delta) return true;
    if (!this.canMove(fs, delta)) return false;
    const moving = new Set(fs.map(Number));
    for (const k of this.keys) if (moving.has(k.f)) k.f += delta;
    this.normalize();
    return true;
  }

  setKeyField(f, field, value) {
    const k = this.keyAt(f);
    if (!k) return false;
    if (value === null || value === undefined || (field === "ease" && value === "") || (field === "lock" && !value) || ((field === "link" || field === "tag") && !value)) delete k[field];
    else k[field] = value;
    return true;
  }

  partners(f, bones, matching) {
    const k = this.keyAt(f);
    if (!k) return [];
    const link = k.link || "";
    const mine = poseOfKey(k, bones);
    const out = [];
    for (const o of this.keys) {
      if (o.f === f) continue;
      if (link && o.link === link) out.push(o.f);
      else if (matching && posesEqual(mine, poseOfKey(o, bones), bones, MATCH_TOL)) out.push(o.f);
    }
    return out;
  }

  // carry an edit at one key to "the same key" elsewhere (linked; same pose; or per bone the same value). Locked keys are skipped.
  propagate(f, before, after, bones, mode) {
    const changed = bones.filter((b) => dist3(before[b] || [0, 0, 0], after[b] || [0, 0, 0]) > 1e-6);
    const hipsChanged = ["_dy", "_dx", "_dz"].filter((a) => Math.abs((before[a] || 0) - (after[a] || 0)) > 1e-6);
    if (!changed.length && !hipsChanged.length) return [];
    const link = (this.keyAt(f) || {}).link || "";
    const updated = [];
    for (const o of this.keys) {
      if (o.f === f || o.lock) continue;
      const op = poseOfKey(o, bones);
      let take = [], takeHips = [];
      if (link && o.link === link) { take = changed; takeHips = hipsChanged; }
      else if (mode === "pose" && posesEqual(before, op, bones, MATCH_TOL)) { take = changed; takeHips = hipsChanged; }
      else if (mode === "bone") {
        take = changed.filter((b) => dist3(op[b] || [0, 0, 0], before[b] || [0, 0, 0]) <= MATCH_TOL);
        takeHips = hipsChanged.filter((a) => Math.abs((op[a] || 0) - (before[a] || 0)) <= MATCH_TOL * 0.5);
      }
      if (!take.length && !takeHips.length) continue;
      for (const b of take) op[b] = add3(op[b] || [0, 0, 0], sub3(after[b] || [0, 0, 0], before[b] || [0, 0, 0]));
      for (const a of takeHips) op[a] = (op[a] || 0) + (after[a] || 0) - (before[a] || 0);
      fillKey(o, op, bones);
      updated.push(o.f);
    }
    return updated;
  }

  linkKeys(fs, bones, copyPose = true) {
    if (fs.length < 2) return "";
    const used = new Set(this.keys.map((k) => k.link || ""));
    let n = 1;
    while (used.has("L" + n)) n++;
    const id = "L" + n;
    const p = poseOfKey(this.keyAt(fs[0]), bones);
    for (const f of fs) {
      const k = this.keyAt(f);
      if (!k) continue;
      k.link = id;
      if (copyPose && f !== fs[0] && !k.lock) fillKey(k, p, bones);
    }
    return id;
  }

  unlinkKeys(fs) { for (const f of fs) { const k = this.keyAt(f); if (k) delete k.link; } }

  // ---------------------------------------------------------------- frames
  insertFrames(at, n) {
    if (n <= 0) return;
    for (const k of this.keys) if (k.f >= at) k.f += n;
    this._shift(at, n);
    this.frames += n;
  }

  deleteFrames(at, n) {
    if (n <= 0) return;
    this.keys = this.keys.filter((k) => !(k.f >= at && k.f < at + n));
    for (const k of this.keys) if (k.f >= at + n) k.f -= n;
    this._shift(at + n, -n);
    this.frames = Math.max(1, this.frames - n);
    this.normalize();
  }

  _shift(at, n) {
    for (const m of this.markers) if (m.f >= at) m.f = Math.max(0, m.f + n);
    for (const c of this.constraints) for (const fld of ["start", "end", "pin_frame"]) if (c[fld] !== undefined && c[fld] >= at) c[fld] = Math.max(0, c[fld] + n);
    for (const l of this.layers) for (const fld of ["start", "end"]) if (l[fld] !== undefined && l[fld] >= at) l[fld] = Math.max(0, l[fld] + n);
    const marks = this.extra.marks || {};
    for (const mk in marks) if (Number(marks[mk]) >= at) marks[mk] = Math.max(0, Number(marks[mk]) + n);
  }

  scaleTime(factor, pivot = 0, fs = []) {
    if (factor <= 0) return;
    const only = new Set(fs.map(Number));
    for (const k of this.keys) if (!only.size || only.has(k.f)) k.f = Math.max(0, Math.round(pivot + (k.f - pivot) * factor));
    if (!only.size) {
      this.frames = Math.max(1, Math.round(this.frames * factor));
      for (const m of this.markers) m.f = Math.round(pivot + (m.f - pivot) * factor);
      const marks = this.extra.marks || {};
      for (const mk in marks) marks[mk] = pivot + (Number(marks[mk]) - pivot) * factor;
    }
    this.normalize();
  }

  reverse(a, b) {
    for (const k of this.keys) if (k.f >= a && k.f <= b) k.f = a + b - k.f;
    this.normalize();
  }

  // ---------------------------------------------------------------- locks
  lockChannels(b) { return String(this.locks[b] || ""); }
  isLocked(b, axis = -1) { const ch = this.lockChannels(b); return axis < 0 ? ch.length >= 3 : ch.includes("xyz"[axis]); }
  setLock(b, channels) {
    const clean = ["x", "y", "z"].filter((c) => channels.includes(c)).join("");
    if (clean) this.locks[b] = clean;
    else delete this.locks[b];
  }

  // write one bone, keeping its locked channels and the rig limits
  guard(b, old, want, useLimits = true) {
    let out = [...want];
    for (let i = 0; i < 3; i++) if (this.isLocked(b, i)) out[i] = old[i];
    if (useLimits) out = clampLimits(b, out);
    return out;
  }

  // ---------------------------------------------------------------- layers / constraints / markers
  layerById(id) { return this.layers.find((l) => l.id === id) || null; }
  constraintById(id) { return this.constraints.find((c) => c.id === id) || null; }

  addLayer(def) {
    const l = { name: `Layer ${this.layers.length + 1}`, mode: "add", weight: 1, mute: false, solo: false, mask: [], source: "keys", keys: [], clip: "",
      offset: 0, speed: 1, cycle: true, start: 0, end: -1, fade_in: 0, fade_out: 0, ...clone(def) };
    l.id = newId(this.layers, "lyr");
    this.layers.push(l);
    return l;
  }

  addConstraint(def) {
    const c = { type: "ik", name: "", enabled: true, influence: 1, start: 0, end: -1, blend: 0, ...clone(def) };
    c.id = newId(this.constraints, "con");
    if (!c.name) c.name = `${String(c.type).toUpperCase()} ${c.bone || c.limb || ""}`;
    this.constraints.push(c);
    return c;
  }

  removeById(list, id) {
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
    return i >= 0;
  }

  addMarker(f, name) {
    this.markers.push({ f, name });
    this.markers.sort((a, b) => a.f - b.f);
  }
}

export function newId(list, prefix) {
  const used = new Set(list.map((x) => x.id));
  let i = 1;
  while (used.has(prefix + i)) i++;
  return prefix + i;
}

// a signature of a key list that survives a JSON round trip (the same as the Godot doc.gd sig: counted in SNAP steps)
export function sig(ks) {
  const q = (v) => Math.round(Number(v || 0) / SNAP);
  const parts = ks.map((k) => {
    let s = `${Math.round(Number(k.f || 0))}|${q(k.hips_dy)}|${q(k.hips_dx)}|${q(k.hips_dz)}`;
    for (const b of Object.keys(k.rot || {}).sort()) {
      const r = k.rot[b];
      s += `|${b}:${q(r[0])},${q(r[1])},${q(r[2])}`;
    }
    return s;
  });
  // the Godot side stores String.hash() (djb2, 32 bit); match it so both apps agree on a bake
  return String(djb2(parts.join(";")));
}

function djb2(str) {
  // Godot's String::hash(): hashv = 5381; hashv = ((hashv << 5) + hashv) + c  (uint32, over UTF-32 code points)
  let h = 5381 >>> 0;
  for (const ch of str) h = (((h << 5) >>> 0) + h + ch.codePointAt(0)) >>> 0;
  return h;
}

export function poseOfKey(k, bones) {
  const out = {};
  const rot = (k && k.rot) || {};
  for (const b of bones) out[b] = rot[b] ? v3(rot[b]) : [0, 0, 0];
  out._dy = Number((k && k.hips_dy) || 0);
  out._dx = Number((k && k.hips_dx) || 0);
  out._dz = Number((k && k.hips_dz) || 0);
  return out;
}

export function fillKey(k, pose, bones) {
  const rot = {};
  for (const b of bones) {
    const e = pose[b] || [0, 0, 0];
    if (e[0] * e[0] + e[1] * e[1] + e[2] * e[2] > 1e-10) rot[b] = [snap(e[0]), snap(e[1]), snap(e[2])];
  }
  k.rot = rot;
  k.hips_dy = snap(Number(pose._dy || 0));
  for (const ax of ["dx", "dz"]) {
    const v = snap(Number(pose["_" + ax] || 0));
    if (Math.abs(v) > 0 || k["hips_" + ax] !== undefined) k["hips_" + ax] = v;
  }
}

export function posesEqual(a, b, bones, tol) {
  for (const bn of bones) if (dist3(a[bn] || [0, 0, 0], b[bn] || [0, 0, 0]) > tol) return false;
  for (const ax of ["_dy", "_dx", "_dz"]) if (Math.abs((a[ax] || 0) - (b[ax] || 0)) > tol * 0.5) return false;
  return true;
}
