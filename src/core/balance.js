// Balance: a body kicking leans away from the kick. A port of the Godot Animator's core/balance.gd (the same numbers, the same
// keys). Real swing kicks (the Motion Library, measured by MotionLibrary/study/study_more2.py into data/motion_dna.json
// "balance") lean ~33 degrees away from the kicking leg; the chest and torso carry ~10 + ~6 of it (mirrored with the side), the
// rest is the pelvis over the standing leg. Our kicks do not lean away (median 0, a quarter lean INTO the kick). Balance finds
// the kicks in the clip from its legs alone - a thigh lifted past lift_from (degrees from where it stands at the range's first
// frame) while the other thigh stays under support_max - and leans the torso and chest away from it in proportion to the lift,
// only as much as the clip does not already lean that way. One KEYS add-layer, like Alive and Gait. The pelvis is left to the
// feet.
// No UI and no app state here: App.balance* call it and keep the undo.
import * as THREE from "three";
import { clamp, rotQuat } from "./clip.js";
import * as FL from "./fill.js";

export const DEFAULTS = { amount: 1, from: 0, to: -1 };
const SIDES = { L: 1, R: -1 };   // a left kick leans the chest + z (the z channel mirrors with the side)
const V0 = [0, 0, 0];
const XYZ = "xyz";
const snap = (v) => Math.round(v * 10000) / 10000;
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

export function settings(opts) {
  const s = { ...DEFAULTS };
  for (const k in opts) if (k in s) s[k] = opts[k];
  s.amount = clamp(Number(s.amount ?? 1), 0, 3);
  if (!Number.isFinite(s.amount)) s.amount = 1;
  s.from = Math.max(0, Math.trunc(Number(s.from) || 0));
  s.to = Math.trunc(Number(s.to ?? -1));
  if (!Number.isFinite(s.to)) s.to = -1;
  return s;
}

export const data = () => FL.dna().balance || {};

// how far (degrees) a thigh is turned from where it stands at the reference pose
export function lift(pose, ref, leg) {
  rotQuat(pose[leg] || V0, _qa);
  rotQuat(ref[leg] || V0, _qb);
  return 2 * Math.acos(Math.min(1, Math.abs(_qa.dot(_qb)))) * 180 / Math.PI;
}

const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

// per frame of a..b: [side ("L" / "R" / ""), how much of a kick it is 0..1]
export function kicks(doc, bones, a, b) {
  const d = data();
  const lo = Number(d.lift_from_deg ?? 35), hi = Number(d.lift_full_deg ?? 70), sup = Number(d.support_max_deg ?? 30);
  const ref = doc.basePose(a, bones);
  const out = [];
  for (let f = a; f <= b; f++) {
    const p = doc.basePose(f, bones);
    const l = lift(p, ref, "legL"), r = lift(p, ref, "legR");
    let side = "", k = 0;
    if (l >= r && r < sup) { side = "L"; k = smooth((l - lo) / Math.max(hi - lo, 1)); }
    else if (r > l && l < sup) { side = "R"; k = smooth((r - lo) / Math.max(hi - lo, 1)); }
    out.push([k > 0 ? side : "", k]);
  }
  return out;
}

// the Balance layer for a doc (not added: App.balanceAdd does that) or {error}
export function makeLayer(doc, bones, opts) {
  const s = settings(opts);
  const d = data();
  if (!Object.keys(d).length) return { error: "no learned data (data/motion_dna.json balance)" };
  const a = clamp(s.from, 0, doc.frames);
  const b = s.to < 0 ? doc.frames : clamp(s.to, a, doc.frames);
  if (b - a < 2) return { error: "the range is too short" };
  const lean = d.lean || {};
  const ks = kicks(doc, bones, a, b);
  if (!ks.some((k) => k[1] > 0)) return { error: `no kick here: no thigh lifts past ${Math.trunc(Number(d.lift_from_deg ?? 35))} degrees while the other stands` };
  const ref = doc.basePose(a, bones);
  const step = Math.max(1, Math.round(doc.fps / 30));
  const frames = [];
  for (let f = a; f < b; f += step) frames.push(f);
  frames.push(b);
  const keys = [], used = [];
  for (const fr of frames) {
    const kk = ks[fr - a];
    const rot = {};
    if (kk[0]) {
      const sgn = SIDES[kk[0]];
      const p = doc.basePose(fr, bones);
      for (const ch of Object.keys(lean)) {
        const [bn, axn] = ch.split(".");
        if (!bones.includes(bn)) continue;
        const ax = XYZ.indexOf(axn);
        const want = lean[ch] * kk[1];
        const have = Math.max(0, sgn * ((p[bn] || V0)[ax] - (ref[bn] || V0)[ax]));
        const v = sgn * Math.max(0, want - have) * s.amount;
        if (Math.abs(v) > 1e-5) {
          const e = rot[bn] || [0, 0, 0];
          e[ax] = snap(v);
          rot[bn] = e;
          if (!used.includes(bn)) used.push(bn);
        }
      }
    }
    keys.push({ f: fr, rot });
  }
  if (!used.length) return { error: "the clip already leans away from its kicks" };
  used.sort();
  return { name: "Balance (kick lean)", mode: "add", source: "keys", ease: "linear", keys, mask: used, weight: 1, start: a,
    end: b === doc.frames ? -1 : b, fade_in: 0, fade_out: 0, balance: s };
}

export const layers = (doc) => doc.layers.filter((l) => l.balance);

export function describe(l) {
  const s = l.balance || {};
  let n = 0, on = false;
  for (const k of l.keys || []) {
    const has = Object.keys(k.rot || {}).length > 0;
    if (has && !on) n++;
    on = has;
  }
  return `${n} kick${n === 1 ? "" : "s"} leaning away x${Number(s.amount ?? 1).toFixed(2)}`;
}
