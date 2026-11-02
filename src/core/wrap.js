// The Collision Wrap (RMT Wrap), a port of the game's addons/rmt_wraps (capsule.gd RmtCapsule, wrap_body.gd RmtWrapBody,
// body_solve.gd RmtBodySolve) and CBWraps.make_solver (wraps.gd) onto a Body, so Fight Studio shows the pose a match shows.
// After the clip and the feet have posed the body, every part that went into the body (deeper than it does at rest, past its
// flesh allowance) or under the floor is pushed back out by bending its own joints:
//   - ranks decide who gives way (a hand before the arm, the arm before the chest); equal ranks both move half
//   - a part bends its own joint and a few above it (wrap_rules.json "chain"), the furthest up first; hips and root never bend
//   - every joint stays in its natural range (animator_rig.json "limits"; hinges bend on X only) and within max_turn of the clip
//   - planted feet keep their place (the knee and thigh over a foot on the floor are locked); a body under the floor lifts the model
//   - corrections carry over to the next frame (keep) and change at most max_step a frame: no pops
// Same rules and numbers as the game: data/wraps/<key>.collide.json, wrap_rules.json, animator_rig.json.
//
// A match plays the fighter scaled to its match height (moves/<key>.json height_m over the model's own mesh height) and the
// solve's margins are in metres, so it runs with the model at that scale (atMatchScale). Fight Studio has a floor and no stage
// or other fighters: like the game's clash test (CBWrapPose), no world and no others.
import * as THREE from "three";
import { rotQuat, eulerOf, clamp } from "./clip.js";

const IDQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const vec = (a) => new THREE.Vector3(Number(a[0]), Number(a[1]), Number(a[2]));

// ---------------------------------------------------------------- RmtCapsule

// closest points between segments p0-p1 and q0-q1: [s, t, point on p, point on q] (s, t in 0..1)
export function segClosest(p0, p1, q0, q1) {
  const d1 = p1.clone().sub(p0), d2 = q1.clone().sub(q0), r = p0.clone().sub(q0);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) return [0, 0, p0.clone(), q0.clone()];
  if (a <= 1e-12) t = clamp(f / e, 0, 1);
  else {
    const c = d1.dot(r);
    if (e <= 1e-12) s = clamp(-c / a, 0, 1);
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  return [s, t, p0.clone().addScaledVector(d1, s), q0.clone().addScaledVector(d2, t)];
}

// how deep two capsules overlap: depth > 0 = they overlap by that much; normal points from capsule 2 toward capsule 1
export function overlap(a0, a1, ra, b0, b1, rb) {
  const [s, t, pa, pb] = segClosest(a0, a1, b0, b1);
  const d = pa.clone().sub(pb), dist = d.length();
  return { depth: ra + rb - dist, normal: dist > 1e-9 ? d.divideScalar(dist) : UP.clone(), pa, pb, s, t };
}

export const bottom = (a, b, r) => Math.min(a.y, b.y) - r;

