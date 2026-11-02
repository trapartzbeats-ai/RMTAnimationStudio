// Outside motion onto our rig, a port of the Godot Animator's core/motion_import.gd: a Mixamo animation (FBX, with or without
// skin) or a GLB / glTF with a Mixamo-style skeleton becomes a clip in the game's format, so it plays on every fighter and edits
// like any other clip.
//
// How a bone moves: each of our bones takes its source bone's turn away from the SOURCE's rest pose, in world space, then is made
// local to our parent. Mixamo rests in a T-pose and we rest in an A-pose, so first every bone is lined up: a fixed turn that
// points our rest bone along the source's rest bone (an arm hanging down is swung up level). The hips' move away from rest is
// scaled by the hips height of the two rigs. Fingers come along on the fighters that have those finger bones.
//
// Clean-up, all optional: "in place" takes out the straight-line travel (and keeps its speed in the clip), joints are kept inside
// the rig limits (knees never bend forward), keys that a straight line between their neighbours already gives are dropped, and
// the clip is marked loop / planted when it looks like one.
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FORMAT, eulerOf, keyRot, reduceKeys } from "./clip.js";
import { nearestEuler } from "./evalc.js";
import { clampLimits } from "./rig.js";
import { unmapQuat } from "./fingers.js";

export const SIDE = { L: "Right", R: "Left" };   // our L is Mixamo's Right: both rigs face +Z
export const FPS_OUT = 60;

// our bone -> the source bone (name without the "mixamorig" prefix) whose motion it takes
export function sourceMap() {
  const m = { hips: "Hips", torso: "Spine", chest: "Spine2", neck: "Neck", head: "Head" };
  for (const s in SIDE) {
    const mx = SIDE[s];
    Object.assign(m, { ["leg" + s]: mx + "UpLeg", ["knee" + s]: mx + "Leg", ["foot" + s]: mx + "Foot", ["arm" + s]: mx + "Arm", ["elbow" + s]: mx + "ForeArm",
      ["hand" + s]: mx + "Hand", ["fingers" + s]: mx + "HandMiddle1", ["tips" + s]: mx + "HandMiddle2", ["nail" + s]: mx + "HandMiddle3",
      ["thumb" + s]: mx + "HandThumb1", ["thumb" + s + "2"]: mx + "HandThumb2" });
    for (let j = 0; j < 3; j++) {
      const suf = j === 0 ? "" : String(j + 1);
      m["index" + s + suf] = mx + "HandIndex" + (j + 1);
      m["ring" + s + suf] = mx + "HandRing" + (j + 1);
      m["pinky" + s + suf] = mx + "HandPinky" + (j + 1);
    }
  }
  return m;
}

// the next joint along a source bone (what its direction points at); "" = the bone keeps its parent's line-up
function srcNext(name) {
  for (const mx of ["Left", "Right"]) {
    const t = { [mx + "Arm"]: mx + "ForeArm", [mx + "ForeArm"]: mx + "Hand", [mx + "Hand"]: mx + "HandMiddle1", [mx + "UpLeg"]: mx + "Leg", [mx + "Leg"]: mx + "Foot" };
    if (t[name]) return t[name];
    for (const f of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) for (let j = 0; j < 3; j++) if (name === `${mx}Hand${f}${j + 1}`) return `${mx}Hand${f}${j + 2}`;
  }
  return "";
}

// the next joint along one of our bones (rig v4); "" = it keeps its parent's line-up
function ourNext(name) {
  for (const s of ["L", "R"]) {
    const t = { ["arm" + s]: "elbow" + s, ["elbow" + s]: "hand" + s, ["hand" + s]: "fingers" + s, ["leg" + s]: "knee" + s, ["knee" + s]: "foot" + s,
      ["fingers" + s]: "tips" + s, ["tips" + s]: "nail" + s, ["thumb" + s]: "thumb" + s + "2", ["index" + s]: "index" + s + "2", ["index" + s + "2"]: "index" + s + "3",
      ["ring" + s]: "ring" + s + "2", ["ring" + s + "2"]: "ring" + s + "3", ["pinky" + s]: "pinky" + s + "2", ["pinky" + s + "2"]: "pinky" + s + "3" };
    if (t[name]) return t[name];
  }
  return "";
}

// a source bone's name without its rig prefix ("mixamorig:Hips", "mixamorig1_Hips", three's sanitized "mixamorigHips" -> "Hips")
export function plain(bone) {
  const m = /^mixamorig\d*[:_]?(.+)$/.exec(bone);
  return m ? m[1] : bone;
}

// a clip name from a file name: "Capoeira Spin Kick.fbx" -> "mx_capoeira_spin_kick"
export function suggestName(path) {
  const base = String(path).split(/[\\/]/).pop().replace(/\.[^.]*$/, "").toLowerCase();
  let out = base.replace(/[^a-z0-9]/g, "_");
  while (out.includes("__")) out = out.replace("__", "_");
  return "mx_" + out.trim().replace(/^_+/, "").replace(/_+$/, "");
}

