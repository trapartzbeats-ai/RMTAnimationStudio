// What the app knows about rig v4 (shared with the Godot Animator: the same data/animator_rig.json): groups, masks, limbs,
// mirror names, axis hints, joint limits (a knee never bends forward) and controls (one slider, many bones).
import { clamp, FOLLOW } from "./clip.js";
import * as FG from "./fingers.js";

export const GROUPS = [
  ["Body", ["root", "hips", "torso", "spine1", "chest", "neck", "head"]],
  ["Arm L", ["clavicleL", "armL", "elbowL", "handL"]],
  ["Arm R", ["clavicleR", "armR", "elbowR", "handR"]],
  ["Hand L", ["fingersL", "tipsL", "nailL", "middleL4", "thumbL", "thumbL2", "thumbL3", "thumbL4", "indexL", "indexL2", "indexL3", "indexL4", "ringL", "ringL2", "ringL3", "ringL4", "pinkyL", "pinkyL2", "pinkyL3", "pinkyL4"]],
  ["Hand R", ["fingersR", "tipsR", "nailR", "middleR4", "thumbR", "thumbR2", "thumbR3", "thumbR4", "indexR", "indexR2", "indexR3", "indexR4", "ringR", "ringR2", "ringR3", "ringR4", "pinkyR", "pinkyR2", "pinkyR3", "pinkyR4"]],
  ["Leg L", ["legL", "kneeL", "footL", "toeL"]],
  ["Leg R", ["legR", "kneeR", "footR", "toeR"]],
];

export const MASKS = {
  "Full body": [],
  "Upper body": ["torso", "spine1", "chest", "neck", "head", "clavicleL", "armL", "elbowL", "handL", "clavicleR", "armR", "elbowR", "handR", "@Hand L", "@Hand R"],
  "Lower body": ["hips", "legL", "kneeL", "footL", "toeL", "legR", "kneeR", "footR", "toeR"],
  Arms: ["clavicleL", "armL", "elbowL", "handL", "clavicleR", "armR", "elbowR", "handR", "@Hand L", "@Hand R"],
  "Arm L": ["clavicleL", "armL", "elbowL", "handL", "@Hand L"],
  "Arm R": ["clavicleR", "armR", "elbowR", "handR", "@Hand R"],
  Legs: ["legL", "kneeL", "footL", "toeL", "legR", "kneeR", "footR", "toeR"],
  Head: ["neck", "head", "@Ears"],
  Spine: ["torso", "spine1", "chest", "neck"],
  Hands: ["@Hand L", "@Hand R"],
  Tail: ["@Tail"],
};

export const LIMBS = {
  armL: ["armL", "elbowL", "handL"], armR: ["armR", "elbowR", "handR"],
  legL: ["legL", "kneeL", "footL"], legR: ["legR", "kneeR", "footR"],
};

const HINTS = {
  leg: "X - thigh forward, + back   Z leg out to the side   Y turn the leg",
  knee: "X + bends the knee (never negative: a knee does not bend forward)",
  foot: "X + points the toes down",
  toe: "X + curls the toes down",
  arm: "X - raises the arm forward, + swings it back   Z arm out to the side",
  elbow: "X - bends the elbow",
  hand: "X bends the wrist   Z tilts it",
  torso: "X + leans forward   Y twist   Z side lean",
  spine1: "X + leans forward   Y twist   Z side lean",
  chest: "X + leans forward   Y twist   Z side lean",
  clavicle: "X swings the shoulder forward / back   Z lifts it (up / down)",
  neck: "X + nods forward   Y turn",
  head: "X + nods forward   Y turns the head   Z tilts it",
  hips: "whole body turns about the hips: X + forward somersault, Y spin, Z roll. Move = hips dx / dy / dz",
  root: "the feet point; clips leave it at rest",
  tail: "X curls the tail up / down   Z swishes it side to side",
  fingers: "X curls the fingers   Z spreads them",
  tips: "X curls the last finger joint",
  middle: "X curls the middle finger   Z spreads it",
  index: "X curls the index finger   Z spreads it",
  ring: "X curls the ring finger   Z spreads it",
  pinky: "X curls the pinky   Z spreads it",
  thumb: "X curls the thumb   Z swings it away from the hand",
  ear: "X folds the ear forward / back   Z tilts it",
  crest: "X bends the crest forward / back   Z tilts it",
  pom: "X / Z tip the pompom",
  fin: "X / Z tilt the fin",
};

export const DEFAULT_LIMITS = {
  kneeL: { x: [0.0, 2.7] }, kneeR: { x: [0.0, 2.7] },
  elbowL: { x: [-2.75, 0.08] }, elbowR: { x: [-2.75, 0.08] },
};

