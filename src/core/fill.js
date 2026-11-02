// Fill: the frames between two keys, made for you. A port of the Godot Animator's core/fill.gd (FILL_PLAN.md there).
// Two engines make the in-between poses:
//   shape    rules, per Euler channel (the same channels the game lerps): a Hermite curve whose end speeds come from the
//            timing and, with Flow, from the speed the motion really has coming into A and leaving B; Overlap makes each joint
//            trail its parent and catch up by B; Anticipate winds back first; Overshoot goes past B and settles onto it
//   library  the stretch of one of our clips (mirrored too) whose first pose is nearest A and last pose nearest B, played at the
//            span's length and bent onto A and B (motion warping: the offsets at the two ends fade across)
// then every joint inside its natural limits, planted feet held where they stand (hinge leg IK) or stepped on an arc, an
// optional jump arc for the hips. The result is plain keys tagged "breakdown" with fill: id, so the game plays it as it is.
// No UI and no app state here: App.fill* call it and keep the undo.
import * as THREE from "three";
import { poseAt, rotQuat, sortedKeys, clamp } from "./clip.js";
import * as R from "./rig.js";
import * as FG from "./fingers.js";
import * as E from "./evalc.js";
import * as F from "./feet.js";
import { newId } from "./doc.js";

export const ENGINES = ["shape", "library"];
// the rule timings, then the ones LEARNED from real motion (data/motion_dna.json "styles", measured on the Motion Library's motion
// capture by MotionLibrary/study/study.py): their end speeds, how much later each body part is halfway through the move than the
// hips ("lag"), and for arrive a built-in overshoot + settle. The knobs still add their rule amounts on top.
export const TIMINGS = ["smooth", "even", "strike", "settle", "natural", "punch", "kick", "swing", "hit", "arrive", "land", "turn"];
export const LEARNED = ["natural", "punch", "kick", "swing", "hit", "arrive", "land", "turn"];
export const TIMING_NAMES = { smooth: "smooth (eases in and out)", even: "even", strike: "strike (slow start, hits B fast)",
  settle: "settle (fast start, eases into B)", natural: "natural (learned: real moves)", punch: "punch (learned: the hips lead)",
  kick: "kick (learned)", swing: "swing kick (learned: the speed carries into the hit)", hit: "hit reaction (learned: snaps, the body trails)", arrive: "arrive + settle (learned: goes past, settles)",
  land: "land (learned: sinks into the knees, comes back up)", turn: "turn (learned: the head leads the hips round)" };
const SIDED = ["arm", "elbow", "hand", "leg", "knee", "foot"];
// Fill's library also searches REAL MOTION: the Motion Library's clips, named "real/<clip>" (main.js reads them with ours)
export const REAL_PREFIX = "real/";
export const DEFAULTS = { engine: "shape", timing: "smooth", flow: 0.6, overlap: 0.3, anticipate: 0, overshoot: 0, feet: true, air: 0, step: 0, pick: 0 };
// the end speeds of each timing, in "the whole change over the span" (Hermite slopes; at most 3 keeps the curve from going back)
const SLOPES = { smooth: [0, 0], even: [1, 1], strike: [0, 2.6], settle: [2.6, 0] };
// how far down the chain from the hips a joint sits: Overlap delays it by that much (legs do not trail: the feet hold the floor)
const DEPTH = { torso: 1, chest: 2, neck: 3, head: 4, armL: 3, armR: 3, elbowL: 4, elbowR: 4, handL: 5, handR: 5, tail: 1, tail2: 2,
  tail3: 3, earL: 5, earR: 5, crest: 5, crest2: 6 };
const OVERLAP_PER_DEPTH = 0.15;
const ANTICIPATE_TIME = 0.25, ANTICIPATE_SIZE = 0.12;
const OVERSHOOT_TIME = 0.2, OVERSHOOT_SIZE = 0.12;
// the bones (and weights) two poses are compared on in the library search
export const MATCH = { hips: 2, torso: 2, chest: 1.5, neck: 0.5, head: 0.7, armL: 1.2, armR: 1.2, elbowL: 0.8, elbowR: 0.8, handL: 0.3,
  handR: 0.3, legL: 1.5, legR: 1.5, kneeL: 1, kneeR: 1, footL: 0.4, footR: 0.4 };