// load an FBX / GLB / glTF (url) : {root, anims: [clips with tracks, most tracks first], path} or {error}
export async function loadSource(url, path) {
  const file = String(path).split(/[\\/]/).pop();
  let root, anims;
  try {
    if (/\.fbx$/i.test(path)) {
      root = await new FBXLoader().loadAsync(url);
      anims = root.animations || [];
    } else {
      const g = await new GLTFLoader().loadAsync(url);
      root = g.scene;
      anims = g.animations || [];
    }
  } catch (e) {
    return { error: `could not read ${file} (${(e && e.message) || e})` };
  }
  let bones = 0;
  root.traverse((o) => { if (o.isBone) bones++; });
  // the animation with the most tracks first (Mixamo files carry an empty "Take 001" next to "mixamo_com")
  anims = anims.filter((a) => a.tracks.length > 0).sort((a, b) => b.tracks.length - a.tracks.length);
  if (!bones || !anims.length) return { error: `${file} has no skeleton animation` };
  return { root, anims, path };
}

const wq = (o) => o.getWorldQuaternion(new THREE.Quaternion());
const wp = (o) => o.getWorldPosition(new THREE.Vector3());

function samePose(a, b, bones, tol) {
  for (const bn of bones) {
    const ea = keyRot(a, bn), eb = keyRot(b, bn);
    if (Math.max(Math.abs(ea[0] - eb[0]), Math.abs(ea[1] - eb[1]), Math.abs(ea[2] - eb[2])) > tol) return false;
  }
  return Math.abs(Number(a.hips_dy || 0) - Number(b.hips_dy || 0)) < 0.05;
}

