// Feet on the floor, a port of the game's feet.gd (CBFeet) onto a Body, in world space. Each foot's sole is read once from the
// model's own mesh: the plane the bottom of the foot lies on, how high the ankle sits above it, and the sole's outline (toe,
// heel, sides). The models were not all built standing level: Carter, Al, Guru, Hype and Vic stand in a stance at rest with
// one foot turned out and lower than the other, so neither the ankle bone nor the rest pose says where the sole is. ground()
// then, on a pose the clip just put on the body:
//   1. levels every foot near the floor on its own sole plane, keeping where the toes point; a foot whose ankle the clip keys
//      well onto the toes or the heel (a push-off, a heel strike) keeps that and pivots on the toe / heel
//   2. keeps every ankle inside its natural turn, so a deep crouch lifts the heel instead of bending the ankle past what one does
//   3. (planted clips) lifts or lowers the body so the lower foot's sole, not its ankle, stands on the floor
//   4. brings each foot near the floor onto it with two-bone leg IK: the knee keeps the clip's own bend plane and is never
//      straighter than its rest bend; when a leg cannot reach, the body comes down a little so it can. No foot goes into the floor
// A foot well off the floor (a kick, a step) is left as the clip keys it, fading in between.
import * as THREE from "three";
import { clamp } from "./clip.js";

export const CONTACT_FULL = 0.04;   // a foot whose lowest point is up to 4 cm above the other one's is standing on the floor
export const CONTACT_NONE = 0.12;   // one 12 cm up is off it (in between it fades)
export const PIVOT_FROM = 0.3;      // radians the clip keys the ankle toward the toes / heel (from rest) where a pivot starts
export const PIVOT_FULL = 0.6;      // and from here the foot keeps the clip's tip fully
// natural ankle turns (rig v4: foot +X = toes down), the same as the rig's natural limits
export const LIMITS = {
  footL: { x: [-0.7, 0.95], y: [-0.5, 0.5], z: [-0.45, 0.45] },
  footR: { x: [-0.7, 0.95], y: [-0.5, 0.5], z: [-0.45, 0.45] },
};
const SIDES = ["L", "R"];
const UP = new THREE.Vector3(0, 1, 0);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// the turn that takes direction u onto v (the shortest arc; a half turn about a perpendicular when they are opposite)
function arc(u, v) {
  const a = u.clone().normalize(), b = v.clone().normalize();
  const d = clamp(a.dot(b), -1, 1);
  const ax = a.clone().cross(b);
  if (ax.length() < 1e-7) {
    if (d > 0) return new THREE.Quaternion();
    const perp = (Math.abs(a.x) < 0.9 ? a.clone().cross(new THREE.Vector3(1, 0, 0)) : a.clone().cross(UP)).normalize();
    return new THREE.Quaternion().setFromAxisAngle(perp, Math.PI);
  }
  return new THREE.Quaternion().setFromAxisAngle(ax.normalize(), Math.acos(d));
}

const worldScale = (b) => b.getWorldScale(new THREE.Vector3()).y;

// ---------------------------------------------------------------- reading the soles

// {footL: {n: sole up in the foot's own axes, h: ankle height above the sole plane, pts: sole outline (foot axes), tilt0: how
//  far the sole is off level at rest (degrees), verts: how many vertices the foot carries, size}, footR: ...}. Read off the
// body's skinned meshes at rest; the body is posed back the way it was.
export function readSoles(body) {
  const saved = new Map();
  for (const [k, b] of body.bones) saved.set(k, [b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
  for (const [k, b] of body.bones) { const r = body.rest.get(k); b.position.copy(r.p); b.quaternion.copy(r.q); b.scale.copy(r.s); }
  body.update();
  const meshes = [];
  body.root.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) meshes.push(o); });
  const out = {};
  for (const s of SIDES) if (body.has("foot" + s)) out["foot" + s] = fit(body, "foot" + s, meshes);
  for (const [k, b] of body.bones) { const v = saved.get(k); b.position.copy(v[0]); b.quaternion.copy(v[1]); b.scale.copy(v[2]); }
  body.update();
  return out;
}