const MB = Object.keys(MATCH);
const MATCH_DY = 3.0, MATCH_RATE = 30.0, STRETCH_COST = 0.25;
const FEET_SAME = 0.03, STEP_LIFT = [0.03, 0.12];
const SPIN = 1.0;        // the hips turning more than this (radians, as keyed) from A to B: held feet pivot with the body
const AXES = ["_dx", "_dy", "_dz"];
const V0 = [0, 0, 0];

// ================================================================ learned from real motion

let dnaData = {};
// data/motion_dna.json, given by the app at boot ({} when it is missing)
export function setDna(d) { dnaData = d && typeof d === "object" ? d : {}; }
export const dna = () => dnaData;

// a learned timing's numbers ({} for the rule timings, or when the data is missing)
export const learned = (timing) => (LEARNED.includes(timing) ? ((dnaData.styles || {})[timing] || {}) : {});

// a learned dip (land): 0 at A, 1 at `at`, 0 at B; "fast" leaves A at speed (the body is already falling), "ease" comes back
// up gently
export function dipCurve(u, d) {
  const at = clamp(Number(d.at ?? 0.35), 0.05, 0.95);
  if (u <= 0 || u >= 1) return 0;
  if (u < at) return (d.in ?? "fast") === "fast" ? Math.sin(Math.PI * 0.5 * u / at) : 0.5 * (1 - Math.cos(Math.PI * u / at));
  const v = (u - at) / (1 - at);
  return (d.out ?? "ease") === "ease" ? 0.5 * (1 + Math.cos(Math.PI * v)) : Math.cos(Math.PI * 0.5 * v);
}

// the body part a bone belongs to for a learned lag: armL -> arm, fingers ride on the hand
export function partOf(bn) {
  if (FG.isFinger(bn)) return "hand";
  if (bn.endsWith("L") || bn.endsWith("R")) {
    const base = bn.slice(0, -1);
    if (SIDED.includes(base)) return base;
  }
  return bn;
}

// ================================================================ span + options

export function settings(opts) {
  const s = { ...DEFAULTS };
  for (const k in opts) if (k in s) s[k] = opts[k];
  s.engine = ENGINES.includes(String(s.engine)) ? String(s.engine) : "shape";
  s.timing = TIMINGS.includes(String(s.timing)) ? String(s.timing) : "smooth";
  for (const k of ["flow", "overlap", "anticipate", "overshoot"]) s[k] = clamp(Number(s[k]) || 0, 0, 1);
  s.feet = !!s.feet;
  s.air = clamp(Number(s.air) || 0, 0, 200);
  s.step = clamp(Math.trunc(Number(s.step) || 0), 0, 12);
  s.pick = Math.max(0, Math.trunc(Number(s.pick) || 0));
  return s;
}

// frames between keys: every 2 at 60 fps, every frame at 30
export const stepOf = (doc, s) => (s.step > 0 ? s.step : Math.max(1, Math.round(doc.fps / 30)));

// the span around frame f: inside a fill, that fill's span (its own breakdown keys do not split it); else the keys before and
// after f (a key on f counts as the start); [] when there is none
export function spanAround(doc, f) {
  const fl = doc.fills.find((x) => f >= x.a - 0.001 && f < x.b - 0.001);
  if (fl) return [fl.a, fl.b];
  const a = doc.prevKey(f + 0.001), b = doc.nextKey(f + 0.001);
  return a < 0 || b < 0 ? [] : [a, b];
}

export const find = (doc, id) => doc.fills.find((fl) => fl.id === id) || null;
export const atSpan = (doc, a, b) => doc.fills.find((fl) => fl.a === a && fl.b === b) || null;

// ================================================================ poses

function poseOf(doc, f, bones) {
  if (doc.loop) f = ((f % doc.frames) + doc.frames) % doc.frames;
  return doc.basePose(clamp(f, 0, doc.frames), bones);
}

