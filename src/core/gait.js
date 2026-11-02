// Gait: what a real walk or run does above the legs, put on a walk / run clip in time with its own steps. A port of the Godot
// Animator's core/gait.gd (the same numbers, the same keys). Real cycles (the Motion Library, measured by
// MotionLibrary/study/study_more.py into data/motion_dna.json "gait") turn the torso and chest with every stride while the neck
// and head turn back the other way (the head stays on target) and swing the arms opposite each other; runs do it harder the
// faster they go. Our walks and runs do none of the turning. Gait reads the
// clip's own stride from its left thigh's swing (how long a stride is and where in it the clip is), estimates the speed from
// the stride (real: speed = a + b / stride), and adds each learned wave at its learned phase, only as much as the clip does not
// already have (a channel it already has at 90% or more is left alone). One KEYS add-layer of spline keys, like Alive. The
// hips' own turn and sway are left out (they would move planted feet), and so is the bob: in a match a planted clip's height
// comes from its legs (CBFeet.ground puts the soles on the floor), so a keyed bob is cancelled there.
//
// A channel: amp x cos(2 pi h (s + p_ref + phase)), s = strides since the range start, h = 1 (once a stride) or 2 (once a step),
// p_ref = where the clip's left thigh swings forward, phase = the learned offset from that.
// No UI and no app state here: App.gait* call it and keep the undo.
import { clamp } from "./clip.js";
import * as FL from "./fill.js";

export const KINDS = ["auto", "walk", "run"];
export const KIND_NAMES = { auto: "auto (by the clip's name / its stride)", walk: "walk", run: "run" };
export const DEFAULTS = { kind: "auto", speed: 0, amount: 1, from: 0, to: -1 };
const KEYS_PER_STRIDE = 8;
const REF = ["legL", 0];   // the left thigh's forward swing is stride phase 0
const TAU = Math.PI * 2;
const V0 = [0, 0, 0];
const posmod = (x, m) => ((x % m) + m) % m;
const snap = (v) => Math.round(v * 10000) / 10000;
const XYZ = "xyz";

export function settings(opts) {
  const s = { ...DEFAULTS };
  for (const k in opts) if (k in s) s[k] = opts[k];
  s.kind = KINDS.includes(String(s.kind)) ? String(s.kind) : "auto";
  s.speed = clamp(Number(s.speed) || 0, 0, 10);
  s.amount = clamp(Number(s.amount ?? 1), 0, 3);
  if (!Number.isFinite(s.amount)) s.amount = 1;
  s.from = Math.max(0, Math.trunc(Number(s.from) || 0));
  s.to = Math.trunc(Number(s.to ?? -1));
  if (!Number.isFinite(s.to)) s.to = -1;
  return s;
}

export const data = () => FL.dna().gait || {};

// the stride in a range of the base: {cycles, period (frames), p_ref (strides), n} from the left thigh's swing; null when it
// does not swing
export function stride(doc, bones, a, b, loopWhole) {
  const n = loopWhole ? b - a : b - a + 1;   // a loop's last frame is its first
  if (n < 8) return null;
  const xs = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    xs[i] = (doc.basePose(a + i, bones)[REF[0]] || V0)[REF[1]];
    mean += xs[i];
  }
  mean /= n;
  let lo = Infinity, hi = -Infinity;
  const ups = [];   // the frames (from a) where the thigh swings up through its middle
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, xs[i]);
    hi = Math.max(hi, xs[i]);
    const prev = i > 0 ? xs[i - 1] : (loopWhole ? xs[n - 1] : xs[0]);
    if ((i > 0 || loopWhole) && prev - mean < 0 && xs[i] - mean >= 0) ups.push(i);
  }
  if (hi - lo < 8 * Math.PI / 180 || !ups.length) return null;
  let cycles = ups.length;
  let period = n / cycles;
  if (!loopWhole) {
    period = ups.length >= 2 ? (ups[ups.length - 1] - ups[0]) / (ups.length - 1) : n;
    cycles = n / period;
  }
  // the first harmonic's phase: x ~ A cos(2 pi (s + p)), s = i / period
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) {
    const w = TAU * i / period;
    re += (xs[i] - mean) * Math.cos(w);
    im -= (xs[i] - mean) * Math.sin(w);
  }
  return { cycles, period, p_ref: posmod(Math.atan2(im, re) / TAU, 1), n };
}