export const DEFAULT_CONTROLS = [
  { name: "Fist L", min: 0, max: 1, drives: [["fingersL", 0, -1.45], ["tipsL", 0, -1.25], ["thumbL", 0, -0.7], ["thumbL2", 0, -0.5]] },
  { name: "Fist R", min: 0, max: 1, drives: [["fingersR", 0, -1.45], ["tipsR", 0, -1.25], ["thumbR", 0, -0.7], ["thumbR2", 0, -0.5]] },
  { name: "Spine bend", min: -1, max: 1, drives: [["torso", 0, 0.35], ["chest", 0, 0.35], ["neck", 0, 0.15], ["head", 0, 0.15]] },
  { name: "Spine twist", min: -1, max: 1, drives: [["torso", 1, 0.3], ["chest", 1, 0.3], ["neck", 1, 0.2], ["head", 1, 0.2]] },
  { name: "Spine side", min: -1, max: 1, drives: [["torso", 2, 0.25], ["chest", 2, 0.25], ["neck", 2, 0.1]] },
  { name: "Head look", min: -1, max: 1, drives: [["neck", 1, 0.45], ["head", 1, 0.75]] },
  { name: "Head nod", min: -1, max: 1, drives: [["neck", 0, 0.3], ["head", 0, 0.45]] },
  // grounded: the app drops the hips by what the leg fold takes, so a full crouch keeps the feet on the floor
  { name: "Crouch", min: 0, max: 1, grounded: true, measure: [["legL", 0], ["legR", 0], ["kneeL", 0], ["kneeR", 0]],
    drives: [["legL", 0, -1.25], ["legR", 0, -1.25], ["kneeL", 0, 2.2], ["kneeR", 0, 2.2], ["footL", 0, -0.7], ["footR", 0, -0.7],
      ["armL", 0, -0.55], ["armR", 0, -0.55], ["armL", 2, -0.25], ["armR", 2, 0.25], ["elbowL", 0, -0.7], ["elbowR", 0, -0.7],
      ["torso", 0, 0.2], ["chest", 0, 0.16], ["head", 0, -0.15], ["hips", "dy", -0.545]] },
  { name: "Guard up", min: 0, max: 1, drives: [["armL", 0, -0.9], ["armR", 0, -0.9], ["elbowL", 0, -2.0], ["elbowR", 0, -2.0], ["armL", 2, -0.25], ["armR", 2, 0.25]] },
  { name: "Tail curl", min: -1, max: 1, drives: [["tail", 0, 0.35], ["tail2", 0, 0.45], ["tail3", 0, 0.55]] },
  { name: "Tail sway", min: -1, max: 1, drives: [["tail", 2, 0.3], ["tail2", 2, 0.4], ["tail3", 2, 0.5]] },
  { name: "Ears back", min: -1, max: 1, drives: [["earL", 0, 0.6], ["earR", 0, 0.6], ["earL2", 0, 0.3], ["earR2", 0, 0.3]] },
];

export const rigData = { controls: DEFAULT_CONTROLS.map((c) => structuredClone(c)), limits: structuredClone(DEFAULT_LIMITS) };
let rigFile = {};   // the whole file as read: its other fields (hinge, notes) are written back untouched

export async function loadRigData() {
  const d = await window.host.loadData("animator_rig.json");
  if (d && d.controls) {
    rigFile = d;
    rigData.controls = d.controls;
    // a crouch is grounded by the app (the hips drop by the leg fold), including the Crouch already in the file;
    // its slider reads the legs, not the arms or spine
    for (const c of rigData.controls) if (/^crouch$/i.test(c.name)) {
      c.grounded = true;
      if (!Array.isArray(c.measure) || !c.measure.length) c.measure = [["legL", 0], ["legR", 0], ["kneeL", 0], ["kneeR", 0]];
    }
    rigData.limits = d.limits || structuredClone(DEFAULT_LIMITS);
  } else {
    await saveRigData();
  }
}

// joints that bend on one axis only (data/animator_rig.json "hinge"): the IK bends them on X and turns the limb to the pole
export const isHinge = (b) => (rigFile.hinge || ["elbowL", "elbowR", "kneeL", "kneeR"]).includes(b);
// the file's hinge list as the game's Body Solve reads it (CBWraps.make_solver: none = every joint limited on X only)
export const hingeList = () => rigFile.hinge || [];

export function saveRigData() {
  return window.host.saveData("animator_rig.json", { ...rigFile, version: rigFile.version ?? 1, controls: rigData.controls, limits: rigData.limits });
}

export function groupOf(b) {
  for (const [g, list] of GROUPS) if (list.includes(b)) return g;
  if (b.startsWith("tail")) return "Tail";
  if (b.startsWith("ear")) return "Ears";
  return "Extras";
}

export function grouped(bones) {
  const order = GROUPS.map((g) => g[0]).concat(["Tail", "Ears", "Extras"]);
  const by = {};
  for (const b of bones) (by[groupOf(b)] ||= []).push(b);
  return order.filter((g) => by[g]).map((g) => [g, by[g]]);
}