// speed per frame coming into frame a (from a - 1) or going out of b (to b + 1); null at a clip end that does not loop
function speed(doc, f, dir, bones, pose) {
  const g = f + dir;
  if (!doc.loop && (g < 0 || g > doc.frames)) return null;
  const other = poseOf(doc, g, bones);
  const out = {};
  for (const b of bones) {
    const e = pose[b] || V0, o = other[b] || V0;
    out[b] = [0, 1, 2].map((i) => (e[i] - o[i]) * -dir);
  }
  for (const ax of AXES) out[ax] = ((pose[ax] || 0) - (other[ax] || 0)) * -dir;
  return out;
}

function hermite(p0, p1, m0, m1, t) {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
}

function bump(u, p, q) {
  if (u <= p || u >= q || q <= p) return 0;
  const s = Math.sin(Math.PI * (u - p) / (q - p));
  return s * s;
}

const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
const cap = (m, delta, floorV) => { const lim = Math.max(3 * Math.abs(delta), floorV); return clamp(m, -lim, lim); };

// ================================================================ engine 1: shape

// poses for frames a < f < b (every `step`): {f: pose}
export function shape(doc, bones, a, b, s, frames) {
  const pa = poseOf(doc, a, bones), pb = poseOf(doc, b, bones);
  const span = b - a;
  const va = s.flow > 0 ? speed(doc, a, -1, bones, pa) : null;
  const vb = s.flow > 0 ? speed(doc, b, 1, bones, pb) : null;
  const sty = learned(s.timing);
  const sl = sty.slopes || SLOPES[s.timing] || SLOPES.smooth;
  const lags = sty.lag || {};
  const sov = sty.overshoot || {};
  const dip = sty.dip || null;
  const lead = sty.lead || {};
  // turn: how far the hips turn from A to B as keyed (their own yaw), the way real turns go
  const dturn = Object.keys(lead).length ? ((pb.hips || V0)[1] - (pa.hips || V0)[1]) * Number(sty.lead_sign ?? 1) : 0;
  const t0 = ANTICIPATE_TIME * s.anticipate;
  const t1 = 1 - Math.min(0.5, OVERSHOOT_TIME * s.overshoot + Number(sov.time || 0));   // a learned overshoot is built in, the knob adds
  const ovSize = OVERSHOOT_SIZE * s.overshoot + Number(sov.size || 0);
  const out = {};
  for (const f of frames) {
    const u = (f - a) / span;
    const um = clamp((u - t0) / Math.max(t1 - t0, 0.05), 0, 1);
    const pose = {};
    for (const bn of bones) {
      const ea = pa[bn] || V0;
      const eb = pb[bn] || V0;   // as keyed: the game lerps the raw values, so a turn keyed past 180 degrees (a spin) stays one
      const d = FG.isFinger(bn) ? 6 : (DEPTH[bn] || 0);
      // a learned lag is how much later the part is halfway than the hips (fraction of the move); the sin warp below shifts
      // "halfway" by lag / PI, so the warp gets PI x that
      const lag = Math.min(0.9, s.overlap * OVERLAP_PER_DEPTH * d + Math.PI * Number(lags[partOf(bn)] || 0));
      const ub = um - lag / Math.PI * Math.sin(Math.PI * um);
      const e = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const dl = eb[i] - ea[i];
        let m0 = va ? sl[0] * dl + ((va[bn] || V0)[i] * span - sl[0] * dl) * s.flow : sl[0] * dl;
        let m1 = vb ? sl[1] * dl + ((vb[bn] || V0)[i] * span - sl[1] * dl) * s.flow : sl[1] * dl;
        m0 = cap(m0, dl, 0.35);
        m1 = cap(m1, dl, 0.35);
        e[i] = hermite(ea[i], eb[i], m0, m1, ub);
        e[i] += -ANTICIPATE_SIZE * s.anticipate * dl * bump(u, 0, t0 + 0.2);
        e[i] += ovSize * (1 + 0.15 * d) * dl * bump(u, t1 - 0.15, 1);
      }
      pose[bn] = e;
    }
    for (const ax of AXES) {
      const xa = pa[ax] || 0, xb = pb[ax] || 0, dl = xb - xa;
      const m0 = va ? sl[0] * dl + (va[ax] * span - sl[0] * dl) * s.flow : sl[0] * dl;
      const m1 = vb ? sl[1] * dl + (vb[ax] * span - sl[1] * dl) * s.flow : sl[1] * dl;
      pose[ax] = hermite(xa, xb, cap(m0, dl, 0.1), cap(m1, dl, 0.1), um);
    }
    if (Math.abs(dturn) > 0.15) {
      // turn: the head, neck, chest and torso turn ahead of the hips on the way (a part of the hips' turn, peaking at `at`) and
      // are back as keyed by B
      for (const part of Object.keys(lead)) {
        if (!bones.includes(part)) continue;
        const e = pose[part] || V0;
        pose[part] = [e[0], e[1] + Number(lead[part].part) * dturn * dipCurve(u, { at: lead[part].at, in: "ease", out: "ease" }), e[2]];
      }
    }
    if (dip) {
      // land: the hips sink and come back up, the torso and chest fold forward with them. A landing stopped in less time
      // sinks less (depth = fall speed x time / 2): the real depth scaled by this span over the real one's length
      const k = dipCurve(u, dip) * Math.min(1, span / doc.fps / Math.max(Number(dip.secs ?? 0.57), 0.05));
      pose._dy -= Number(dip.depth || 0) * k;
      for (const part of ["torso", "chest"]) {
        if (!bones.includes(part)) continue;
        const e = pose[part] || V0;
        pose[part] = [e[0] + Number(dip[part] || 0) * k, e[1], e[2]];
      }
    }
    out[f] = pose;
  }
  return out;
}