// Godot's shortest-arc Quaternion(v0, v1) (4.7, measured): the same (the dot rounds to 1 in float32) = no turn, opposite = a
// half turn about the perpendicular it picks
function arc(u, v) {
  const n0 = u.clone().normalize(), n1 = v.clone().normalize();
  const d = n0.dot(n1);
  if (Math.abs(d) > 1 - 3e-8) {
    if (d >= 0) return new THREE.Quaternion();
    const ax = n0.clone().cross(Math.abs(n0.x) > Math.abs(n0.y) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    return new THREE.Quaternion(ax.x, ax.y, ax.z, 0);
  }
  const c = n0.clone().cross(n1), s = Math.sqrt((1 + d) * 2);
  return new THREE.Quaternion(c.x / s, c.y / s, c.z / s, s * 0.5);
}

const byPrefix = (id, table, fallback) => {
  let best = "";
  for (const pre in table) if (id.startsWith(pre) && pre.length > best.length) best = pre;
  return best !== "" ? table[best] : fallback;
};

// ---------------------------------------------------------------- RmtWrapBody

// a Collision Wrap on a posed Body: the wrap's capsules where the bones are now, and which of them go into each other
export class WrapBody {
  constructor(wrap, body) {
    this.body = body;
    this.pieces = [];   // [{id, bone, a, b, r, rank}] (a / b / r in the skeleton's space)
    this.pairs = [];    // [[i, j, allow (skeleton space), soft (metres)]]
    this.index = {};
    for (const p of wrap.pieces || []) {
      if (!body.has(String(p.bone))) continue;
      this.index[String(p.id)] = this.pieces.length;
      this.pieces.push({ id: String(p.id), bone: String(p.bone), a: vec(p.a), b: vec(p.b), r: Number(p.r), rank: p.rank === undefined ? 9 : Math.trunc(Number(p.rank)) });
    }
    for (const pr of wrap.pairs || []) {
      const i = this.index[String(pr[0])], j = this.index[String(pr[1])];
      if (i !== undefined && j !== undefined) this.pairs.push([i, j, Number(pr[2]), pr.length > 3 ? Number(pr[3]) : 0]);
    }
    // the skeleton: the node the bones hang from (Godot's Skeleton3D sits there; its world scale is RmtWrapBody.world_scale)
    let root = body.bone(body.names[0]);
    while (root && root.parent && root.parent.isBone) root = root.parent;
    this.skelNode = root && root.parent ? root.parent : body.root;
  }

  // world size of one skeleton-space metre
  worldScale() { return this.skelNode.getWorldScale(new THREE.Vector3()).x; }

  // every piece where it is now, in world space: [[a, b, r], ...] (same order as pieces)
  capsules() {
    const s = this.worldScale();
    return this.pieces.map((p) => {
      const m = this.body.bone(p.bone).matrixWorld;
      return [p.a.clone().applyMatrix4(m), p.b.clone().applyMatrix4(m), p.r * s];
    });
  }

  // pairs going into each other deeper than they do at rest plus tol (world metres): [{i, j, excess, depth, normal, pa, pb}]
  clashes(tol, caps = null) {
    caps ||= this.capsules();
    const s = this.worldScale();
    const mid = caps.map((c) => c[0].clone().add(c[1]).multiplyScalar(0.5));
    const rad = caps.map((c) => c[0].distanceTo(c[1]) * 0.5 + c[2]);
    const out = [];
    for (const [i, j, allow, soft] of this.pairs) {
      const reach = rad[i] + rad[j];
      if (mid[i].distanceToSquared(mid[j]) > reach * reach) continue;
      const a = caps[i], b = caps[j];
      const o = overlap(a[0], a[1], a[2], b[0], b[1], b[2]);
      const excess = o.depth - allow * s - soft;
      if (excess > tol) out.push({ i, j, excess, depth: o.depth, normal: o.normal, pa: o.pa, pb: o.pb });
    }
    return out;
  }

  // pieces below a floor at floorY deeper than tol: [{i, excess}]; skip = piece ids left out (feet stand on it)
  underFloor(floorY, tol, skip = [], caps = null) {
    caps ||= this.capsules();
    const out = [];
    this.pieces.forEach((p, i) => {
      if (skip.includes(p.id)) return;
      const ex = floorY - bottom(caps[i][0], caps[i][1], caps[i][2]);
      if (ex > tol) out.push({ i, excess: ex });
    });
    return out;
  }
}

// ---------------------------------------------------------------- RmtBodySolve

export class BodySolve {
  constructor(wrapBody, chainRules, limits, turnRules = {}, hinges = []) {
    this.wrap = wrapBody;
    this.body = wrapBody.body;
    this.lift = null;        // raised when the body is under the floor (the model root); null = never lift
    this.iterations = 2;     // passes per frame (the correction carries over, so it settles over a few frames)
    this.maxStep = 0.25;     // radians a bone's correction may change per frame
    this.keep = 0.8;         // share of last frame's correction carried into this frame
    this.margin = 0.003;     // metres pushed out past touching
    this.tol = 0;            // self clashes count past this (world metres)
    this.sole = 0.02;        // a foot may sink this far into the floor (metres)
    this.limits = limits;    // bone -> {x: [lo, hi], y, z} in the clip's Euler (radians)
    this.movers = new Set(); // piece indices that may move (empty = every piece)
    this.chain = [];         // piece index -> [bone...], furthest joint first
    this.hinge = new Set();  // bones that bend about their own X only
    this.corr = new Map();   // bone -> Quaternion, local correction on top of the clip pose
    this.locked = new Set();
    this.bones = [];         // every bone that can bend
    this.rest = new Map();   // bone -> rest rotation
    this.maxTurn = new Map();
    this.clip = new Map();   // bone -> the clip's own local rotation this frame
    for (const p of wrapBody.pieces) {
      const n = Math.trunc(Number(byPrefix(p.id, chainRules, 1)));
      const ch = [];
      let b = p.bone;
      // the game walks the skeleton it has. A rig v4 model has no Spine1, clavicles, toes, 4th fingers or tail tip, so the joints this
      // app inserts for it (rigV5Upgrade) are not in the game's solve: walk past them (they still pose normally). A model that has
      // them itself (the game's models since 2026-11-02, marked rig_v5 in the GLB extras) has them in the game's solve too, and so here.
      for (let k = 0; k < n;) {
        if (!b || b === "hips" || b === "root") break;
        const bone = this.body.bone(b);
        if (bone && bone.userData && bone.userData.rigV5Upgrade) { b = this.body.parentName(b); continue; }
        ch.push(b);
        if (!this.rest.has(b)) {
          this.bones.push(b);
          this.rest.set(b, this.body.rest.get(b).q.clone().normalize());
          this.maxTurn.set(b, Number(byPrefix(b, turnRules, 1.2)));
        }
        b = this.body.parentName(b);
        k++;
      }
      ch.reverse();
      this.chain.push(ch);
    }
    for (const name in limits) {
      const ax = Object.keys(limits[name] || {});
      if (this.body.has(name) && (hinges.includes(name) || (!hinges.length && ax.length === 1 && ax[0] === "x"))) this.hinge.add(name);
    }
  }

  // forget the carried corrections (a new clip, a jump)
  reset() { this.corr.clear(); }

  // the carried corrections (to go on from on another body of the same fighter, or later)
  carry() { return new Map([...this.corr].map(([b, q]) => [b, q.clone()])); }
  setCarry(m) { this.corr = new Map([...(m || [])].map(([b, q]) => [b, q.clone()])); }

  // run right after the clip pose (and the feet) are on the body; floorY = NaN when no floor counts this frame (in the air)
  solve(floorY = NaN) {
    const B = this.body;
    const clip = new Map();
    for (const b of this.bones) clip.set(b, B.bone(b).quaternion.clone());
    this.clip = clip;
    for (const [b, c] of this.corr) {
      B.bone(b).quaternion.copy(new THREE.Quaternion().slerp(c, this.keep).multiply(clip.get(b)));
      this._clampLimits(b);
      this._capTurn(b);
    }
    B.update();
    const stats = { contacts: 0, lift: 0, max_corr: 0, max_corr_bone: "" };
    this.locked.clear();
    let caps = null;
    if (!Number.isNaN(floorY)) {
      stats.lift = this._lift(floorY);
      caps = this.wrap.capsules();
      this._lockPlanted(floorY, caps);
    }
    for (let it = 0; it < this.iterations; it++) {
      const contacts = this._contacts(floorY, caps);
      caps = null;
      if (it === 0) stats.contacts = contacts.length;
      if (!contacts.length) break;
      for (const c of contacts) this._push(c[0], c[1], c[2], c[3]);
    }
    // keep what changed as this frame's correction, never more than maxStep away from last frame's
    for (const b of this.bones) {
      const bone = B.bone(b), cb = clip.get(b);
      let corr = bone.quaternion.clone().multiply(cb.clone().invert());
      const prev = this.corr.get(b) || IDQ;
      const step = prev.angleTo(corr);
      if (step > this.maxStep) {
        corr = prev.clone().slerp(corr, this.maxStep / step);
        bone.quaternion.copy(corr).multiply(cb);
      }
      if (corr.angleTo(IDQ) < 0.002) {
        this.corr.delete(b);
        bone.quaternion.copy(cb);
      } else {
        this.corr.set(b, corr);
        const ang = corr.angleTo(IDQ);
        if (ang > stats.max_corr) { stats.max_corr = ang; stats.max_corr_bone = b; }
      }
    }
    B.update();
    return stats;
  }

  // move the model by a world offset, through its local position
  _shift(worldDelta) {
    const p = this.lift.parent;
    const d = worldDelta.clone();
    if (p) d.applyMatrix3(new THREE.Matrix3().setFromMatrix4(p.matrixWorld).invert());
    this.lift.position.add(d);
  }

  // the body itself (hips to head) can't be under the floor: lift the whole model
  _lift(floorY) {
    if (!this.lift) return 0;
    const caps = this.wrap.capsules();
    let deepest = 0;
    this.wrap.pieces.forEach((p, i) => { if (p.rank <= 2) deepest = Math.max(deepest, floorY - bottom(caps[i][0], caps[i][1], caps[i][2])); });
    if (deepest > 0) {
      this._shift(new THREE.Vector3(0, deepest, 0));
      this.body.update();
    }
    return deepest;
  }

  // a foot on the floor keeps its place: the knee and thigh above it may not bend
  _lockPlanted(floorY, caps) {
    this.wrap.pieces.forEach((p, i) => {
      if (!p.id.startsWith("foot")) return;
      if (bottom(caps[i][0], caps[i][1], caps[i][2]) - floorY < 0.05) {
        let b = this.body.parentName(p.bone);
        while (b && b !== "hips" && b !== "root") { this.locked.add(b); b = this.body.parentName(b); }
      }
    });
  }

  _movable(i) {
    if (this.movers.size && !this.movers.has(i)) return false;
    for (const b of this.chain[i]) if (!this.locked.has(b)) return true;
    return false;
  }

  // [piece, point on its axis, push direction, how far]
  _contacts(floorY, caps = null) {
    caps ||= this.wrap.capsules();
    const P = this.wrap.pieces;
    const out = [];
    for (const c of this.wrap.clashes(this.tol, caps)) {
      const ex = c.excess + this.margin;
      const ri = P[c.i].rank, rj = P[c.j].rank;
      const mi = this._movable(c.i), mj = this._movable(c.j);
      if (ri === rj && mi && mj) {
        out.push([c.i, c.pa, c.normal, ex * 0.5]);
        out.push([c.j, c.pb, c.normal.clone().negate(), ex * 0.5]);
      } else if (mi && (ri > rj || !mj)) out.push([c.i, c.pa, c.normal, ex]);
      else if (mj) out.push([c.j, c.pb, c.normal.clone().negate(), ex]);
    }
    if (!Number.isNaN(floorY)) {
      P.forEach((p, i) => {
        const cp = caps[i];
        const low = cp[0].y < cp[1].y ? cp[0] : cp[1];
        const ex = floorY - (low.y - cp[2]) - (p.id.startsWith("foot") ? this.sole : 0);
        if (ex > 0 && this._movable(i)) out.push([i, low, UP, ex + this.margin]);
      });
    }
    return out;
  }

  // move point p of piece i by amount along dir, bending the piece's chain (furthest joint first)
  _push(i, p, dir, amount) {
    const B = this.body;
    const target = p.clone().addScaledVector(dir, amount);
    const cur = p.clone();
    for (const b of this.chain[i]) {
      if (this.locked.has(b)) continue;
      const bone = B.bone(b);
      const j = bone.getWorldPosition(new THREE.Vector3());
      const u = cur.clone().sub(j), v = target.clone().sub(j);
      if (u.length() < 1e-4 || v.length() < 1e-4) continue;
      if (this.hinge.has(b)) {
        const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())).normalize();
        const up = u.clone().addScaledVector(ax, -u.dot(ax)), vp = v.clone().addScaledVector(ax, -v.dot(ax));
        if (up.length() < 1e-4 || vp.length() < 1e-4) continue;
        const ang = clamp(Math.atan2(ax.dot(up.clone().cross(vp)), up.dot(vp)), -0.5, 0.5);
        const ri = this.rest.get(b).clone().invert();
        const eu = eulerOf(ri.clone().multiply(bone.quaternion));
        const lim = this.limits[b].x;
        const cx = eulerOf(ri.clone().multiply(this.clip.get(b) || bone.quaternion))[0];
        const want = clamp(eu[0] + ang, Math.min(lim[0], cx), Math.max(lim[1], cx));
        const turn = want - eu[0];
        if (Math.abs(turn) < 1e-5) continue;
        eu[0] = want;
        bone.quaternion.copy(this.rest.get(b)).multiply(rotQuat(eu));
        cur.sub(j).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(ax, turn)).add(j);
      } else {
        let q = arc(u, v);
        const a = 2 * Math.acos(clamp(q.w, -1, 1));
        if (a < 1e-5) continue;
        if (a > 0.5) q = new THREE.Quaternion().slerp(q, 0.5 / a);
        // the world turn, seen from the bone's parent
        const pw = B.parentWorldQuat(b);
        bone.quaternion.premultiply(pw.clone().invert().multiply(q).multiply(pw));
        cur.sub(j).applyQuaternion(q).add(j);
      }
      this._clampLimits(b);
      this._capTurn(b);
      bone.updateMatrixWorld(true);
      if (cur.distanceTo(target) < 0.002) break;
    }
  }

  // keep a joint inside its natural range; where the clip itself already goes past a limit, the clip's own value is the edge
  _clampLimits(b) {
    const lim = this.limits[b];
    if (!lim || !Object.keys(lim).length) return;
    const bone = this.body.bone(b);
    const ri = this.rest.get(b).clone().invert();
    const e = eulerOf(ri.clone().multiply(bone.quaternion));
    const c = eulerOf(ri.clone().multiply(this.clip.get(b) || bone.quaternion));
    const out = [...e];
    ["x", "y", "z"].forEach((ax, i) => { if (lim[ax]) out[i] = clamp(e[i], Math.min(lim[ax][0], c[i]), Math.max(lim[ax][1], c[i])); });
    if (out.every((x, i) => Math.abs(x - e[i]) <= Math.max(1e-5, 1e-5 * Math.abs(x)))) return;
    const q = this.rest.get(b).clone().multiply(rotQuat(out));
    // near gimbal lock the Euler reading can flip to a mirror twin far from the real turn: never clamp across that
    if (q.angleTo(bone.quaternion) < 0.6) bone.quaternion.copy(q);
  }

  // keep a joint within max_turn of the clip's own rotation
  _capTurn(b) {
    const bone = this.body.bone(b);
    const c = this.clip.get(b) || bone.quaternion.clone();
    const corr = bone.quaternion.clone().multiply(c.clone().invert());
    const a = corr.angleTo(IDQ);
    const m = this.maxTurn.get(b) ?? 1.2;
    if (a > m) bone.quaternion.copy(new THREE.Quaternion().slerp(corr, m / a).multiply(c));
  }
}

