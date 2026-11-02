// Merge: one new animation from several (a port of the Godot Animator's core/merge.gd). The open clip is the BASE (it gives the
// body); clips ON TOP give only the body parts you pick (the arms of a cheer, a clap, a wave over a walk), each from a start
// frame, blending in and out. Every clip on top is an ordinary override layer tagged "merge" (the Layers panel shows it too), so
// playing previews it live. Baking makes ONE new clip (keys thinned so it stays editable) and leaves the base clip as it is; the
// recipe rides along in the new clip ("merge": base + layers), so the setup can be rebuilt.
import { Doc } from "./doc.js";
import { clipSrc, bake as bakeDoc } from "./evalc.js";
import { reduceKeys } from "./clip.js";

// body parts a clip on top can give, in the order the chips show them
export const PARTS = ["Head", "Spine", "Arm L", "Arm R", "Hands", "Hips", "Legs", "Tail"];
export const PART_BONES = {
  Head: ["neck", "head", "@Ears"],
  Spine: ["torso", "spine1", "chest"],
  "Arm L": ["clavicleL", "armL", "elbowL", "handL"],
  "Arm R": ["clavicleR", "armR", "elbowR", "handR"],
  Hands: ["@Hand L", "@Hand R"],
  Hips: ["hips"],
  Legs: ["legL", "kneeL", "footL", "toeL", "legR", "kneeR", "footR", "toeR"],
  Tail: ["@Tail"],
};
export const DEFAULT_PARTS = ["Arm L", "Arm R", "Hands"];

// the layer mask for a set of parts
export function maskFor(parts) {
  const out = [];
  for (const p of parts) for (const b of PART_BONES[p] || []) if (!out.includes(b)) out.push(b);
  return out;
}

const clipFrames = (clip) => Number((clipSrc(clip) || {}).frames || 24);
const endOf = (clip, start, cycle, speed) => (cycle ? -1 : start + Math.round(clipFrames(clip) / Math.max(speed, 0.01)));

// a clip on top as a layer: clip frame 0 lands on `start`; a one-shot ends when its clip does, a cycled one runs to the end
export function layerDef(clip, parts, start, blendIn, blendOut, weight = 1, cycle = false, speed = 1) {
  return { name: clip, mode: "override", source: "clip", clip, merge: true, parts: [...parts], mask: maskFor(parts), start, offset: start,
    end: endOf(clip, start, cycle, speed), fade_in: blendIn, fade_out: blendOut, weight, cycle, speed };
}

// when one field changes, the ones that follow it (start moves the clip with it; cycle / speed move the end)
export function follow(l, props) {
  const out = { ...props };
  const start = Number(out.start ?? l.start ?? 0);
  const cycle = !!(out.cycle ?? l.cycle ?? false);
  const speed = Number(out.speed ?? l.speed ?? 1);
  if (out.parts) out.mask = maskFor(out.parts);
  if ("start" in out) out.offset = start;
  if ("start" in out || "cycle" in out || "speed" in out) out.end = endOf(String(l.clip || ""), start, cycle, speed);
  return out;
}

export const mergeLayers = (doc) => doc.layers.filter((l) => l.merge);

// how long the merged clip is: the base, or the last clip on top if that runs longer
export function length(doc) {
  let n = doc.frames;
  for (const l of mergeLayers(doc)) if (!l.mute && Number(l.end ?? -1) > n) n = Number(l.end);
  return n;
}

// the base's keys repeated to cover `frames` (a looping base: a walk keeps walking under a long clap)
export function repeatedKeys(doc, frames) {
  const keys = structuredClone(doc.keys);
  if (!doc.loop || frames <= doc.frames || doc.frames <= 0) return keys;
  const out = [];
  for (let cycle = 0; cycle * doc.frames <= frames; cycle++) {
    for (const k of keys) {
      const f = Number(k.f) + cycle * doc.frames;
      if (cycle > 0 && Number(k.f) === 0) continue;   // a loop's first key is its last key: once
      if (f > frames + doc.frames) break;
      out.push({ ...structuredClone(k), f });
    }
  }
  return out;
}

// the merged clip as a new document (unsaved): the base + everything live on it, baked, thinned, with its recipe
export function bake(doc, body, bones, name, tolerance = 0.01) {
  const n = length(doc);
  const tmp = Doc.fromClip(doc.toClip());
  tmp.keys = repeatedKeys(doc, n);
  tmp.loop = false;
  tmp.frames = n;
  const baked = bakeDoc(tmp, body, bones, {});
  const nd = Doc.blank(name, n, doc.fps);
  nd.keys = baked;
  nd.loop = false;
  nd.plant = doc.plant;
  const recipe = [], from = [];
  for (const l of mergeLayers(doc)) {
    if (l.mute) continue;
    recipe.push({ clip: l.clip, parts: l.parts || [], start: l.start || 0, blend_in: l.fade_in || 0, blend_out: l.fade_out || 0, weight: l.weight ?? 1,
      cycle: !!l.cycle, speed: l.speed ?? 1 });
    from.push(`${l.clip} (${(l.parts || []).join(", ")} from f${Number(l.start || 0)})`);
  }
  nd.extra.note = `Merge: ${doc.name} with ${from.join("; ")}`;
  nd.extra.merge = { base: doc.name, layers: recipe };
  const c = nd.toClip();
  reduceKeys(c, bones, tolerance);
  return Doc.fromClip(c);
}