// ================================================================ engine 2: library

let index = [];          // [{name, fps, frames, loop, n, q: Float32Array (n x bones x 4), dy: Float32Array}]
let indexSig = "";
let libClips = {};       // name -> clip, as the index read them

const _q = new THREE.Quaternion();
function put(q, at, pose) {
  for (let j = 0; j < MB.length; j++) {
    rotQuat(pose[MB[j]] || V0, _q);
    q[at + j * 4] = _q.x; q[at + j * 4 + 1] = _q.y; q[at + j * 4 + 2] = _q.z; q[at + j * 4 + 3] = _q.w;
  }
}

// every clip as poses 30 times a second (built once, again when a clip file changes). `load(sig)` gives
// {sig, clips?: {name: clip}} (clips left out when the sig is still the same)
export async function libraryIndex(load, force = false) {
  const r = await load(force ? "" : indexSig);
  if (!r || (r.sig === indexSig && !r.clips && index.length)) return index;
  index = [];
  libClips = r.clips || {};
  for (const n of Object.keys(libClips).sort()) {
    const c = libClips[n];
    if (!c || !(c.keys || []).length) continue;
    const fps = Math.max(1, Number(c.fps) || 30);
    const frames = Math.max(1, Math.trunc(Number(c.frames) || 24));
    const cnt = Math.floor(frames / fps * MATCH_RATE) + 1;
    const q = new Float32Array(cnt * MB.length * 4);
    const dy = new Float32Array(cnt);
    const src = { keys: sortedKeys(c), loop: !!c.loop, ease: c.ease || "linear" };
    for (let i = 0; i < cnt; i++) {
      const p = poseAt(src, Math.min(frames, i / MATCH_RATE * fps), MB);
      put(q, i * MB.length * 4, p);
      dy[i] = p._dy || 0;
    }
    index.push({ name: n, fps, frames, loop: !!c.loop, n: cnt, q, dy });
  }
  indexSig = r.sig;
  return index;
}

export const indexSize = () => index.length;
export const realCount = () => index.filter((e) => e.name.startsWith(REAL_PREFIX)).length;

function feature(pose) {
  const q = new Float32Array(MB.length * 4);
  put(q, 0, pose);
  return { q, dy: pose._dy || 0 };
}

const W = Float32Array.from(MB.map((k) => MATCH[k]));
const WSUM = MB.reduce((s, k) => s + MATCH[k], 0);
function dist(fq, fdy, q, at, dy) {
  let acc = 0;
  for (let j = 0; j < W.length; j++) {
    const k = at + j * 4;
    const d = Math.abs(fq[j * 4] * q[k] + fq[j * 4 + 1] * q[k + 1] + fq[j * 4 + 2] * q[k + 2] + fq[j * 4 + 3] * q[k + 3]);
    const ang = 2 * Math.acos(Math.min(1, d));
    acc += W[j] * ang * ang;
  }
  return Math.sqrt(acc / WSUM) + MATCH_DY * Math.abs(fdy - dy);
}

