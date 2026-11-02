// Held objects sit in the hand the same way in the game and in Fight Studio (a port of the game's grip.gd, CBGrip): a frame
// built from the hand's own bones every frame (never a bone-attachment offset, which differs per model). Three kinds:
//   cylinder - can, bottle, bat / sword handle: inside the finger curl, the axis (Y) along the knuckle line pinky -> index
//   sphere   - ball, bomb, orb: cupped in front of the palm
//   block    - box, phone, card: flat on the palm, its long side (Y) along the fingers
// size = the object's extents in metres (cylinder x = diameter, y = length; sphere x = diameter; block x, y, z). Frame axes:
// Y = the object's axis, Z = out of the palm. Pair each kind with its hand pose: data/poses/grip_<kind>_<side>.json.
import * as THREE from "three";
import { fingers, partsOfLocal } from "./fingers.js";
import { fingerLimits } from "./rig.js";

export const KINDS = ["cylinder", "sphere", "block"];
export const PROXY_SIZES = { block: [0.08, 0.15, 0.02], cylinder: [0.084, 0.16, 0.084], sphere: [0.22, 0.22, 0.22] };

const at = (body, n) => (body.has(n) ? body.worldPos(n) : null);

// the hand's own frame: wrist -> knuckles (along), pinky -> index (across), and which way the palm faces (palm)
export function handAxes(body, side) {
  const hand = at(body, "hand" + side), fing = at(body, "fingers" + side), tips = at(body, "tips" + side);
  const idx = at(body, "index" + side), pin = at(body, "pinky" + side);
  if (!hand || !fing) return null;
  const along = fing.clone().sub(hand);
  const reach = along.length();
  along.normalize();
  let across = idx && pin ? idx.clone().sub(pin) : new THREE.Vector3();
  across.sub(along.clone().multiplyScalar(across.dot(along)));
  if (across.length() < 0.002) across = along.clone().cross(new THREE.Vector3(0, 1, 0));
  across.normalize();
  // the palm, from the hand's handedness: fingers forward + thumb side up -> a right palm faces the body's midline
  const palm = along.clone().cross(across).multiplyScalar(side === "R" ? 1 : -1).normalize();
  return { hand, fing, tips: tips || fing.clone().add(along.clone().multiplyScalar(reach * 0.6)), along, across, palm, reach };
}

// where a held object sits (a world Matrix4) for the current pose
export function frame(body, side, kind, size) {
  const a = handAxes(body, side);
  if (!a) return new THREE.Matrix4();
  let y = a.along.clone();
  let center;
  // the bones run through the middle of the hand: everything sits out past the palm skin (about a fifth of the wrist ->
  // knuckle length), or a block vanishes into the palm
  const pd = a.reach * 0.2;
  if (kind === "cylinder") {   // in the tunnel the curled fingers make, under the knuckles
    y = a.across.clone();
    center = a.fing.clone().add(a.palm.clone().multiplyScalar(size[0] * 0.5 + pd * 0.6)).sub(a.along.clone().multiplyScalar(a.reach * 0.12));
  } else if (kind === "sphere") {   // cupped: in front of the palm, between the wrist and the knuckles
    center = a.hand.clone().lerp(a.fing, 0.55).add(a.palm.clone().multiplyScalar(size[0] * 0.5 + pd * 0.5));
  } else {   // flat on the palm, the long side along the fingers
    center = a.hand.clone().lerp(a.fing, 0.55).add(a.palm.clone().multiplyScalar(size[2] * 0.5 + pd));
  }
  let z = a.palm.clone().sub(y.clone().multiplyScalar(a.palm.dot(y)));
  if (z.length() < 0.001) z = y.clone().cross(new THREE.Vector3(1, 0, 0));
  z.normalize();
  const x = y.clone().cross(z).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(center);
}

// a grey proxy of a kind and size (for placement work)
export function proxyGeometry(kind, size) {
  if (kind === "cylinder") return new THREE.CylinderGeometry(size[0] * 0.5, size[0] * 0.5, size[1], 20);
  if (kind === "sphere") return new THREE.SphereGeometry(size[0] * 0.5, 24, 16);
  return new THREE.BoxGeometry(size[0], size[1], size[2]);
}

// ---------------------------------------------------------------- the hand wraps what it holds (grip.gd wrap_hand)

// the finger chains, knuckle out (%s = side); a chain the rig lacks (no ring on three-finger hands) is skipped
const WRAP_CHAINS = [["index%s", "index%s2", "index%s3"], ["fingers%s", "tips%s", "nail%s"], ["ring%s", "ring%s2", "ring%s3"],
  ["pinky%s", "pinky%s2", "pinky%s3"], ["thumb%s", "thumb%s2"]];
const WRAP_STEP = 0.087;   // the search step (5 degrees), then halved down to about a third of a degree
const WRAP_GAP = 0.002;    // metres of air left between skin and object
const vec = (a) => new THREE.Vector3(Number(a[0]), Number(a[1]), Number(a[2]));

// signed distance from a point (in the object's frame) to the object's surface
function sdf(kind, size, p) {
  if (kind === "cylinder") {
    const dx = Math.hypot(p.x, p.z) - size[0] * 0.5, dy = Math.abs(p.y) - size[1] * 0.5;
    return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  }
  if (kind === "sphere") return p.length() - size[0] * 0.5;
  const q = [Math.abs(p.x) - size[0] * 0.5, Math.abs(p.y) - size[1] * 0.5, Math.abs(p.z) - size[2] * 0.5];
  return Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0);
}

