// The game's clip format and interpolation, a line-for-line port of CBClipLib (game/packs/city_breaker/clip_lib.gd), so a clip
// plays here exactly as in a fight. A pose is {bone: [x, y, z] Euler radians on top of the rest, applied Z * Y * X, _dx, _dy, _dz}.
import * as THREE from "three";

export const FORMAT = 1;

// fingered rigs: each new finger bone follows the old key it replaces (times a share), plus any key of its own
export const FOLLOW = {
  indexL: ["fingersL", 1.0], pinkyL: ["fingersL", 1.0], indexL2: ["tipsL", 1.0], pinkyL2: ["tipsL", 1.0],
  nailL: ["tipsL", 0.7], indexL3: ["tipsL", 0.7], pinkyL3: ["tipsL", 0.7], thumbL2: ["thumbL", 0.8],
  indexR: ["fingersR", 1.0], pinkyR: ["fingersR", 1.0], indexR2: ["tipsR", 1.0], pinkyR2: ["tipsR", 1.0],
  nailR: ["tipsR", 0.7], indexR3: ["tipsR", 0.7], pinkyR3: ["tipsR", 0.7], thumbR2: ["thumbR", 0.8],
  ringL: ["fingersL", 1.0], ringL2: ["tipsL", 1.0], ringL3: ["tipsL", 0.7],
  ringR: ["fingersR", 1.0], ringR2: ["tipsR", 1.0], ringR3: ["tipsR", 0.7],
};

export const ZERO = Object.freeze([0, 0, 0]);
export const v3 = (a) => (Array.isArray(a) ? [Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0] : [0, 0, 0]);
export const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

const _e = new THREE.Euler();
// the rotation of a bone key: Rz * Ry * Rx (Blender's XYZ), three.js order 'ZYX'
export function rotQuat(e, out = new THREE.Quaternion()) {
  _e.set(e[0], e[1], e[2], "ZYX");
  return out.setFromEuler(_e);
}

export function eulerOf(q) {
  _e.setFromQuaternion(q, "ZYX");
  return [_e.x, _e.y, _e.z];
}

export function sortedKeys(clip) {
  return [...(clip.keys || [])].sort((a, b) => Number(a.f) - Number(b.f));
}

export function keyRot(key, bone) {
  const r = key && key.rot && key.rot[bone];
  return r ? [Number(r[0]), Number(r[1]), Number(r[2])] : [0, 0, 0];
}

export function easeT(ease, t) {
  switch (ease) {
    case "in": return t * t * t;
    case "out": return 1 - Math.pow(1 - t, 3);
    case "inout": return t * t * (3 - 2 * t);
    case "hold": return t < 1 ? 0 : 1;
  }
  return t;
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1, 2].map((i) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3));
}

// the pose at a (fractional) frame, interpolated between the surrounding keys (CBClipLib.pose_at)
export function poseAt(clip, frame, bones) {
  const keys = sortedKeys(clip);
  const out = {};
  if (!keys.length) {
    for (const b of bones) out[b] = [0, 0, 0];
    out._dy = 0; out._dx = 0; out._dz = 0;
    return out;
  }
  let ia = 0, ib = keys.length - 1;
  for (let i = 0; i < keys.length; i++) {
    if (Number(keys[i].f) <= frame) ia = i;
    if (Number(keys[i].f) >= frame) { ib = i; break; }
  }
  const a = keys[ia], b = keys[ib];
  const span = Number(b.f) - Number(a.f);
  let t = span <= 0 ? 0 : clamp((frame - Number(a.f)) / span, 0, 1);
  const ease = String(a.ease ?? clip.ease ?? "linear");
  if (ease === "spline" && ib !== ia) {
    const loop = !!clip.loop, n = keys.length;
    const p0 = ia > 0 ? keys[ia - 1] : (loop && n > 2 ? keys[n - 2] : a);
    const p3 = ib + 1 < n ? keys[ib + 1] : (loop && n > 2 ? keys[1] : b);
    for (const bone of bones) out[bone] = catmull(keyRot(p0, bone), keyRot(a, bone), keyRot(b, bone), keyRot(p3, bone), t);
    for (const k of ["dy", "dx", "dz"]) {
      const g = (key) => [Number(key["hips_" + k] || 0), 0, 0];
      out["_" + k] = catmull(g(p0), g(a), g(b), g(p3), t)[0];
    }
    return out;
  }
  t = easeT(ease, t);
  for (const bone of bones) out[bone] = lerp3(keyRot(a, bone), keyRot(b, bone), t);
  for (const k of ["dy", "dx", "dz"]) out["_" + k] = Number(a["hips_" + k] || 0) + (Number(b["hips_" + k] || 0) - Number(a["hips_" + k] || 0)) * t;
  return out;
}

// a bone's rotation in a pose, with the finger follow added
export function boneRot(pose, name) {
  const e = pose[name] || ZERO;
  const f = FOLLOW[name];
  if (f) return add3(e, mul3(pose[f[0]] || ZERO, f[1]));
  return e;
}

// drop the keys a straight line between their neighbours already gives (within tol radians; hips height counts 3x), as
// CBAnimTools.reduce_keys; returns how many went
export function reduceKeys(clip, bones, tol) {
  const keys = sortedKeys(clip);
  let removed = 0;
  let i = 1;
  while (i < keys.length - 1) {
    const a = keys[i - 1], k = keys[i], b = keys[i + 1];
    const t = (Number(k.f) - Number(a.f)) / (Number(b.f) - Number(a.f));
    let worst = 0;
    for (const bone of bones) {
      const d = sub3(keyRot(k, bone), lerp3(keyRot(a, bone), keyRot(b, bone), t));
      worst = Math.max(worst, Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]));
    }
    const ay = Number(a.hips_dy || 0), by = Number(b.hips_dy || 0);
    const dy = Math.abs(Number(k.hips_dy || 0) - (ay + (by - ay) * t)) * 3;
    if (Math.max(worst, dy) <= tol) { keys.splice(i, 1); removed++; }
    else i++;
  }
  clip.keys = keys;
  return removed;
}

export function blankClip(name, frames = 24, fps = 30) {
  return { version: FORMAT, name, fps, frames, loop: false, override: false, keys: [{ f: 0, rot: {}, hips_dy: 0 }] };
}
