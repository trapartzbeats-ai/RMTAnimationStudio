// Alive: a body standing still is never still. A port of the Godot Animator's core/alive.gd (the same numbers, the same keys).
// Real idles (the Motion Library's motion capture, measured by MotionLibrary/study/study.py into data/motion_dna.json "alive")
// breathe every ~2.7 s (calm) to ~1.8 s (tired): the chest and torso pitch with the breath, the head nods against it (it keeps
// the eyes level), the arms sway with it, and the head and the rest drift on slower waves. Our clips hold their poses dead still
// between keys. Alive puts that life on a clip as an ordinary KEYS layer ("add", spline keys, every bone it touches in its mask),
// so it shows live, bakes for the game like any layer and comes off again in one click.
//
// Channels that follow the breath: sign x amp x sin(2 pi (t / P - phase)). Channels with no steady phase in the data drift:
// amp x (0.7 sin(2 pi (t / P1 + h1)) + 0.3 sin(2 pi (t / P2 + h2))), P1 / P2 = 1.618 / 2.618 x P, h from the channel's index and
// the seed. On a looping clip every period is fitted so a whole number of them fills the clip (it loops seamlessly).
// "holds": while the base moves (attacks, steps) the life drops to KEEP of itself: breathing goes on under a move, quieter.
// The hips only bob up and down: turning or sliding them would move the planted feet (the Feet tools own those).
// No UI and no app state here: App.alive* call it and keep the undo.
import { clamp } from "./clip.js";
import * as FL from "./fill.js";

export const MOODS = ["calm", "fight", "tired", "lying", "winded"];
export const MOOD_NAMES = { calm: "calm (standing, breathing)", fight: "fight (guard up, ready)", tired: "tired (hurt, heavy breath)",
  lying: "lying (on the floor, slow breath)", winded: "winded (on the floor, panting)" };
export const DEFAULTS = { mood: "calm", amount: 1, holds: true, seed: 0, from: 0, to: -1 };
const DRIFT = [1.618, 2.618];
const KEYS_PER_BREATH = 8;
const STILL = 0.5;        // rad/s, the base's fastest main bone: below this the body is holding still
const MOVING = 3.0;       // above this it is moving (a strike turns a joint 5-10 rad/s): the life is down to KEEP
const KEEP = 0.25;
const TAU = Math.PI * 2;
const V0 = [0, 0, 0];
const posmod = (x, m) => ((x % m) + m) % m;
const snap = (v) => Math.round(v * 10000) / 10000;

export function settings(opts) {
  const s = { ...DEFAULTS };
  for (const k in opts) if (k in s) s[k] = opts[k];
  s.mood = MOODS.includes(String(s.mood)) ? String(s.mood) : "calm";
  s.amount = clamp(Number(s.amount), 0, 3);
  if (!Number.isFinite(s.amount)) s.amount = 1;
  s.holds = !!s.holds;
  s.seed = Math.trunc(Number(s.seed) || 0);
  s.from = Math.max(0, Math.trunc(Number(s.from) || 0));
  s.to = Math.trunc(Number(s.to ?? -1));
  if (!Number.isFinite(s.to)) s.to = -1;
  return s;
}

// the learned numbers of a mood ({} when data/motion_dna.json is missing)
export const moodData = (mood) => (((FL.dna().alive || {}).moods || {})[mood] || {});

// a period fitted to a looping clip (a whole number of them in its length); as wanted otherwise
export function fitPeriod(want, lengthS, loop) {
  if (!loop || lengthS <= 0 || want <= 0) return want;
  return lengthS / Math.max(1, Math.round(lengthS / want));
}

// how fast the base keys move at frame f: its fastest main bone (rad/s, Fill's bones, Euler channels; one arm striking counts
// as moving)
export function baseSpeed(doc, bones, f) {
  let f0 = f - 1, f1 = f + 1;
  if (doc.loop) { f0 = posmod(f0, doc.frames); f1 = posmod(f1, doc.frames); }
  else { f0 = clamp(f0, 0, doc.frames); f1 = clamp(f1, 0, doc.frames); }
  const pa = doc.basePose(f0, bones), pb = doc.basePose(f1, bones);
  let top = 0;
  for (const b of Object.keys(FL.MATCH)) {
    if (!bones.includes(b)) continue;
    const x = pb[b] || V0, y = pa[b] || V0;
    top = Math.max(top, Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]));
  }
  return top * doc.fps * 0.5;
}