// one foot's sole from the vertices it carries (weight >= 0.5), at rest, in the foot bone's own axes
function fit(body, name, meshes) {
  const foot = body.bone(name);
  const restW = foot.matrixWorld.clone();
  const inv = restW.clone().invert();
  const qRest = foot.getWorldQuaternion(new THREE.Quaternion());
  const dn = new THREE.Vector3(0, -1, 0).applyQuaternion(qRest.clone().invert()).normalize();   // the floor's down, in the foot's axes
  const pts = [];
  const tris = [];   // foot-local triangles whose 3 corners the foot carries
  const v = new THREE.Vector3(), acc = new THREE.Vector3(), tmp = new THREE.Vector3();
  const m = new THREE.Matrix4();
  // a v5-upgraded foot carries the front of the sole on its toe; the sole still belongs to the foot
  const toe = body.has("toe" + name.slice(4)) ? body.bone("toe" + name.slice(4)) : null;
  for (const mesh of meshes) {
    const g = mesh.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    if (!pos || !si || !sw) continue;
    const bones = mesh.skeleton.bones, invs = mesh.skeleton.boneInverses;
    const fi = bones.indexOf(foot);
    if (fi < 0) continue;
    const ti = toe ? bones.indexOf(toe) : -1;
    const local = new Map();   // vertex index -> foot-local rest position
    for (let i = 0; i < pos.count; i++) {
      let on = 0;
      for (let j = 0; j < 4; j++) {
        const bj = si.getComponent(i, j);
        if (bj === fi || (ti >= 0 && bj === ti)) on += sw.getComponent(i, j);
      }
      if (on < 0.5) continue;
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix);
      acc.set(0, 0, 0);
      let tw = 0;
      for (let j = 0; j < 4; j++) {
        const w = sw.getComponent(i, j), bj = si.getComponent(i, j);
        if (w <= 0 || !bones[bj]) continue;
        m.multiplyMatrices(bones[bj].matrixWorld, invs[bj]);
        acc.add(tmp.copy(v).applyMatrix4(m).multiplyScalar(w));
        tw += w;
      }
      const p = acc.multiplyScalar(1 / Math.max(tw, 1e-6)).clone().applyMatrix4(inv);
      local.set(i, p);
      pts.push(p);
    }
    const idx = g.index ? g.index.array : null;
    const n = idx ? idx.length : pos.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
      if (local.has(a) && local.has(b) && local.has(c)) tris.push([local.get(a), local.get(b), local.get(c)]);
    }
  }
  if (pts.length < 8) {
    const h0 = Math.max(0, foot.getWorldPosition(new THREE.Vector3()).y) / worldScale(foot);
    return { n: dn.clone().negate(), h: h0, pts: [dn.clone().multiplyScalar(h0)], tilt0: 0, verts: pts.length, size: 0 };
  }
  const box = new THREE.Box3().setFromPoints(pts);
  const ext = box.getSize(new THREE.Vector3());
  const size = Math.max(ext.x, ext.y, ext.z);
  // the sole plane: the area-weighted normal of the faces that look down at the bottom of the foot (3 rounds, each on the faces
  // near the plane the round before found)
  let d = dn.clone();
  const cos50 = Math.cos((50 * Math.PI) / 180);
  for (let round = 0; round < 3; round++) {
    const s0 = support(pts, d);
    const sum = new THREE.Vector3();
    for (const [a, b, c] of tris) {
      const nb = b.clone().sub(a).cross(c.clone().sub(a));   // length = 2 x area
      if (nb.length() < 1e-12) continue;
      if (a.clone().add(b).add(c).divideScalar(3).dot(d) < s0 - 0.12 * size) continue;
      const nn = nb.dot(d) > 0 ? nb : nb.negate();   // either winding: the side that faces down
      if (nn.clone().normalize().dot(d) < cos50) continue;
      sum.add(nn);
    }
    if (sum.length() < 1e-9) break;
    d = sum.normalize();
  }
  const s = support(pts, d);
  // the contact points: whichever vertex is lowest when the foot tips any way up to 80 degrees off level (flat: the sole; on its
  // toes: the toe cap; back on the heel: the heel), so lowest() is right at every tilt. Only the lower half of the foot can be
  // lowest there.
  let fw = new THREE.Vector3(0, 0, 1).applyQuaternion(qRest.clone().invert());   // the fighter's facing (+Z) in the foot's axes
  fw = fw.sub(d.clone().multiplyScalar(fw.dot(d))).normalize();
  const sd = d.clone().cross(fw).normalize();
  const low = pts.filter((p) => p.dot(d) >= s * 0.5);
  const outline = [];
  for (let ring = 0; ring < 9; ring++) {
    const polar = ((10 * ring) * Math.PI) / 180;
    const count = ring === 0 ? 1 : Math.max(6, Math.round(18 * Math.sin(polar)));
    for (let i = 0; i < count; i++) {
      const az = (Math.PI * 2 * i) / count;
      const dv = d.clone().multiplyScalar(Math.cos(polar)).add(fw.clone().multiplyScalar(Math.cos(az)).add(sd.clone().multiplyScalar(Math.sin(az))).multiplyScalar(Math.sin(polar)));
      let best = low[0], bd = -Infinity;
      for (const p of low) { const x = p.dot(dv); if (x > bd) { bd = x; best = p; } }
      if (!outline.includes(best)) outline.push(best);
    }
  }
  const tilt0 = (d.clone().negate().applyQuaternion(qRest).angleTo(UP) * 180) / Math.PI;
  return { n: d.clone().negate(), h: s, pts: outline.map((p) => p.clone()), tilt0, verts: pts.length, size };
}

