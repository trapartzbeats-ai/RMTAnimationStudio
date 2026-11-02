// Real fingers, a port of the game's finger work (2026-10-30, after the user's new Vix + Carter with separated fingers):
//   - the finger retarget (clip_lib.gd): clips keep finger turns on ONE shared hand (data/finger_frames.json "shared_hands",
//     the average of every fingered fighter's hand) and each fighter turns them onto its own hand: R_own = M R M^-1, M = own
//     hand frame * shared hand frame^-1 (one per hand: wrist -> knuckles, across the knuckles, the palm);
//   - the finger limits (animator rig.gd): animator_rig.json "finger_limits", degrees on each joint's own axes (curl + = into
//     the palm, spread + = toward the index, twist), on the joint's TOTAL turn (own key + the key it follows).
// Plain rig v4 hands (no finger frames for the fighter) play their numbers raw and get no finger limits.
import * as THREE from "three";
import { rotQuat, eulerOf } from "./clip.js";

const CHAIN_BONES = ["fingers", "tips", "nail", "thumb", "thumb%s2", "index", "index%s2", "index%s3", "ring", "ring%s2", "ring%s3",
  "pinky", "pinky%s2", "pinky%s3"];

export const fingers = { data: {}, maps: new Map(), shared: {}, key: "" };

export async function loadFingers() {
  fingers.data = (await window.host.loadData("finger_frames.json")) || {};
  fingers.maps.clear();
}

const vec = (a) => new THREE.Vector3(Number(a[0]), Number(a[1]), Number(a[2]));
const handMatrix = (h) => new THREE.Matrix4().makeBasis(vec(h.along), vec(h.across), vec(h.palm));

// a fighter's finger retarget: bone -> {q, qi} (empty when the fighter has no finger frames)
export function fingerMapOf(key) {
  if (fingers.maps.has(key)) return fingers.maps.get(key);
  const out = new Map();
  const own = (fingers.data.hands || {})[key];
  const sh = fingers.data.shared_hands;
  if (own && sh) {
    for (const side of ["L", "R"]) {
      if (!own[side] || !sh[side]) continue;
      const m = handMatrix(own[side]).multiply(handMatrix(sh[side]).transpose());
      const q = new THREE.Quaternion().setFromRotationMatrix(m).normalize();
      const e = { q, qi: q.clone().invert() };
      for (const b of CHAIN_BONES) out.set(b.includes("%s") ? b.replace("%s", side) : b + side, e);
    }
  }
  fingers.maps.set(key, out);
  return out;
}

// the fighter being posed: fingered fighters get the finger limits (on the shared hand, where their clips keep finger turns)
export function useFighter(key) {
  fingers.key = key;
  fingers.shared = (fingers.data.hands || {})[key] ? fingers.data.shared || {} : {};
}

export const isFinger = (b) => !!fingers.shared[b];

// a clip euler -> the bone's local turn on this fighter (q is written)
export function mapQuat(fmap, n, e, out = new THREE.Quaternion()) {
  rotQuat(e, out);
  const m = fmap && fmap.get(n);
  if (m) out.premultiply(m.q).multiply(m.qi);
  return out;
}

// a local turn read off the body -> the clip's frame (in place)
export function unmapQuat(fmap, n, q) {
  const m = fmap && fmap.get(n);
  if (m) q.premultiply(m.qi).multiply(m.q);
  return q;
}

// a finger joint's turn as [curl, spread, twist] radians on the shared hand's axes (null when the bone has no frame)
export function fingerParts(b, e) {
  const fr = fingers.shared[b];
  if (!fr) return null;
  const q = rotQuat(e);
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const ang = 2 * Math.acos(Math.min(1, q.w));
  const s = Math.sqrt(Math.max(0, 1 - q.w * q.w));
  const rv = s > 1e-6 ? new THREE.Vector3(q.x / s, q.y / s, q.z / s).multiplyScalar(ang) : new THREE.Vector3();
  return [rv.dot(vec(fr.c)), rv.dot(vec(fr.s)), rv.dot(vec(fr.t))];
}

// the same from a local quaternion read off a body (rest q of the bone, the fighter's map)
export function partsOfLocal(fmap, b, restQ, qLocal) {
  const q = unmapQuat(fmap, b, restQ.clone().invert().multiply(qLocal));
  return fingerParts(b, eulerOf(q));
}

// keep a finger joint inside finger_limits (degrees) on its own axes
export function clampFinger(b, e, limits) {
  const fr = fingers.shared[b];
  const lim = fr && limits && limits[fr.kind];
  if (!lim) return e;
  const p = fingerParts(b, e);
  const c = p.map((v, i) => {
    const r = lim[["curl", "spread", "twist"][i]] || [-180, 180];
    return Math.min(Math.max(v, (r[0] * Math.PI) / 180), (r[1] * Math.PI) / 180);
  });
  if (Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) < 1e-4) return e;
  const rv = vec(fr.c).multiplyScalar(c[0]).add(vec(fr.s).multiplyScalar(c[1])).add(vec(fr.t).multiplyScalar(c[2]));
  const len = rv.length();
  if (len < 1e-6) return [0, 0, 0];
  return eulerOf(new THREE.Quaternion().setFromAxisAngle(rv.divideScalar(len), len));
}