// THE HAND WRAPS THE OBJECT (2026-10-30, the user: "put collision wrap on the prop objects so the hand wraps around
// naturally"). The held object is its collision shape (kind + size, as frame()); each finger joint is a capsule as thick as
// the model's own finger skin (finger_frames.json "thickness"). Knuckle out, each joint turns about its curl axis until the
// finger's skin meets the object: closing when it hangs off, opening when it sinks in, never past finger_limits. The thumb
// swings straight toward the object's middle instead (it meets it from the other side), inside all three of its ranges.
// Starts from the pose on the body (the clip's hand). prop = the object's world Matrix4. Returns how many joints turned.
export function wrapHand(body, side, kind, size, prop) {
  const fmap = body.fmap;
  if (!fmap || !fmap.size) return 0;
  const thick = (fingers.data.thickness || {})[fingers.key] || {};
  const shared = fingers.data.shared || {};
  const lims = fingerLimits();
  const inv = prop.clone().invert();
  const center = new THREE.Vector3().setFromMatrixPosition(prop);
  let turned = 0;
  for (const ch of WRAP_CHAINS) {
    const names = ch.map((x) => x.replace("%s", side));
    if (!names.every((n) => body.has(n)) || !shared[names[0]]) continue;
    const n = names.length;
    const bones = names.map((x) => body.bone(x));
    const rests = names.map((x) => body.rest.get(x).q);
    const quats = bones.map((b) => b.quaternion.clone());
    const axes = names.map((x) => { const v = vec(shared[x].c); const m = fmap.get(x); if (m) v.applyQuaternion(m.q); return v.normalize(); });
    const parent = bones[0].parent;
    const sc = parent.matrixWorld.getMaxScaleOnAxis();
    const radii = names.map((x) => Number((thick[x] || {}).r ?? 0.012) * sc);
    const lastRest = body.rest.get(names[n - 1]).p;
    const tip = lastRest.clone().normalize().multiplyScalar(Number((thick[names[n - 1]] || {}).len ?? lastRest.length() * 0.8));
    const local = (j, q) => new THREE.Matrix4().compose(bones[j].position, q, bones[j].scale);
    const turnedQ = (j, ax, a) => rests[j].clone().multiply(new THREE.Quaternion().setFromAxisAngle(ax, a)).multiply(rests[j].clone().invert()).multiply(quats[j]);
    let base = parent.matrixWorld.clone();
    for (let k = 0; k < n; k++) {
      const kind_ = shared[names[k]].kind;
      const cur = partsOfLocal(fmap, names[k], rests[k], quats[k])[0];
      const lim = ((lims[kind_] || {}).curl || [-20, 100]).map((d) => (d * Math.PI) / 180);
      let lo = lim[0] - cur, hi = lim[1] - cur;
      let ax = axes[k];
      if (k === 0 && names[0].startsWith("thumb")) {
        // the thumb swings over to meet the object from the other side, as far as all three of its ranges allow
        const joint = bones[0].position.clone().applyMatrix4(base);
        let g = base.clone();
        for (let j = 0; j < n; j++) g = g.multiply(local(j, quats[j]));
        const reach = tip.clone().applyMatrix4(g).sub(joint);
        const to = center.clone().sub(joint);
        const w = reach.clone().cross(to);
        if (w.length() > 1e-6) {
          const bq = new THREE.Quaternion();
          base.decompose(new THREE.Vector3(), bq, new THREE.Vector3());
          ax = w.applyQuaternion(bq.invert()).normalize();
          const r = lims[kind_] || {};
          const ok = (a) => {
            const p = partsOfLocal(fmap, names[0], rests[0], turnedQ(0, ax, a));
            return ["curl", "spread", "twist"].every((nm, i) => { const rg = r[nm] || [-180, 180]; const d = (p[i] * 180) / Math.PI; return d >= rg[0] && d <= rg[1]; });
          };
          lo = -0.35;
          hi = 0;
          while (hi < 1.4 && ok(hi + WRAP_STEP)) hi += WRAP_STEP;
        }
      }
      const touch = (a) => {
        let g = base.clone();
        for (let j = k; j < n; j++) {
          g = g.multiply(local(j, j === k ? turnedQ(j, ax, a) : quats[j]));
          const o = new THREE.Vector3().setFromMatrixPosition(g);
          const end = (j + 1 < n ? body.rest.get(names[j + 1]).p : tip).clone().applyMatrix4(g);
          for (const t of j === k ? [0.34, 0.67, 1] : [0, 0.34, 0.67, 1]) {   // the pivot itself never moves
            if (sdf(kind, size, o.clone().lerp(end, t).applyMatrix4(inv)) < radii[j] + WRAP_GAP) return true;
          }
        }
        return false;
      };
      const bisect = (clear, hit) => {
        for (let i = 0; i < 4; i++) { const m = (clear + hit) / 2; if (touch(m)) hit = m; else clear = m; }
        return clear;
      };
      let a = 0;
      if (touch(0)) {   // sunk in: open until clear
        let b = 0;
        while (b > lo && touch(b)) b = Math.max(b - WRAP_STEP, lo);
        a = touch(b) ? b : bisect(b, Math.min(b + WRAP_STEP, 0));
      } else {          // hanging off: close until it touches
        let b = 0;
        while (b < hi && !touch(b)) b = Math.min(b + WRAP_STEP, hi);
        a = touch(b) ? bisect(Math.max(b - WRAP_STEP, 0), b) : b;
      }
      if (Math.abs(a) > 0.001) {
        quats[k] = turnedQ(k, ax, a);
        bones[k].quaternion.copy(quats[k]);
        turned++;
      }
      base = base.multiply(local(k, quats[k]));
    }
  }
  if (turned) body.update();
  return turned;
}
