// Turns a document into poses: base keys + layers (add / add_delta / override, weights, masks, fades, clip sources), then
// constraints solved on a Body (ik, pin = freeze in the world, aim, limit, copy_rot, floor / plant), then read back as clip
// Eulers. A port of the Godot Animator's core/eval.gd: both apps bake the same keys.
import * as THREE from "three";
import { poseAt, FOLLOW, lerp3, add3, sub3, mul3, v3, clamp } from "./clip.js";
import { maskBones, LIMBS, limbOfEnd, mirrorEuler, withinLimits, isHinge, clampLimits, rigData } from "./rig.js";
import { fillKey } from "./doc.js";
import { soleInfo, lowest } from "./feet.js";

const clipCache = new Map();
let loadClipFn = null;
export function setClipLoader(fn) { loadClipFn = fn; }
export function clipSrc(name) { return clipCache.get(name) || null; }
export function forgetClips() { clipCache.clear(); }
export async function preloadClip(name) {
  if (!name || clipCache.has(name) || !loadClipFn) return clipCache.get(name) || null;
  const c = await loadClipFn(name);
  if (c) clipCache.set(name, c);
  return c;
}

const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

export function layerWeight(l, f, frames) {
  let w = Number(l.weight ?? 1);
  const a = Number(l.start || 0);
  let b = Number(l.end ?? -1);
  if (b < 0) b = frames;
  if (f < a - 0.001 || f > b + 0.001) return 0;
  const fi = Number(l.fade_in || 0), fo = Number(l.fade_out || 0);
  if (fi > 0 && f < a + fi) w *= smooth01((f - a) / fi);
  if (fo > 0 && f > b - fo) w *= smooth01((b - f) / fo);
  return w;
}

export function layerBones(l, bones) {
  const masked = maskBones(l.mask || [], bones);
  if ((l.source || "keys") !== "keys") return masked;
  const used = new Set();
  for (const k of l.keys || []) {
    for (const b in k.rot || {}) used.add(b);
    if (Math.abs(k.hips_dy || 0) + Math.abs(k.hips_dx || 0) + Math.abs(k.hips_dz || 0) > 0) used.add("hips");
  }
  return masked.filter((b) => used.has(b));
}

export function layerValue(l, f, bones, docLoop) {
  if (l.source === "clip") {
    const c = clipSrc(l.clip);
    if (!c) return null;
    const n = Number(c.frames || 24);
    let t = (f - Number(l.offset || 0)) * Number(l.speed ?? 1);
    t = l.cycle !== false ? ((t % n) + n) % n : clamp(t, 0, n);
    const p = poseAt(c, t, bones);
    if (l.mode === "add_delta") {
      const ref = poseAt(c, Number(l.ref || 0), bones);
      for (const b of bones) p[b] = sub3(p[b], ref[b]);
      for (const ax of ["_dy", "_dx", "_dz"]) p[ax] = (p[ax] || 0) - (ref[ax] || 0);
    }
    return p;
  }
  if (!l.keys || !l.keys.length) return null;
  return poseAt({ keys: l.keys, loop: docLoop, ease: l.ease || "linear" }, f, bones);
}

export function layerPose(doc, f, bones, skipId = "") {
  const pose = doc.basePose(f, bones);
  const solo = doc.layers.some((l) => l.solo && !l.mute);
  for (const l of doc.layers) {
    if (l.mute || (solo && !l.solo) || l.id === skipId) continue;
    const w = layerWeight(l, f, doc.frames);
    if (w <= 0) continue;
    const lp = layerValue(l, f, bones, doc.loop);
    if (!lp) continue;
    const over = l.mode === "override";
    const lb = layerBones(l, bones);
    for (const b of lb) {
      const cur = pose[b] || [0, 0, 0];
      const v = lp[b] || [0, 0, 0];
      const nv = over ? lerp3(cur, v, w) : add3(cur, mul3(v, w));
      pose[b] = l.adjust ? withinLimits(b, nv, cur) : nv;   // an adjustment stays inside the joint's natural range
    }
    if (lb.includes("hips")) for (const ax of ["_dy", "_dx", "_dz"]) {
      const c0 = pose[ax] || 0, v0 = lp[ax] || 0;
      pose[ax] = over ? c0 + (v0 - c0) * w : c0 + v0 * w;
    }
  }
  return pose;
}