// ---------------------------------------------------------------- CBWraps

// what the solve needs for one fighter: {wrap, rules, height_m} (host.wrapData) plus the rig's limits and hinges
// the Body Solve for a fighter on a body, or null when it has no wrap (CBWraps.make_solver)
export function makeSolver(body, key, data, limits, hinges, lift = null) {
  if (!data || !data.wrap || !(data.wrap.pieces || []).length) return null;
  const wb = new WrapBody(data.wrap, body);
  const rules = data.rules || {};
  const over = (rules.fighters || {})[key] || {};
  const chain = { ...(rules.chain || {}), ...(over.chain || {}) };
  const turn = { ...(rules.max_turn || {}), ...(over.max_turn || {}) };
  const s = new BodySolve(wb, chain, limits || {}, turn, hinges || []);
  s.lift = lift;
  return s;
}

// the model's own height at scale 1, as the game measures it (CBFighter / CBWrapPose.mesh_height): the box round every mesh
// in the model's space at rest, skinning left out
export function meshHeight(model) {
  const box = new THREE.Box3();
  model.updateMatrixWorld(true);
  const inv = model.matrixWorld.clone().invert();
  model.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox.clone().applyMatrix4(inv.clone().multiply(o.matrixWorld)));
  });
  return Math.max(box.isEmpty() ? 0 : box.max.y - box.min.y, 0.5);
}

