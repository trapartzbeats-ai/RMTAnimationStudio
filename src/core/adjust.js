// Adjust: tilt a body part across the whole clip, a frame range, or around one frame, without touching its keys (the shoulders
// up a little on every frame of a walk, an arm straighter, the hands meeting for a clap). A port of the Godot Animator's
// core/adjust.gd.
//
// An adjustment is an "add" layer tagged "adjust": one constant turn for one bone over its range, fading in and out at the
// ends, so RESTORE just removes it and the keys never changed. Adjusting the same part with the same scope again replaces its
// turn (the value you set is the total). It never turns a joint past its rig limits, unless the clip itself already went past
// them there (evalc.js layerPose).
//   {name: "Adjust armL", mode: "add", source: "keys", adjust: true, bone: "armL", scope: "all"|"frame"|"range",
//    keys: [{f: 0, rot: {armL: [x, y, z]}}], mask: ["armL"], start, end, fade_in, fade_out}
import { DEG } from "./clip.js";

export const SCOPES = ["all", "frame", "range"];
export const SCOPE_NAMES = { all: "all frames", frame: "around one frame", range: "frame range" };
const snap4 = (x) => Math.round(x * 10000) / 10000;

// [start, end, fade_in, fade_out] for a scope: "all" = the whole clip; "frame" = `at`, easing over `ease` frames each side
// (0 = that frame only); "range" = from..to, easing over `ease` frames inside each end
export function span(scope, at, from, to, ease) {
  if (scope === "frame") return [Math.max(0, at - ease), at + ease, ease, ease];
  if (scope === "range") return [Math.min(from, to), Math.max(from, to), ease, ease];
  return [0, -1, 0, 0];
}

export const adjustLayers = (doc) => doc.layers.filter((l) => l.adjust);

// the adjustment of `bone` with exactly this span, or null
export function find(doc, bone, scope, sp) {
  return adjustLayers(doc).find((l) => l.bone === bone && l.scope === scope && Number(l.start || 0) === sp[0] && Number(l.end ?? -1) === sp[1]) || null;
}

// an adjustment's turn (radians)
export function value(l) {
  const ks = (l && l.keys) || [];
  if (!ks.length) return [0, 0, 0];
  const r = (ks[0].rot || {})[l.bone] || [0, 0, 0];
  return [Number(r[0]), Number(r[1]), Number(r[2])];
}

export function layerDef(bone, scope, sp, turn) {
  return { name: `Adjust ${bone}`, mode: "add", source: "keys", adjust: true, bone, scope, mask: [bone], keys: [{ f: 0, rot: { [bone]: turn.map(snap4) } }],
    start: sp[0], end: sp[1], fade_in: sp[2], fade_out: sp[3], weight: 1 };
}

// bone -> how many adjustments it has (the * marks)
export function adjustedBones(doc) {
  const out = {};
  for (const l of adjustLayers(doc)) if (!l.mute) out[l.bone] = (out[l.bone] || 0) + 1;
  return out;
}

// one line for the list: "armL  all frames  X +12  Z -5"
export function describe(l) {
  const v = value(l);
  const parts = [];
  for (let i = 0; i < 3; i++) if (Math.abs(v[i]) > 1e-4) parts.push(`${"XYZ"[i]} ${v[i] >= 0 ? "+" : ""}${Math.round(v[i] * DEG)}`);
  let where = SCOPE_NAMES[l.scope || "all"] || "";
  if (l.scope === "frame") where = `around f${Math.round((Number(l.start || 0) + Number(l.end || 0)) * 0.5)}`;
  else if (l.scope === "range") where = `f${Number(l.start || 0)}-${Number(l.end || 0)}`;
  return `${l.bone || ""}  ${where}  ${parts.join(" ")}${l.mute ? "  (muted)" : ""}`;
}