// how much of the life is on at frame f: 1 while the base holds still, down to KEEP while it moves (the fastest moment within
// half a key step either side counts, so a quick move between two keys is not missed)
export function envelope(doc, bones, f, half) {
  let sp = 0;
  for (let g = f - half; g <= f + half; g += 2) sp = Math.max(sp, baseSpeed(doc, bones, g));
  const k = clamp((sp - STILL) / (MOVING - STILL), 0, 1);
  return 1 - (1 - KEEP) * k * k * (3 - 2 * k);
}

// one channel's value at time t (seconds)
export function channel(c, i, t, per, seed) {
  const amp = Number(c.amp || 0);
  if (c.drift) {
    const h1 = posmod(0.37 * (i + 1) + 0.618 * seed, 1), h2 = posmod(0.71 * (i + 1) + 0.382 * seed, 1);
    return amp * (0.7 * Math.sin(TAU * (t / per[1] + h1)) + 0.3 * Math.sin(TAU * (t / per[2] + h2)));
  }
  return Number(c.sign ?? 1) * amp * Math.sin(TAU * (t / per[0] - Number(c.phase || 0)));
}

// the Alive layer for a doc (not added: App.aliveAdd does that): {name, mode add, source keys, ease spline, keys, mask, start,
// end, weight, alive: settings, periods} or {error}
export function makeLayer(doc, bones, opts) {
  const s = settings(opts);
  const md = moodData(s.mood);
  if (!Object.keys(md).length) return { error: "no learned data (data/motion_dna.json alive moods)" };
  const a = clamp(s.from, 0, doc.frames);
  const b = s.to < 0 ? doc.frames : clamp(s.to, a, doc.frames);
  if (b - a < 2) return { error: "the range is too short" };
  const whole = a === 0 && b === doc.frames;
  const lengthS = doc.frames / doc.fps;
  const breath = Number(md.breath_s || 2.5);
  const loopFit = doc.loop && whole;
  const per = [fitPeriod(breath, lengthS, loopFit), fitPeriod(breath * DRIFT[0], lengthS, loopFit), fitPeriod(breath * DRIFT[1], lengthS, loopFit)];
  const step = Math.max(2, Math.round(doc.fps * per[0] / KEYS_PER_BREATH));
  const chans = md.channels || {};
  const names = Object.keys(chans).sort();
  const used = [];
  for (const ch of names) {
    const bn = ch.split(".")[0];
    if ((bn === "hips" || bones.includes(bn)) && !used.includes(bn)) used.push(bn);
  }
  const frames = [];
  for (let f = a; f < b; f += step) frames.push(f);
  frames.push(b);
  const keys = [];
  for (const fr of frames) {
    const t = fr / doc.fps;
    const env = s.holds ? envelope(doc, bones, fr, step >> 1) : 1;
    const rot = {};
    const k = { f: fr, rot };
    names.forEach((ch, i) => {
      const [bn, ax] = ch.split(".");
      const v = channel(chans[ch], i, t, per, s.seed) * s.amount * env;
      if (bn === "hips" && ax === "dy") { k.hips_dy = snap(v); return; }
      if (!bones.includes(bn)) return;
      const e = rot[bn] || [0, 0, 0];
      e["xyz".indexOf(ax)] = snap(v);
      rot[bn] = e;
    });
    keys.push(k);
  }
  return { name: `Alive (${s.mood})`, mode: "add", source: "keys", ease: "spline", keys, mask: used, weight: 1, start: a,
    end: b === doc.frames ? -1 : b, fade_in: 0, fade_out: 0, alive: s, periods: per.map((p) => Math.round(p * 1000) / 1000) };
}

// the Alive layers on a doc
export const layers = (doc) => doc.layers.filter((l) => l.alive);

export function describe(l) {
  const s = l.alive || {}, p = l.periods || [0];
  return `${s.mood || "calm"} x${Number(s.amount ?? 1).toFixed(2)}, a breath every ${Number(p[0]).toFixed(2)} s${s.holds !== false ? ", quieter while moving" : ""}`;
}