// run fn with the model at its match scale s (scaled about the world origin, the floor stays at y = 0), then back to how it
// was: what fn moved the model by (a lift) comes back scaled to the app's size
export function atMatchScale(model, s, fn) {
  if (!(s > 0) || Math.abs(s - 1) < 1e-9) return fn();
  const sc = model.scale.clone();
  model.scale.multiplyScalar(s);
  model.position.multiplyScalar(s);
  model.updateMatrixWorld(true);
  try { return fn(); } finally {
    model.position.divideScalar(s);
    model.scale.copy(sc);
    model.updateMatrixWorld(true);
  }
}

// a clash test of the pose on the body (the game's CBWrapPose.clashes): {self: [...clashes], floor: [{i, excess}]}; feet may
// sink into the floor 2 cm more (soles)
export function clashesNow(wrapBody, tol, planted) {
  const caps = wrapBody.capsules();
  const feet = wrapBody.pieces.filter((p) => p.id.startsWith("foot")).map((p) => p.id);
  const fl = [];
  if (planted) {
    fl.push(...wrapBody.underFloor(0, tol, feet, caps));
    for (const u of wrapBody.underFloor(0, tol + 0.02, [], caps)) if (feet.includes(wrapBody.pieces[u.i].id)) fl.push(u);
  }
  return { self: wrapBody.clashes(tol, caps), floor: fl, caps };
}
