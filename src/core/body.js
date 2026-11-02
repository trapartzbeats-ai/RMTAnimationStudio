// A posable body: one instance of a fighter's skeleton, posed exactly like CBClipLib.apply_pose (rest * rotation, hips shift).
// Every body stands at the origin facing +Z, so world space here = what the game calls the fighter's space.
import * as THREE from "three";
import { boneRot, rotQuat, eulerOf, FOLLOW } from "./clip.js";
import { mapQuat, unmapQuat } from "./fingers.js";

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class Body {
  // fmap: the fighter's finger retarget (fingers.js fingerMapOf): finger turns in clips are on the shared hand
  constructor(root, fmap = null) {
    this.root = root;
    this.fmap = fmap;
    this.bones = new Map();
    this.rest = new Map();
    root.traverse((o) => {
      if (o.isBone && !this.bones.has(o.name)) this.bones.set(o.name, o);
    });
    // a stable order: parents before children (traversal order)
    this.names = [...this.bones.keys()];
    for (const [n, b] of this.bones) this.rest.set(n, { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() });
    root.updateMatrixWorld(true);
  }

  has(n) { return this.bones.has(n); }
  bone(n) { return this.bones.get(n); }

  parentName(n) {
    const p = this.bones.get(n)?.parent;
    return p && p.isBone ? p.name : "";
  }

  children(n) {
    const b = this.bones.get(n);
    return b ? b.children.filter((c) => c.isBone).map((c) => c.name) : [];
  }

  apply(pose) {
    for (const [n, b] of this.bones) {
      const r = this.rest.get(n);
      b.quaternion.copy(r.q).multiply(mapQuat(this.fmap, n, boneRot(pose, n), _q));
      b.position.copy(r.p);
      b.scale.copy(r.s);
      if (n === "hips") b.position.add(_v.set(pose._dx || 0, pose._dy || 0, pose._dz || 0));
    }
    this.root.updateMatrixWorld(true);
  }

  update() { this.root.updateMatrixWorld(true); }

  worldPos(n, out = new THREE.Vector3()) {
    const b = this.bones.get(n);
    return b ? b.getWorldPosition(out) : out.set(0, 0, 0);
  }

  worldQuat(n, out = new THREE.Quaternion()) {
    const b = this.bones.get(n);
    return b ? b.getWorldQuaternion(out) : out.identity();
  }

  parentWorldQuat(n, out = new THREE.Quaternion()) {
    const b = this.bones.get(n);
    return b && b.parent ? b.parent.getWorldQuaternion(out) : out.identity();
  }

  // turn a bone to a world orientation, blended by w with its current one
  setWorldQuat(n, qWorld, w = 1) {
    const b = this.bones.get(n);
    if (!b) return;
    this.parentWorldQuat(n, _q2).invert();
    const local = _q2.multiply(qWorld);
    b.quaternion.slerp(local, Math.min(1, Math.max(0, w)));
    b.updateMatrixWorld(true);
  }

  // the bone's Euler (radians, ZYX) on top of its rest, as the clip stores it (follow not removed)
  localEuler(n) {
    const b = this.bones.get(n);
    const r = this.rest.get(n);
    _q.copy(r.q).invert().multiply(b.quaternion);
    return eulerOf(unmapQuat(this.fmap, n, _q));
  }

  setLocalEuler(n, e) {
    const b = this.bones.get(n);
    const r = this.rest.get(n);
    if (!b) return;
    b.quaternion.copy(r.q).multiply(mapQuat(this.fmap, n, e, _q));
    b.updateMatrixWorld(true);
  }

  hipsShift() {
    const b = this.bones.get("hips");
    if (!b) return [0, 0, 0];
    const r = this.rest.get("hips");
    return [b.position.x - r.p.x, b.position.y - r.p.y, b.position.z - r.p.z];
  }

  // rest-pose world position (the model stands on y = 0 at rest)
  restWorld(n) {
    const saved = new Map();
    for (const [k, b] of this.bones) saved.set(k, [b.position.clone(), b.quaternion.clone()]);
    for (const [k, b] of this.bones) {
      const r = this.rest.get(k);
      b.position.copy(r.p);
      b.quaternion.copy(r.q);
    }
    this.root.updateMatrixWorld(true);
    const p = this.worldPos(n);
    for (const [k, b] of this.bones) {
      const s = saved.get(k);
      b.position.copy(s[0]);
      b.quaternion.copy(s[1]);
    }
    this.root.updateMatrixWorld(true);
    return p;
  }
}

export const isFollower = (n) => !!FOLLOW[n];