export function mirrorPose(pose, bones) {
  const out = { ...pose };
  for (const b of bones) out[R.mirrorName(b)] = R.mirrorEuler(pose[b] || V0);
  out._dx = -(pose._dx || 0);
  return out;
}

const round2 = (x) => Math.round(x * 100) / 100;

// the library stretches that best join pose A to pose B (call libraryIndex first): [{clip, from, to (clip frames), mirror, cost,
// score (0..100), frames (how long it took there, in this clip's frames)}], best first, one per clip and side
export function matches(doc, bones, a, b, n = 5) {
  const pa = poseOf(doc, a, bones), pb = poseOf(doc, b, bones);
  const secs = (b - a) / doc.fps;
  const lo = Math.max(1, Math.ceil(secs * 0.5 * MATCH_RATE));
  const hi = Math.max(lo, Math.floor(secs * 2 * MATCH_RATE));
  const found = [];
  for (const side of [false, true]) {
    const fa = feature(side ? mirrorPose(pa, bones) : pa);
    const fb = feature(side ? mirrorPose(pb, bones) : pb);
    for (const e of index) {
      if (e.name === doc.name) continue;
      const cnt = e.n, loop = e.loop && cnt > 2;
      const da = new Float32Array(cnt), db = new Float32Array(cnt);
      let dbmin = Infinity;
      for (let i = 0; i < cnt; i++) {
        da[i] = dist(fa.q, fa.dy, e.q, i * MB.length * 4, e.dy[i]);
        db[i] = dist(fb.q, fb.dy, e.q, i * MB.length * 4, e.dy[i]);
        dbmin = Math.min(dbmin, db[i]);
      }
      let best = { cost: Infinity };
      for (let i = 0; i < cnt; i++) {
        if (da[i] + dbmin >= best.cost) continue;
        for (let len = lo; len <= hi; len++) {
          let j = i + len;
          if (j >= cnt) {
            if (!loop) break;
            j = j % (cnt - 1);
            if (len > cnt - 1) break;
          }
          const c = da[i] + db[j] + STRETCH_COST * Math.abs(Math.log(len / (secs * MATCH_RATE)));
          if (c < best.cost) best = { cost: c, i, len };
        }
      }
      if (best.i !== undefined) {
        const f0 = best.i / MATCH_RATE * e.fps, f1 = f0 + best.len / MATCH_RATE * e.fps;
        found.push({ clip: e.name, from: round2(f0), to: round2(f1), mirror: side, cost: Math.round(best.cost * 10000) / 10000,
          score: Math.round(100 * Math.exp(-2.5 * best.cost)), frames: Math.round(best.len / MATCH_RATE * doc.fps) });
      }
    }
  }
  found.sort((x, y) => x.cost - y.cost);
  return found.slice(0, n);
}

// poses for the frames from a library stretch, bent so it starts on A and ends on B
export function library(doc, bones, a, b, m, frames) {
  const pa = poseOf(doc, a, bones), pb = poseOf(doc, b, bones);
  const c = libClips[m.clip] || E.clipSrc(m.clip) || { keys: [] };
  const src = { keys: sortedKeys(c), loop: !!c.loop, ease: c.ease || "linear" };
  const cf = Number(c.frames) || 24;
  const at = (u) => {
    let sf = m.from + (m.to - m.from) * u;
    if (c.loop) sf = ((sf % cf) + cf) % cf;
    const p = poseAt(src, clamp(sf, 0, cf), bones);
    return m.mirror ? mirrorPose(p, bones) : p;
  };
  // the stretch's Euler values carried along from A's (no flips mid-way), then its ends measured against A and B
  const m0 = at(0);
  const cont = {}, offA = {};
  for (const bn of bones) {
    cont[bn] = E.nearestEuler(m0[bn] || V0, pa[bn] || V0);
    offA[bn] = (pa[bn] || V0).map((v, i) => v - cont[bn][i]);
  }
  const us = [1, ...frames.map((f) => (f - a) / (b - a))].sort((x, y) => x - y);
  const seq = new Map();
  let prev = cont;
  for (const u of us) {
    const p = at(u);
    const q = {};
    for (const bn of bones) q[bn] = E.nearestEuler(p[bn] || V0, prev[bn]);
    for (const ax of AXES) q[ax] = p[ax] || 0;
    seq.set(u, q);
    prev = q;
  }
  const end = seq.get(1);
  const out = {};
  for (const f of frames) {
    const u = (f - a) / (b - a);
    const p = seq.get(u);
    const w = smooth(u);
    const pose = {};
    for (const bn of bones) {
      const eb = pb[bn] || V0;   // as keyed (a spin the keys ask for is added across the span)
      pose[bn] = [0, 1, 2].map((i) => p[bn][i] + offA[bn][i] + (eb[i] - end[bn][i] - offA[bn][i]) * w);
    }
    for (const ax of AXES) {
      const oa = (pa[ax] || 0) - (m0[ax] || 0), ob = (pb[ax] || 0) - end[ax];
      pose[ax] = p[ax] + oa + (ob - oa) * w;
    }
    out[f] = pose;
  }
  return out;
}