// the clip, onto `body` (a Body of our fighter): opts {name, anim, in_place (true), limits (true), fingers (true), tolerance
// (0.015), plant ("auto" / true / false), loop ("auto" / true / false)}. Returns {clip, report} or {error}.
export function retarget(source, body, opts = {}) {
  if (source.error) return source;
  const anim = opts.anim ? source.anims.find((a) => a.name === opts.anim) : source.anims[0];
  if (!anim) return { error: `no animation named ${opts.anim}` };
  const src = new Map();
  source.root.traverse((o) => { if (o.isBone && !src.has(plain(o.name))) src.set(plain(o.name), o); });
  // our bone -> its source bone
  const pairs = new Map();
  const map = sourceMap();
  for (const ob in map) if (body.has(ob) && src.has(map[ob])) pairs.set(ob, src.get(map[ob]));
  if (!pairs.has("hips") || pairs.size < 10) return { error: `not a humanoid we know (matched ${pairs.size} bones); Mixamo skeletons work` };
  if (opts.fingers === false) for (const ob of [...pairs.keys()]) if (/^(fingers|tips|nail|thumb|index|ring|pinky)/.test(ob)) pairs.delete(ob);
  // rests (world): the source as loaded, ours posed at rest
  const mixer = new THREE.AnimationMixer(source.root);
  source.root.updateMatrixWorld(true);
  const srcRest = new Map();
  for (const [n, b] of src) srcRest.set(n, { q: wq(b), p: wp(b) });
  body.apply({});
  const names = body.names;
  const ourRest = new Map(names.map((n) => [n, { q: body.worldQuat(n), p: body.worldPos(n) }]));
  // the line-up: for each paired bone, the turn that points our rest bone along the source's rest bone
  const align = new Map();
  for (const n of names) {
    let c = align.get(body.parentName(n)) || new THREE.Quaternion();
    if (pairs.has(n)) {
      const sn = plain(pairs.get(n).name);
      const ns = srcNext(sn), no = ourNext(n);
      if (ns && src.has(ns) && no && body.has(no)) {
        const ds = srcRest.get(ns).p.clone().sub(srcRest.get(sn).p);
        const dO = ourRest.get(no).p.clone().sub(ourRest.get(n).p);
        if (ds.length() > 1e-5 && dO.length() > 1e-5) c = new THREE.Quaternion().setFromUnitVectors(dO.normalize(), ds.normalize());
      }
    }
    align.set(n, c);
  }
  // hips: how far the source moved from its rest, in our size
  const hipsBone = body.bone("hips");
  const scale = ourRest.get("hips").p.y / Math.max(srcRest.get("Hips").p.y, 1e-4);
  const hipsPar = hipsBone.parent;
  // sample every source frame (30 fps) onto our 60 fps clip frames
  const frames30 = Math.max(1, Math.round(anim.duration * 30));
  const action = mixer.clipAction(anim);
  action.setLoop(THREE.LoopOnce, 1);   // the last sample is the last frame, not frame 0 again
  action.clampWhenFinished = true;
  action.play();
  const keys = [], hipsMoves = [], prev = {};
  const topQ = new Map();   // a bone whose parent is not a bone: the parent's world turn
  for (const n of names) if (!body.parentName(n)) topQ.set(n, body.parentWorldQuat(n));
  for (let f30 = 0; f30 <= frames30; f30++) {
    mixer.setTime(Math.min(f30 / 30, anim.duration));
    source.root.updateMatrixWorld(true);
    const g = new Map(), rot = {};
    for (const n of names) {
      const par = body.parentName(n);
      const gp = par ? g.get(par) : topQ.get(n);
      const restLocal = body.rest.get(n).q;
      if (!pairs.has(n)) { g.set(n, gp.clone().multiply(restLocal)); continue; }
      const sb = pairs.get(n);
      const delta = wq(sb).multiply(srcRest.get(plain(sb.name)).q.clone().invert());
      const gq = delta.multiply(align.get(n)).multiply(ourRest.get(n).q);
      g.set(n, gq);
      const local = gp.clone().invert().multiply(gq);
      let e = eulerOf(unmapQuat(body.fmap, n, restLocal.clone().invert().multiply(local)));   // fingers onto the shared hand
      if (prev[n]) e = nearestEuler(e, prev[n]);
      prev[n] = e;
      if (Math.hypot(...e) > 1e-4) rot[n] = e.map((x) => Math.round(x * 10000) / 10000);
    }
    hipsMoves.push(wp(src.get("Hips")).sub(srcRest.get("Hips").p).multiplyScalar(scale));
    keys.push({ f: Math.round((f30 * FPS_OUT) / 30), rot });
  }
  mixer.stopAllAction();
  // in place: take the straight-line travel out of the hips (keep the sway), remember the speed
  const n = hipsMoves.length;
  const travel = new THREE.Vector3();
  if (opts.in_place !== false && n > 1) {
    travel.copy(hipsMoves[n - 1]).sub(hipsMoves[0]).divideScalar((n - 1) / 30);
    travel.y = 0;
  }
  // the hips' move in the hips' parent space (the clip's hips_dx / dy / dz), from where they rest
  const restHipsW = ourRest.get("hips").p;
  const base = hipsPar.worldToLocal(restHipsW.clone());
  for (let k = 0; k < n; k++) {
    const h = hipsMoves[k].clone().sub(travel.clone().multiplyScalar(k / 30));
    const d = hipsPar.worldToLocal(restHipsW.clone().add(h)).sub(base);
    keys[k].hips_dx = Math.round(d.x * 10000) / 10000;
    keys[k].hips_dy = Math.round(d.y * 10000) / 10000;
    keys[k].hips_dz = Math.round(d.z * 10000) / 10000;
  }
  // natural ranges (the rig limits: knees never bend forward)
  let clamped = 0;
  if (opts.limits !== false) {
    for (const k of keys) {
      for (const bn in k.rot) {
        const e = k.rot[bn], cl = clampLimits(bn, e);
        if (cl.some((x, i) => Math.abs(x - e[i]) > 1e-9)) {
          if (Math.hypot(cl[0] - e[0], cl[1] - e[1], cl[2] - e[2]) > 0.01) clamped++;   // the ones you could see; even a hair is clamped
          k.rot[bn] = cl.map((x) => Math.round(x * 10000) / 10000);
        }
      }
    }
  }
  const name = opts.name || suggestName(source.path || anim.name);
  const file = String(source.path || "").split(/[\\/]/).pop();
  const clip = { version: FORMAT, name, fps: FPS_OUT, frames: keys[keys.length - 1].f, loop: false, override: true, plant: false, keys,
    note: `imported from ${file} (${anim.name}) by Fight Studio`,
    import: { source: String(source.path || ""), anim: anim.name, in_place: opts.in_place !== false, travel: [Math.round(travel.x * 1000) / 1000, Math.round(travel.z * 1000) / 1000],
      scale: Math.round(scale * 10000) / 10000 } };
  // loop: first and last pose (nearly) the same
  const loopOpt = opts.loop ?? "auto";
  clip.loop = String(loopOpt) === "auto" ? samePose(keys[0], keys[keys.length - 1], names, 0.12) : !!loopOpt;
  // planted: never leaves the ground (the hips never rise much above their rest height)
  const plantOpt = opts.plant ?? "auto";
  const rise = Math.max(...keys.map((k) => k.hips_dy));
  clip.plant = String(plantOpt) === "auto" ? rise < restHipsW.y * 0.12 : !!plantOpt;
  const sampled = keys.length;
  reduceKeys(clip, names, Number(opts.tolerance ?? 0.015));
  return { clip, report: { name, anim: anim.name, bones: pairs.size, frames: clip.frames, keys: clip.keys.length, sampled, clamped, loop: clip.loop, plant: clip.plant,
    travel_per_s: [travel.x, travel.z] } };
}
