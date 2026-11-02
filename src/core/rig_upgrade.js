// Rig v5 upgrade for a rig-v4 deform skeleton.
//
// The game's fighters are rig v4 (root, hips, torso/chest, 3-joint fingers, 3 tail bones, no clavicles / toes).
// The v5 schema (data/rig_v5.json) names the joints Mixamo has in between. This module inserts the missing ones
// into the loaded three.js skeleton at load time, moving nothing at rest:
//
//   split   - a bone that sits between two existing bones (Spine1 between torso and chest, a clavicle between
//             chest and the upper arm): the child bone is reparented under it and its local offset shortened, so
//             its world transform does not change.
//   sole    - a toe: put at the ball of the foot, read from the model's baked sole (data/feet_soles.json) or,
//             failing that, from the foot's own mesh extents. The front of the foot is re-weighted onto it, so a
//             toe curl really bends the shoe.
//   extend  - a terminal joint with no existing child (the 4th finger joints, the tail tip, the 3rd / 4th thumb
//             joints): placed past its parent by the parent's own last segment length times `extend`.
//
// Only bones that v4 already has a parent for are made. A whole missing chain (a hand without index / ring /
// pinky joints) is still skipped, never invented. Mixamo skeletons are left alone: they already have all of it.
import * as THREE from "three";

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
};

function soleFor(soles, key, side) {
  if (!soles) return null;
  const k = String(key || "").toLowerCase() + "_fight.glb";
  const entry = Object.keys(soles).find((p) => p.toLowerCase().endsWith("/" + k)) || Object.keys(soles).find((p) => p.toLowerCase().endsWith(k));
  return entry && soles[entry] && soles[entry]["foot" + side] ? soles[entry]["foot" + side] : null;
}

// the foot's forward (+Z of the model) in the foot bone's own axes, flattened onto the sole plane
function footForward(foot, info) {
  const n = new THREE.Vector3(...(info.n || [0, 1, 0])).normalize();
  const q = foot.getWorldQuaternion(new THREE.Quaternion()).invert();
  const fw = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  fw.addScaledVector(n, -fw.dot(n));
  if (fw.length() < 1e-4) fw.set(0, 0, 1);
  return { n, fw: fw.normalize() };
}

// the toe joint's rest position in the foot's local space: at the ball, just above the sole
function toeOffset(foot, info, up) {
  if (!info || !info.pts || info.pts.length < 3) return null;
  const { n, fw } = footForward(foot, info);
  let lo = Infinity, hi = -Infinity;
  for (const p of info.pts) {
    const d = new THREE.Vector3(...p).dot(fw);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  if (!(hi > lo)) return null;
  const ball = lo + (hi - lo) * (Number(up.ball) || 0.62);
  const h = Number(info.h) || Math.max(0.02, (hi - lo) * 0.3);
  return fw.multiplyScalar(ball).addScaledVector(n, -h * (Number(up.lift) || 0.85));
}

function toeFromMesh(foot, meshes) {
  const inv = foot.matrixWorld.clone().invert();
  let hi = -Infinity, lo = Infinity;
  const p = new THREE.Vector3();
  const footIndex = (mesh) => mesh.skeleton && mesh.skeleton.bones.indexOf(foot);
  for (const mesh of meshes) {
    if (!mesh.isSkinnedMesh || !mesh.skeleton) continue;
    const fi = footIndex(mesh);
    if (fi < 0) continue;
    const pos = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    if (!pos || !si || !sw) continue;
    for (let v = 0; v < pos.count; v++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si.getComponent(v, k) === fi) w += sw.getComponent(v, k);
      if (w < 0.5) continue;
      p.fromBufferAttribute(pos, v).applyMatrix4(inv);
      lo = Math.min(lo, p.z);
      hi = Math.max(hi, p.z);
    }
  }
  if (!(hi > lo)) return new THREE.Vector3(0, -0.04, 0.16);
  return new THREE.Vector3(0, -0.04, lo + (hi - lo) * 0.62);
}