function support(pts, d) {
  let s = -Infinity;
  for (const p of pts) s = Math.max(s, p.dot(d));
  return s;
}

// a body's soles (read once per body, kept on it)
export function soleInfo(body) {
  if (!body._soles) body._soles = readSoles(body);
  return body._soles;
}

// ---------------------------------------------------------------- standing on them

// the lowest point of a foot's sole outline, world height
export function lowest(body, b, info = soleInfo(body)) {
  if (!info[b]) return Infinity;
  const mw = body.bone(b).matrixWorld;
  const p = new THREE.Vector3();
  let lo = Infinity;
  for (const q of info[b].pts) lo = Math.min(lo, p.copy(q).applyMatrix4(mw).y);
  return lo;
}

// the lowest point of a foot's sole if it had world turn `q`, world height
function lowestAs(body, b, fi, q) {
  const bone = body.bone(b);
  const o = bone.getWorldPosition(new THREE.Vector3());
  const k = worldScale(bone);
  const p = new THREE.Vector3();
  let lo = Infinity;
  for (const pt of fi.pts) lo = Math.min(lo, p.copy(pt).multiplyScalar(k).applyQuaternion(q).add(o).y);
  return lo;
}

// which feet of the pose stand on the floor (changes nothing): per foot {w: 1 standing .. 0 off the floor, pivot: how much the
// clip keys the ankle onto the toes / heel, tilt: degrees the sole is off level as keyed, flat: the turn it would stand with}
export function standing(body, info = soleInfo(body)) {
  const out = {};
  let lo = Infinity;
  for (const b in info) {
    const g = body.worldQuat(b);
    const n = info[b].n.clone().applyQuaternion(g).normalize();
    const keyed = body.localEuler(b)[0];
    const pivot = smoothstep(PIVOT_FROM, PIVOT_FULL, Math.abs(keyed));
    const level = g.clone().slerp(arc(n, UP).multiply(g.clone()), 1 - pivot);
    const est = lowestAs(body, b, info[b], level);
    lo = Math.min(lo, est);
    out[b] = { tilt: (n.angleTo(UP) * 180) / Math.PI, pivot, flat: level, est };
  }
  for (const b in out) out[b].w = 1 - smoothstep(CONTACT_FULL, CONTACT_NONE, out[b].est - lo);
  return out;
}

// degrees a foot's sole leans sideways (about the foot's own length) in the world: world up seen in the foot's frame, against
// the sole's normal, measured across the foot (the bone's X, the pitch axis of a toe / heel pivot, so a pivot is not roll)
export function soleRoll(body, b, info = soleInfo(body)) {
  if (!info[b]) return 0;
  const n = info[b].n.clone().normalize();
  const up = UP.clone().applyQuaternion(body.worldQuat(b).clone().invert()).normalize();
  const x = new THREE.Vector3(1, 0, 0);
  x.sub(n.clone().multiplyScalar(x.dot(n))).normalize();
  return (Math.asin(clamp(up.dot(x), -1, 1)) * 180) / Math.PI;
}

// keep a foot inside its natural turn; true when it had to stop there
function clampFoot(body, b) {
  const lim = LIMITS[b];
  if (!lim) return false;
  const e = body.localEuler(b);
  const o = e.map((x, i) => { const r = lim["xyz"[i]]; return r ? clamp(x, r[0], r[1]) : x; });
  if (o.every((x, i) => Math.abs(x - e[i]) < 1e-6)) return false;
  body.setLocalEuler(b, o);
  return true;
}

const restReach = new WeakMap();
// the longest the leg gets: its knee at the rest bend (the rig's knee limit), never a straight-line l1 + l2 past it
function legReach(body, s) {
  let m = restReach.get(body);
  if (!m) { m = {}; restReach.set(body, m); }
  if (m[s] === undefined) m[s] = body.restWorld("leg" + s).distanceTo(body.restWorld("foot" + s));
  return m[s];
}