// ---------------------------------------------------------------- constraints

export const hasLiveConstraints = (doc) => doc.constraints.some((c) => c.enabled !== false && Number(c.influence ?? 1) > 0);

export function conWeight(c, f, frames) {
  if (c.enabled === false) return 0;
  let w = Number(c.influence ?? 1);
  const a = Number(c.start || 0);
  let b = Number(c.end ?? -1);
  if (b < 0) b = frames;
  if (f < a - 0.001 || f > b + 0.001) return 0;
  const bl = Number(c.blend || 0);
  if (bl > 0) w *= Math.min(a > 0 ? smooth01((f - a) / bl) : 1, b < frames ? smooth01((b - f) / bl) : 1);
  return w;
}

export function finalPose(doc, f, body, bones, ctx) {
  return solvePose(doc, f, body, bones, ctx, layerPose(doc, f, bones));
}

export function solvePose(doc, f, body, bones, ctx, pose) {
  if (!body) return pose;
  if (!hasLiveConstraints(doc)) {
    body.apply(pose);
    return pose;
  }
  capturePins(doc, body, bones, ctx);
  body.apply(pose);
  const touched = new Set();
  for (const c of doc.constraints) {
    const w = conWeight(c, f, doc.frames);
    if (w <= 0) continue;
    switch (c.type) {
      case "ik": ik(c, f, body, w, touched); break;
      case "pin": pin(c, body, w, touched, ctx); break;
      case "aim": aim(c, f, body, w, touched); break;
      case "limit": limit(c, body, w, touched); break;
      case "copy_rot": copyRot(c, body, w, touched); break;
      case "floor": floor(c, body, w, touched, ctx); break;
    }
    body.update();
  }
  return readBack(body, pose, touched);
}

export function readBack(body, pose, touched) {
  const out = { ...pose };
  const list = [...touched];
  list.sort((a, b) => (FOLLOW[a] ? 1 : 0) - (FOLLOW[b] ? 1 : 0));
  for (const n of list) {
    let e = body.localEuler(n);
    if (FOLLOW[n]) e = sub3(e, mul3(out[FOLLOW[n][0]] || [0, 0, 0], FOLLOW[n][1]));
    out[n] = nearestEuler(e, pose[n] || [0, 0, 0]);
    if (n === "hips") {
      const d = body.hipsShift();
      out._dx = d[0]; out._dy = d[1]; out._dz = d[2];
    }
  }
  return out;
}