// move the front of a foot's vertices onto its toe (the sole keeps every point: feet.js counts the toe chain)
function weightToe(mesh, foot, toe, info) {
  const sk = mesh.skeleton;
  const fi = sk.bones.indexOf(foot);
  if (fi < 0) return 0;
  let ti = sk.bones.indexOf(toe);
  if (ti < 0) {
    sk.bones.push(toe);
    sk.boneInverses.push(new THREE.Matrix4().copy(toe.matrixWorld).invert());
    ti = sk.bones.length - 1;
  }
  const geo = mesh.geometry;
  const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  if (!pos || !si || !sw) return 0;
  const { fw } = footForward(foot, info);
  const ball = toe.position.dot(fw);
  let front = 0;
  for (const p of info.pts) front = Math.max(front, new THREE.Vector3(...p).dot(fw) - ball);
  front = Math.max(0.05, front);
  const a = Math.max(0.012, front * 0.18), b = Math.max(a + 0.025, front * 0.62);
  const inv = foot.matrixWorld.clone().invert();
  const p = new THREE.Vector3();
  const idx = [0, 0, 0, 0], w = [0, 0, 0, 0];
  let moved = 0;
  for (let v = 0; v < pos.count; v++) {
    let wf = 0;
    for (let k = 0; k < 4; k++) if (si.getComponent(v, k) === fi) wf += sw.getComponent(v, k);
    if (wf <= 1e-6) continue;
    p.fromBufferAttribute(pos, v).applyMatrix4(inv);
    const k = smoothstep(a, b, p.dot(fw) - ball);
    if (k <= 1e-4) continue;
    for (let j = 0; j < 4; j++) { idx[j] = si.getComponent(v, j); w[j] = sw.getComponent(v, j); }
    let left = k * wf;
    for (let j = 0; j < 4 && left > 1e-9; j++) if (idx[j] === fi) { const d = Math.min(w[j], left); w[j] -= d; left -= d; }
    let slot = -1;
    for (let j = 0; j < 4; j++) if (idx[j] !== ti && w[j] <= 1e-9) { slot = j; break; }
    if (slot < 0) {
      let small = Infinity;
      for (let j = 0; j < 4; j++) if (idx[j] !== fi && idx[j] !== ti && w[j] < small) { small = w[j]; slot = j; }
    }
    if (slot < 0) slot = 3;
    const keep = idx[slot] === ti ? w[slot] : 0;
    idx[slot] = ti;
    w[slot] = keep + k * wf;
    let sum = w[0] + w[1] + w[2] + w[3];
    if (sum > 1e-6) for (let j = 0; j < 4; j++) w[j] /= sum;
    for (let j = 0; j < 4; j++) { si.setComponent(v, j, idx[j]); sw.setComponent(v, j, w[j]); }
    moved++;
  }
  if (moved) { si.needsUpdate = true; sw.needsUpdate = true; }
  return moved;
}

// root: the loaded gltf.scene (bones are its descendants). schema: data/rig_v5.json.
// soles: data/feet_soles.json (baked from the game's feet.gd), key: the fighter ("vix").
// Returns { style, added, skipped, toe_verts }.
export function upgradeRigV4(root, schema, soles = null, key = "") {
  const out = { fighter: key, style: "none", added: [], skipped: [], toe_verts: { toeL: 0, toeR: 0 } };
  if (!root || !schema || !schema.bones) return out;

  const boneByName = new Map();
  const meshes = [];
  root.traverse((o) => {
    if (o.isBone && o.name && !boneByName.has(o.name)) boneByName.set(o.name, o);
    if (o.isSkinnedMesh && o.skeleton) meshes.push(o);
  });
  const names = [...boneByName.keys()];
  const mixamo = names.some((n) => /^mixamorig/i.test(n));
  out.style = mixamo ? "mixamo" : names.includes("hips") ? "rigv4" : "none";
  if (out.style !== "rigv4") return out;
  root.updateMatrixWorld(true);

  const map = new Map();   // canonical -> actual bone
  for (const [canonical, info] of Object.entries(schema.bones)) {
    const alias = (info.aliases && info.aliases.rigv4) || "";
    const b = (alias && boneByName.get(alias)) || boneByName.get(canonical);
    if (b) map.set(canonical, b);
  }
  const kids = new Map();
  for (const [canonical, info] of Object.entries(schema.bones)) {
    const p = info.parent || "";
    if (!p) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(canonical);
  }

  for (const [canonical, info] of Object.entries(schema.bones)) {
    if (map.has(canonical)) continue;
    const up = info.upgrade;
    if (!up) continue;
    const parent = map.get(info.parent || "");
    if (!parent) { out.skipped.push(canonical); continue; }
    const childCanonical = (kids.get(canonical) || []).find((c) => map.has(c));
    const bone = new THREE.Bone();
    bone.name = canonical;
    bone.quaternion.identity();
    bone.scale.set(1, 1, 1);
    bone.userData = { ...(bone.userData || {}), rigV5Upgrade: true };
    if (childCanonical && typeof up.insert === "number") {
      const child = map.get(childCanonical);
      const bp = child.position.clone().multiplyScalar(Math.min(0.95, Math.max(0.05, up.insert)));
      const cp = child.position.clone().sub(bp);
      parent.add(bone);
      bone.position.copy(bp);
      if (child.parent) child.parent.remove(child);
      bone.add(child);
      child.position.copy(cp);
    } else if (up.insert === "sole") {
      const side = canonical.endsWith("R") ? "R" : "L";
      const off = toeOffset(parent, soleFor(soles, key, side), up) || toeFromMesh(parent, meshes);
      bone.position.copy(off);
      parent.add(bone);
    } else {
      const ext = Number.isFinite(up.extend) ? up.extend : 1;
      bone.position.copy(parent.position).multiplyScalar(ext);
      parent.add(bone);
    }
    map.set(canonical, bone);
    boneByName.set(canonical, bone);
    out.added.push(canonical);
  }
  root.updateMatrixWorld(true);

  // the toe carries the front of the shoe (and feet.js knows to include the toe chain in a sole)
  for (const side of ["L", "R"]) {
    const foot = map.get("foot" + side), toe = map.get("toe" + side);
    if (!foot || !toe || !out.added.includes("toe" + side)) continue;
    const info = soleFor(soles, key, side);
    if (!info) continue;
    for (const mesh of meshes) out.toe_verts["toe" + side] += weightToe(mesh, foot, toe, info);
  }
  root.updateMatrixWorld(true);
  return out;
}