export function maskBones(mask, bones) {
  if (!mask || !mask.length) return [...bones];
  const out = [];
  for (const m of mask) {
    if (String(m).startsWith("@")) {
      for (const b of bones) if (groupOf(b) === m.slice(1) && !out.includes(b)) out.push(b);
    } else if (bones.includes(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

const MIRROR_RE = /^(.*?)([LR])(\d*)$/;
export function mirrorName(b) {
  const m = MIRROR_RE.exec(b);
  return m ? m[1] + (m[2] === "L" ? "R" : "L") + m[3] : b;
}

export function sideOf(b) {
  if (mirrorName(b) === b) return "";
  return MIRROR_RE.exec(b)[2];
}

export const mirrorEuler = (e) => [e[0], -e[1], -e[2]];

export function hint(b) {
  const keys = Object.keys(HINTS).sort((a, c) => c.length - a.length);
  for (const k of keys) if (b.startsWith(k)) return HINTS[k];
  return "X / Y / Z turn the bone about its own axes";
}

// clamp a bone rotation to the rig limits (a finger joint that follows no other also to its natural range; a follower's
// range is on its TOTAL turn: clampFingerTotal)
export function clampLimits(b, e) {
  const lim = rigData.limits[b];
  let out = [...e];
  if (lim) ["x", "y", "z"].forEach((ax, i) => {
    if (lim[ax]) out[i] = clamp(out[i], lim[ax][0], lim[ax][1]);
  });
  if (FG.isFinger(b) && !FOLLOW[b]) out = FG.clampFinger(b, out, rigFile.finger_limits);
  return lim || FG.isFinger(b) ? out : e;
}

// animator_rig.json "finger_limits" (degrees per joint kind: curl / spread / twist)
export const fingerLimits = () => rigFile.finger_limits || {};

// a finger joint's total turn (own + the joint it follows) kept inside finger_limits
export const clampFingerTotal = (b, total) => (FG.isFinger(b) ? FG.clampFinger(b, total, rigFile.finger_limits) : total);

// does a finger joint's TOTAL turn leave its natural range?
export function fingerBreaks(b, total) {
  if (!FG.isFinger(b)) return false;
  const c = FG.clampFinger(b, total, rigFile.finger_limits);
  return Math.hypot(c[0] - total[0], c[1] - total[1], c[2] - total[2]) > 0.01;
}

// a control's drives for the fighter being posed: a fingered hand curls on its own axes (drives_fingered), a plain one on X
export const drives = (ctl) => (FG.fingers.shared && Object.keys(FG.fingers.shared).length && ctl.drives_fingered ? ctl.drives_fingered : ctl.drives || []);

// an edit on top of the clip never turns a joint past its rig limits (knees never bend forward); where the clip itself is
// already past a limit, the clip's own value is the edge (an edit never makes it worse)
export function withinLimits(b, e, before) {
  const lim = rigData.limits[b];
  if (!lim) return e;
  const out = [...e];
  ["x", "y", "z"].forEach((ax, i) => {
    if (lim[ax]) out[i] = clamp(e[i], Math.min(lim[ax][0], before[i]), Math.max(lim[ax][1], before[i]));
  });
  return out;
}

export function breaksLimits(b, e) {
  const c = clampLimits(b, e);
  return Math.hypot(c[0] - e[0], c[1] - e[1], c[2] - e[2]) > 0.01;
}

export function limbOfEnd(b) {
  for (const k in LIMBS) if (LIMBS[k][2] === b) return k;
  return "";
}

function chan(pose, bone, ax) {
  if (typeof ax === "string") return Number(pose["_" + ax] || 0);
  return (pose[bone] || [0, 0, 0])[ax];
}

function setChan(pose, bone, ax, v) {
  if (typeof ax === "string") { pose["_" + ax] = v; return; }
  const e = [...(pose[bone] || [0, 0, 0])];
  e[ax] = v;
  pose[bone] = e;
}

// a grounded control's hips dy is solved from the feet (the hips drop by the leg fold); the drive is only a
// hint for the Godot Animator, which plays the file raw
const groundDrive = (ctl, d) => !!(ctl && ctl.grounded && d[0] === "hips" && d[1] === "dy");

export function controlValue(ctl, pose) {
  const measure = Array.isArray(ctl && ctl.measure) && ctl.measure.length ? ctl.measure : null;
  const measured = (d) => !measure || measure.some((m) => m[0] === d[0] && m[1] === d[1]);
  let num = 0, den = 0;
  for (const d of drives(ctl)) {
    if (groundDrive(ctl, d) || !measured(d)) continue;
    const amt = Number(d[2]);
    num += amt * chan(pose, d[0], d[1]);
    den += amt * amt;
  }
  return den > 0 ? num / den : 0;
}

export function setControl(ctl, pose, value) {
  const out = { ...pose };
  const cur = controlValue(ctl, pose);
  for (const d of drives(ctl)) {
    if (groundDrive(ctl, d)) continue;
    setChan(out, d[0], d[1], chan(out, d[0], d[1]) + (value - cur) * Number(d[2]));
  }
  return out;
}