const wrap = (x) => x - Math.PI * 2 * Math.floor((x + Math.PI) / (Math.PI * 2));
export function nearestEuler(e, ref) {
  let best = e, bd = Infinity;
  for (const cand of [e, [e[0] + Math.PI, Math.PI - e[1], e[2] + Math.PI]]) {
    const c = cand.map((v, i) => ref[i] + wrap(v - ref[i]));
    const d = (c[0] - ref[0]) ** 2 + (c[1] - ref[1]) ** 2 + (c[2] - ref[2]) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

const V = (a) => new THREE.Vector3(...v3(a));

export function targetPoint(spec, f, body) {
  spec = spec || {};
  if (spec.bone && body.has(spec.bone)) {
    const p = body.worldPos(spec.bone);
    const off = V(spec.offset || [0, 0, 0]).applyQuaternion(body.worldQuat(spec.bone));
    return p.add(off);
  }
  const ks = spec.keys || [];
  if (ks.length) {
    let a = ks[0];
    if (f <= a.f) return V(a.pos);
    for (let i = 1; i < ks.length; i++) {
      const b = ks[i];
      if (f <= b.f) {
        const span = b.f - a.f;
        return V(a.pos).lerp(V(b.pos), span <= 0 ? 0 : (f - a.f) / span);
      }
      a = b;
    }
    return V(a.pos);
  }
  return V(spec.pos || [0, 1, 0.3]);
}

function arc(u, v) {
  return new THREE.Quaternion().setFromUnitVectors(u.clone().normalize(), v.clone().normalize());
}

// two-bone IK; pole = where the middle joint points (null: its own bend, or forward for a leg / back for an arm); endQ = hold
// the end bone's world orientation (feet stay flat), null = it turns with the lower bone
export function solveTwoBone(body, a, b, c, target, pole, endQ, w) {
  if (isHinge(b)) return solveHinge(body, a, b, c, target, pole, endQ, w);
  if (!pole) pole = autoPole(body, a, a, b, c);
  const pa = body.worldPos(a), pb = body.worldPos(b), pc = body.worldPos(c);
  const ga = body.worldQuat(a), gb = body.worldQuat(b);
  const l1 = pa.distanceTo(pb), l2 = pb.distanceTo(pc);
  if (l1 < 1e-5 || l2 < 1e-5) return;
  const to = target.clone().sub(pa);
  if (to.length() < 1e-5) return;
  const dir = to.clone().normalize();
  const d = clamp(to.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const pv = pole.clone().sub(pa);
  let u = pv.clone().sub(dir.clone().multiplyScalar(pv.dot(dir)));
  if (u.length() < 1e-6) { const k = pb.clone().sub(pa); u = k.sub(dir.clone().multiplyScalar(k.dot(dir))); }
  if (u.length() < 1e-6) u = dir.clone().cross(new THREE.Vector3(1, 0, 0));
  u.normalize();
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const pb2 = pa.clone().add(dir.clone().multiplyScalar(cosA * l1)).add(u.clone().multiplyScalar(Math.sqrt(1 - cosA * cosA) * l1));
  const pc2 = pa.clone().add(dir.clone().multiplyScalar(d));
  const od = pb.clone().sub(pa).normalize();
  let on = pb.clone().sub(pa).cross(pc.clone().sub(pb));
  if (on.length() < 1e-7) on = pb.clone().sub(pa).cross(pole.clone().sub(pa));
  if (on.length() < 1e-7) on = od.clone().cross(new THREE.Vector3(1, 0, 0));
  on.normalize();
  const nd = pb2.clone().sub(pa).normalize();
  let nn = pb2.clone().sub(pa).cross(pc2.clone().sub(pb2));
  if (nn.length() < 1e-7) nn = on.clone();
  nn.normalize();
  const mOld = new THREE.Matrix4().makeBasis(od, on, od.clone().cross(on));
  const mNew = new THREE.Matrix4().makeBasis(nd, nn, nd.clone().cross(nn));
  const q1 = new THREE.Quaternion().setFromRotationMatrix(mNew.multiply(mOld.transpose()));
  const lowNow = pc.clone().sub(pb).normalize().applyQuaternion(q1);
  const q2 = arc(lowNow, pc2.clone().sub(pb2));
  body.setWorldQuat(a, q1.clone().multiply(ga), w);
  body.setWorldQuat(b, q2.clone().multiply(q1).multiply(gb), w);
  if (endQ) body.setWorldQuat(c, endQ, w);
}

// two-bone IK for a hinge (knee, elbow): the middle joint only bends on its X, inside its limits (so a knee never bends forward
// and never twists), the upper bone aims the limb at the target along the shortest arc (the bend keeps the plane the limb
// already bends in), then, when a pole is given, turns about that line so the joint points at it. The joint limits never fight
// the result (the old free solve put twist into the thigh that the limits then clamped, and the foot missed).
function solveHinge(body, a, b, c, target, pole, endQ, w) {
  const bones = [a, b, c].map((n) => body.bone(n));
  const before = bones.map((x) => x.quaternion.clone());
  const pa = body.worldPos(a);
  const want = target.distanceTo(pa);
  const e = clampLimits(b, body.localEuler(b));
  const [lo, hi] = (rigData.limits[b] || {}).x || [-Math.PI, Math.PI];
  const miss = (x) => { body.setLocalEuler(b, [x, e[1], e[2]]); return Math.abs(body.worldPos(c).distanceTo(pa) - want); };
  let best = e[0], bm = Infinity;
  const N = 48, step = (hi - lo) / N;
  for (let i = 0; i <= N; i++) { const x = lo + step * i, m = miss(x); if (m < bm) { bm = m; best = x; } }
  let l = Math.max(lo, best - step), r = Math.min(hi, best + step);
  for (let it = 0; it < 30; it++) {
    const m1 = l + (r - l) / 3, m2 = r - (r - l) / 3;
    if (miss(m1) < miss(m2)) r = m2; else l = m1;
  }
  body.setLocalEuler(b, [(l + r) / 2, e[1], e[2]]);
  body.setWorldQuat(a, arc(body.worldPos(c).sub(pa), target.clone().sub(pa)).multiply(body.worldQuat(a)));
  const axis = target.clone().sub(pa).normalize();
  const k = body.worldPos(b).sub(pa), pv = pole ? pole.clone().sub(pa) : new THREE.Vector3();
  k.sub(axis.clone().multiplyScalar(k.dot(axis)));
  pv.sub(axis.clone().multiplyScalar(pv.dot(axis)));
  if (pole && k.length() > 1e-5 && pv.length() > 1e-5) {
    const ang = Math.atan2(axis.dot(k.clone().cross(pv)), k.dot(pv));
    body.setWorldQuat(a, new THREE.Quaternion().setFromAxisAngle(axis, ang).multiply(body.worldQuat(a)));
  }
  if (endQ) body.setWorldQuat(c, endQ);
  if (w < 1) {
    bones.forEach((x, i) => x.quaternion.copy(before[i].clone().slerp(x.quaternion.clone(), clamp(w, 0, 1))));
    body.update();
  }
}

export function autoPole(body, limb, a, b, c) {
  const pa = body.worldPos(a), pb = body.worldPos(b), pc = body.worldPos(c);
  const mid = pa.clone().add(pc).multiplyScalar(0.5);
  const off = pb.clone().sub(mid);
  const line = pc.clone().sub(pa).normalize();
  off.sub(line.clone().multiplyScalar(off.dot(line)));
  const want = new THREE.Vector3(0, 0, limb.startsWith("leg") ? 1 : -1);
  if (off.length() > 0.01 * pa.distanceTo(pc)) return pb.clone().add(off.normalize().multiplyScalar(0.4));
  return pb.clone().add(want.multiplyScalar(0.4));
}

function limbIds(body, limb) {
  const l = LIMBS[limb];
  return l && l.every((n) => body.has(n)) ? l : null;
}

function ik(c, f, body, w, touched) {
  const ids = limbIds(body, c.limb);
  if (!ids) return;
  const t = targetPoint(c.target, f, body);
  const pole = c.pole && Object.keys(c.pole).length ? targetPoint(c.pole, f, body) : null;
  const keep = c.keep_end !== false ? body.worldQuat(ids[2]) : null;
  solveTwoBone(body, ids[0], ids[1], ids[2], t, pole, keep, w);
  ids.forEach((n) => touched.add(n));
}

function capturePins(doc, body, bones, ctx) {
  for (const c of doc.constraints) {
    if (c.type !== "pin" || c.enabled === false) continue;
    const key = "pin:" + c.id;
    if (ctx[key] || !body.has(c.bone)) continue;
    body.apply(layerPose(doc, Number(c.pin_frame ?? c.start ?? 0), bones));
    ctx[key] = { p: body.worldPos(c.bone), q: body.worldQuat(c.bone) };
  }
}

function pin(c, body, w, touched, ctx) {
  const cap = ctx["pin:" + c.id];
  if (!cap || !body.has(c.bone)) return;
  const what = c.what || "both";
  const limb = limbOfEnd(c.bone);
  if (limb && what !== "rotation") {
    const ids = limbIds(body, limb);
    if (!ids) return;
    const keep = what === "both" ? cap.q : body.worldQuat(ids[2]);
    solveTwoBone(body, ids[0], ids[1], ids[2], cap.p, null, keep, w);
    ids.forEach((n) => touched.add(n));
    return;
  }
  if (what !== "position") {
    body.setWorldQuat(c.bone, cap.q, w);
    touched.add(c.bone);
  }
  if (c.bone === "hips" && what !== "rotation") {
    const b = body.bone("hips");
    const local = b.parent.worldToLocal(cap.p.clone());
    b.position.lerp(local, clamp(w, 0, 1));
    body.update();
    touched.add("hips");
  }
}

const AXES = { "+x": [1, 0, 0], "-x": [-1, 0, 0], "+y": [0, 1, 0], "-y": [0, -1, 0], "+z": [0, 0, 1], "-z": [0, 0, -1] };

function aim(c, f, body, w, touched) {
  const n = c.bone || "head";
  if (!body.has(n)) return;
  const g = body.worldQuat(n);
  const fwd = V(AXES[c.axis || "+z"] || [0, 0, 1]).applyQuaternion(g);
  const want = targetPoint(c.target, f, body).sub(body.worldPos(n));
  if (want.length() < 1e-4) return;
  body.setWorldQuat(n, arc(fwd, want).multiply(g), w);
  touched.add(n);
}

function limit(c, body, w, touched) {
  if (!body.has(c.bone)) return;
  const e = body.localEuler(c.bone);
  const lo = v3(c.min || [-Math.PI, -Math.PI, -Math.PI]), hi = v3(c.max || [Math.PI, Math.PI, Math.PI]);
  const cl = e.map((x, i) => clamp(x, lo[i], hi[i]));
  if (cl.every((x, i) => Math.abs(x - e[i]) < 1e-9)) return;
  body.setLocalEuler(c.bone, lerp3(e, cl, clamp(w, 0, 1)));
  touched.add(c.bone);
}

function copyRot(c, body, w, touched) {
  if (!body.has(c.bone) || !body.has(c.source)) return;
  let se = body.localEuler(c.source);
  if (c.mirror) se = mirrorEuler(se);
  se = add3(mul3(se, Number(c.mix ?? 1)), v3(c.offset || [0, 0, 0]));
  body.setLocalEuler(c.bone, lerp3(body.localEuler(c.bone), se, clamp(w, 0, 1)));
  touched.add(c.bone);
}

export function restHeight(body, n, ctx, radius = 0.04) {
  if (!n.startsWith("foot")) return radius;
  const key = "rest_h:" + body.root.uuid + ":" + n;
  if (ctx[key] === undefined) ctx[key] = Math.max(0, body.restWorld(n).y);
  return ctx[key];
}

function floor(c, body, w, touched, ctx) {
  if (!body.has("hips")) return;
  const fy = Number(c.height || 0);
  let need = -Infinity;
  const soles = soleInfo(body);
  for (const n of c.bones || ["footL", "footR"]) {
    if (!body.has(n)) continue;
    if (soles[n]) { need = Math.max(need, fy - lowest(body, n, soles)); continue; }   // a foot: its real sole (the mesh), not the ankle
    need = Math.max(need, fy + restHeight(body, n, ctx, Number(c.radius ?? 0.04)) - body.worldPos(n).y);
  }
  if (need === -Infinity || ((c.mode || "floor") === "floor" && need <= 0)) return;
  const hips = body.bone("hips");
  const world = hips.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, need * clamp(w, 0, 1), 0));
  hips.position.copy(hips.parent.worldToLocal(world));
  body.update();
  touched.add("hips");
}

// CCD for any joint that is not a hand or a foot: turn up to `chain` parents (never root / hips) so the joint reaches the target
export function ccd(body, n, target, chain = 3, iters = 12) {
  const ids = [];
  let p = body.parentName(n);
  while (p && ids.length < chain) {
    if (p === "root" || p === "hips") break;
    ids.push(p);
    p = body.parentName(p);
  }
  for (let it = 0; it < iters; it++) {
    for (const j of ids) {
      const pj = body.worldPos(j);
      const end = body.worldPos(n);
      if (end.distanceTo(target) < 0.002) return ids;
      const a = end.sub(pj), b = target.clone().sub(pj);
      if (a.length() < 1e-4 || b.length() < 1e-4) continue;
      let r = arc(a, b);
      const ang = 2 * Math.acos(clamp(Math.abs(r.w), 0, 1));
      if (ang > 0.35) r = new THREE.Quaternion().slerp(r, 0.35 / ang);
      body.setWorldQuat(j, r.multiply(body.worldQuat(j)), 0.6);
    }
  }
  return ids;
}

// the clip as the game plays it: a key on every frame from the final pose
export function bake(doc, body, bones, ctx) {
  const out = [];
  for (let f = 0; f <= doc.frames; f++) {
    const k = { f };
    fillKey(k, finalPose(doc, f, body, bones, ctx), bones);
    out.push(k);
  }
  return out;
}