// ================================================================ after the engines

export function clampPose(pose, bones) {
  for (const bn of bones) pose[bn] = R.clampLimits(bn, pose[bn] || V0);
}

// planted feet: each foot standing at A and at B is held on the floor (the same spot: lerped across; moved more than FEET_SAME:
// a step that lifts on an arc). Works on the hidden probe body. Returns {foot: "held" | "step" | "free"}
export function feet(doc, bones, body, a, b, poses) {
  const out = { footL: "free", footR: "free" };
  const info = body ? F.soleInfo(body) : null;
  if (!info || !Object.keys(info).length) return out;
  const ends = {};
  for (const ef of [a, b]) {
    body.apply(poseOf(doc, ef, bones));
    body.update();
    const st = F.standing(body, info);
    const row = {};
    for (const ft of ["footL", "footR"]) {
      if (!body.has(ft)) continue;
      row[ft] = { on: ((st[ft] || {}).w || 0) >= 0.5, pos: body.worldPos(ft), q: body.worldQuat(ft) };
    }
    ends[ef] = row;
  }
  const plans = {};
  for (const ft of ["footL", "footR"]) {
    const ra = ends[a][ft], rb = ends[b][ft];
    if (!ra || !rb || !ra.on || !rb.on) continue;
    const flat = Math.hypot(rb.pos.x - ra.pos.x, rb.pos.z - ra.pos.z);
    plans[ft] = { pa: ra.pos, pb: rb.pos, qa: ra.q, qb: rb.q, step: flat >= FEET_SAME, len: flat };
    out[ft] = flat >= FEET_SAME ? "step" : "held";
  }
  if (!Object.keys(plans).length) return out;
  // two steps: the longer one first, the other after it
  const steppers = Object.keys(plans).filter((k) => plans[k].step).sort((x, y) => plans[y].len - plans[x].len);
  steppers.forEach((k, i) => { plans[k].win = steppers.length === 1 ? [0.15, 0.85] : (i === 0 ? [0.05, 0.55] : [0.45, 0.95]); });
  // the body spins (the hips turn a lot from A to B, a full turn reads the same at both ends): a held foot stays on its spot but
  // pivots with the leg, it does not keep A's turn
  const ha = poseOf(doc, a, bones).hips || V0, hb = poseOf(doc, b, bones).hips || V0;
  const spin = Math.hypot(hb[0] - ha[0], hb[1] - ha[1], hb[2] - ha[2]) > SPIN;
  for (const f of Object.keys(poses).map(Number)) {
    const pose = poses[f];
    const u = (f - a) / (b - a);
    body.apply(pose);
    body.update();
    const touched = new Set();
    for (const ft in plans) {
      const pl = plans[ft];
      const side = ft === "footL" ? "L" : "R";
      const ids = ["leg" + side, "knee" + side, ft];
      if (!ids.every((n) => body.has(n))) continue;
      let k = smooth(u), lift = 0;
      if (pl.step) {
        const wu = clamp((u - pl.win[0]) / (pl.win[1] - pl.win[0]), 0, 1);
        k = smooth(wu);
        lift = clamp(0.25 * pl.len, STEP_LIFT[0], STEP_LIFT[1]) * Math.sin(Math.PI * wu);
      }
      const target = pl.pa.clone().lerp(pl.pb, k);
      target.y += lift;
      const hold = spin ? body.worldQuat(ft) : pl.qa.clone().slerp(pl.qb, k);
      E.solveTwoBone(body, ids[0], ids[1], ids[2], target, null, hold, 1);
      body.update();
      ids.forEach((n) => touched.add(n));
    }
    if (touched.size) poses[f] = E.readBack(body, pose, touched);
  }
  return out;
}