// one channel's own wave in the base (h = 1 or 2): its amplitude
export function ownAmp(doc, bones, a, n, period, ch, h) {
  const [bn, ax] = ch.split(".");
  const vals = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const p = doc.basePose(a + i, bones);
    vals[i] = ax === "dy" ? (p._dy || 0) : (p[bn] || V0)[XYZ.indexOf(ax)];
    mean += vals[i];
  }
  mean /= n;
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) {
    const w = TAU * h * i / period;
    re += (vals[i] - mean) * Math.cos(w);
    im -= (vals[i] - mean) * Math.sin(w);
  }
  return 2 * Math.sqrt(re * re + im * im) / n;
}

// walk or run, and the speed (H/s) the learned amplitudes are read at
export function kindAndSpeed(doc, s, strideS) {
  const g = data();
  const k = g.speed_from_stride || [-1.61, 3.39];
  const rng = g.speed_range || [0.8, 5.0];
  const speed = s.speed > 0 ? s.speed : clamp(k[0] + k[1] / Math.max(strideS, 0.05), rng[0], rng[1]);
  let kind = s.kind;
  if (kind === "auto") {
    const nm = doc.name.toLowerCase();
    if (["run", "dash", "jog", "sprint"].some((w) => nm.includes(w))) kind = "run";
    else if (nm.includes("walk")) kind = "walk";
    else kind = speed >= (g.run_from ?? 2.0) ? "run" : "walk";
  }
  const sp = (g[kind] || {}).speeds || [speed, speed];
  return [kind, clamp(speed, sp[0], sp[1])];
}

// the Gait layer for a doc (not added: App.gaitAdd does that) or {error}
export function makeLayer(doc, bones, opts) {
  const s = settings(opts);
  const g = data();
  if (!Object.keys(g).length) return { error: "no learned data (data/motion_dna.json gait)" };
  const a = clamp(s.from, 0, doc.frames);
  const b = s.to < 0 ? doc.frames : clamp(s.to, a, doc.frames);
  const whole = a === 0 && b === doc.frames;
  const st = stride(doc, bones, a, b, doc.loop && whole);
  if (!st) return { error: "the left thigh does not swing here: no stride to follow" };
  const period = st.period;
  const [kind, speed] = kindAndSpeed(doc, s, period / doc.fps);
  const chans = (g[kind] || {}).channels || {};
  const names = Object.keys(chans).sort();
  const H = Number(g.H ?? 1.287);
  const add = {};   // channel -> amplitude to add
  for (const ch of names) {
    const c = chans[ch];
    const bn = ch.split(".")[0];
    if (bn !== "hips" && !bones.includes(bn)) continue;
    let want = Math.max(0, c.amp0 + c.amp_per_speed * speed);
    if (ch === "hips.dy") want *= H;
    const have = ownAmp(doc, bones, a, st.n, period, ch, c.h);
    if (have >= 0.9 * want) continue;   // the clip already moves this much: nothing to add
    add[ch] = (want - have) * s.amount;
  }
  const chs = Object.keys(add);
  if (!chs.length) return { error: `the clip already moves like a real ${kind}` };
  const used = [];
  for (const ch of chs) { const bn = ch.split(".")[0]; if (!used.includes(bn)) used.push(bn); }
  const step = Math.max(2, Math.round(period / KEYS_PER_STRIDE));
  const frames = [];
  for (let f = a; f < b; f += step) frames.push(f);
  frames.push(b);
  const keys = [];
  for (const fr of frames) {
    const sv = (fr - a) / period + st.p_ref;
    const rot = {};
    const k = { f: fr, rot };
    for (const ch of chs) {
      const c = chans[ch];
      const v = add[ch] * Math.cos(TAU * c.h * (sv + c.phase));
      const [bn, ax] = ch.split(".");
      if (ax === "dy") { k.hips_dy = snap(v); continue; }
      const e = rot[bn] || [0, 0, 0];
      e[XYZ.indexOf(ax)] = snap(v);
      rot[bn] = e;
    }
    keys.push(k);
  }
  const round = (x, q) => Math.round(x / q) * q;
  const gait = { ...s, kind, speed: round(speed, 0.01), stride_s: round(period / doc.fps, 0.001), strides: round(st.cycles, 0.01) };
  return { name: `Gait (${kind} ${speed.toFixed(1)})`, mode: "add", source: "keys", ease: "spline", keys, mask: used, weight: 1,
    start: a, end: b === doc.frames ? -1 : b, fade_in: 0, fade_out: 0, gait };
}

export const layers = (doc) => doc.layers.filter((l) => l.gait);

export function describe(l) {
  const s = l.gait || {};
  return `${s.kind || "walk"} at ${Number(s.speed || 0).toFixed(1)} H/s x${Number(s.amount ?? 1).toFixed(2)}, a stride every ${Number(s.stride_s || 0).toFixed(2)} s`;
}