// move a foot's ankle by dy (world) with the leg: thigh + shin turn in the knee's own bend plane; the foot keeps `hold` (its world
// turn). Returns how far short the leg fell, 0 when it reached.
function reach(body, b, dy, hold) {
  const s = b.slice(4);
  const A = "leg" + s, B = "knee" + s;
  if (!body.has(A) || !body.has(B) || !body.has(b)) return 0;
  const pa = body.worldPos(A), pb = body.worldPos(B), pc = body.worldPos(b);
  const l1 = pa.distanceTo(pb), l2 = pb.distanceTo(pc);
  const to = pc.clone().add(new THREE.Vector3(0, dy, 0)).sub(pa);
  if (l1 < 1e-5 || l2 < 1e-5 || to.length() < 1e-5) return 0;
  const most = Math.min(l1 + l2, legReach(body, s)) - 1e-4;
  const short = Math.max(0, to.length() - most);
  const d = clamp(to.length(), Math.abs(l1 - l2) + 1e-4, most);
  const dir = to.clone().normalize();
  // the bend: where the knee points now (off the hip-ankle line); a straight leg bends the knee toward the way the model faces
  const line = pc.clone().sub(pa).normalize();
  let off = pb.clone().sub(pa);
  off.sub(line.clone().multiplyScalar(off.dot(line)));
  if (off.length() < 0.01 * l1) off = new THREE.Vector3(0, 0, 1).applyQuaternion(body.root.getWorldQuaternion(new THREE.Quaternion()));
  const u = off.sub(dir.clone().multiplyScalar(off.dot(dir)));
  if (u.length() < 1e-6) return short;
  u.normalize();
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const pb2 = pa.clone().add(dir.clone().multiplyScalar(cosA * l1)).add(u.clone().multiplyScalar(Math.sqrt(1 - cosA * cosA) * l1));
  const pc2 = pa.clone().add(dir.clone().multiplyScalar(d));
  body.setWorldQuat(A, arc(pb.clone().sub(pa), pb2.clone().sub(pa)).multiply(body.worldQuat(A)));
  const shin = body.worldPos(b).sub(body.worldPos(B));
  body.setWorldQuat(B, arc(shin, pc2.clone().sub(pb2)).multiply(body.worldQuat(B)));
  clampKnee(body, B);   // a knee never bends forward: the reach stops at the rig's knee limit, not past it
  body.setWorldQuat(b, hold);
  clampFoot(body, b);
  return short;
}

// keep a knee out of hyperextension (the reach's two-bone solution can sit a hair past the rest bend)
function clampKnee(body, b) {
  const e = body.localEuler(b);
  if (e[0] >= 0) return;
  e[0] = 0;
  body.setLocalEuler(b, e);
}

// the feet of a posed body on a floor at height floorY (see the top of this file); `model` is the node to lift (the body's root).
// Returns what it did: {lift: body raised by (m), drop: body lowered so a leg could reach (m), footL: {w, tilt, gap, limit}, ...}
export function ground(body, model, floorY, planted) {
  const info = soleInfo(body);
  const done = { lift: 0, drop: 0 };
  if (!Object.keys(info).length) return done;
  body.update();
  const st = standing(body, info);
  const w = {};
  for (const b in info) { w[b] = st[b].w; done[b] = { ...st[b], gap: 0 }; }
  // 1 + 2: level the standing feet (their own sole plane), inside the ankle's natural turn
  const hold = {};
  for (const b in info) {
    if (w[b] > 0) {
      body.setWorldQuat(b, body.worldQuat(b).slerp(st[b].flat, w[b]));
      done[b].limit = clampFoot(body, b);
    }
    hold[b] = body.worldQuat(b);
  }
  // 3: the body, so the lower sole stands on the floor
  if (planted && model) {
    let low = Infinity;
    for (const b in info) low = Math.min(low, lowest(body, b, info));
    if (low !== Infinity) {
      model.position.y += floorY - low;
      done.lift = floorY - low;
      body.update();
    }
  }
  // 4: each standing foot onto the floor (legs), the body down a little when a leg cannot reach; again until it settles
  for (let pass = 0; pass < 4; pass++) {
    let short = 0, moved = 0;
    for (const b in info) {
      const gap = lowest(body, b, info) - floorY;
      done[b].gap = gap;
      const dy = gap > 0 ? -gap * w[b] : -gap;   // a foot never goes into the floor, standing or not
      if (Math.abs(dy) < 5e-4) continue;
      moved = Math.max(moved, Math.abs(dy));
      short = Math.max(short, reach(body, b, dy, hold[b]));
    }
    if (short >= 0.002 && planted && model && done.drop === 0) {
      model.position.y -= short;
      done.drop = short;
      body.update();
      continue;
    }
    if (moved < 5e-4) break;
  }
  return done;
}