// the in-between poses for a..b with these settings (library: call libraryIndex first):
// {poses: {f: pose}, feet: {...}, match: {} (library), frames: [...]} or {error}
export function make(doc, bones, body, a, b, s) {
  const st = stepOf(doc, s);
  const frames = [];
  for (let f = a + st; f < b; f += st) frames.push(f);
  const res = { frames, match: {}, feet: {}, poses: {} };
  if (!frames.length) return res;
  let poses;
  if (s.engine === "library") {
    const ms = matches(doc, bones, a, b, s.pick + 1);
    if (!ms.length) return { ...res, error: "no clip in the library joins these two poses" };
    const m = ms[Math.min(s.pick, ms.length - 1)];
    res.match = m;
    poses = library(doc, bones, a, b, m, frames);
  } else poses = shape(doc, bones, a, b, s, frames);
  if (s.air > 0) for (const f in poses) { const u = (Number(f) - a) / (b - a); poses[f]._dy += s.air / 100 * 4 * u * (1 - u); }
  for (const f in poses) clampPose(poses[f], bones);
  if (s.feet && doc.plant && s.air <= 0 && body) {
    res.feet = feet(doc, bones, body, a, b, poses);
    for (const f in poses) clampPose(poses[f], bones);
  }
  res.poses = poses;
  return res;
}

// ================================================================ writing it into the clip

// a locked key between a and b stops a fill
export const lockedInside = (doc, a, b) => doc.keys.some((k) => k.f > a && k.f < b && k.lock);

// put a made fill into the doc: the keys between a and b go, the made poses come in as "breakdown" keys of fill `id`, key A
// eases linear while the fill is on
export function write(doc, bones, a, b, made, s, id) {
  if (lockedInside(doc, a, b)) return false;
  const old = atSpan(doc, a, b);
  const ka0 = doc.keyAt(a);
  const aEase = old ? String(old.a_ease ?? "") : String((ka0 && ka0.ease) || "");
  doc.keys = doc.keys.filter((k) => k.f <= a || k.f >= b);
  doc.fills = doc.fills.filter((fl) => !(fl.b > a && fl.a < b));
  for (const f of Object.keys(made.poses).map(Number).sort((x, y) => x - y)) {
    doc.writeKey(f, made.poses[f], bones);
    const k = doc.keyAt(f);
    k.tag = "breakdown";
    k.fill = id;
  }
  const ka = doc.keyAt(a);
  if (ka) ka.ease = "linear";
  const rec = { id, a, b, a_ease: aEase, settings: { ...s } };
  if (made.match && Object.keys(made.match).length) rec.match = { ...made.match };
  doc.fills.push(rec);
  doc.fills.sort((x, y) => x.a - y.a);
  return true;
}

// take a fill out: its keys go, key A gets its ease back. Returns how many keys went
export function remove(doc, id) {
  const fl = find(doc, id);
  if (!fl) return 0;
  const n = doc.keys.length;
  doc.keys = doc.keys.filter((k) => k.fill !== id);
  const ka = doc.keyAt(fl.a);
  if (ka) { if (!fl.a_ease) delete ka.ease; else ka.ease = fl.a_ease; }
  doc.fills = doc.fills.filter((x) => x.id !== id);
  return n - doc.keys.length;
}

export const nextId = (doc) => newId(doc.fills, "fill");

export function describe(fl) {
  const s = fl.settings || {};
  let t = `f${fl.a}-f${fl.b}  ${s.engine || "shape"}`;
  if (s.engine === "library" && fl.match) t += `: ${fl.match.clip}${fl.match.mirror ? " (mirrored)" : ""} ${fl.match.score | 0}%`;
  else t += `: ${s.timing || "smooth"}, flow ${Math.round((s.flow || 0) * 100)}%`;
  return t;
}
