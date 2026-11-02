// The agent API (port :47680 through main.js): the same methods as the Godot Animator's api.gd, so the one MCP server drives
// either app. Rotations in DEGREES, positions in METRES, the fighter at the origin facing +Z (R bones on +X, L on -X).
import * as THREE from "three";
import * as R from "./core/rig.js";
import * as E from "./core/evalc.js";
import { poseOfKey, newId } from "./core/doc.js";
import { MODES } from "./shell.js";
import { setAt, layerSpan } from "./fxstudio.js";
import { buildReport } from "./review.js";
import { RECIPES } from "./compose.js";
import { DEG, RAD, v3, dist3 } from "./core/clip.js";
import * as A from "./core/adjust.js";
import * as FL from "./core/fill.js";
import * as M from "./core/merge.js";

export const METHODS = {
  ping: "-> 'pong'", state: "what is open", rig: "bones, axes, limits, limbs, masks, controls, sockets, rules", list_fighters: "", set_fighter: "{fighter}",
  list_clips: "{filter?}", open_clip: "{name, discard?}", new_clip: "{name, frames=30, fps=30, loop=false, from_pose=true, overwrite?}", save: "{}", save_as: "{name}",
  get_clip: "{} (rot in degrees)", set_clip: "{frames?, fps?, loop?, plant?, override?, ease?, note?, marks?}", set_frame: "{frame}",
  get_pose: "{frame? (number or list), bones?, final?: true, world?: false}", set_pose: "{frame?, bones: {name: [x,y,z] deg}, hips?: {dx,dy,dz}, mode?: set|add, key?: true, mirror?}",
  ik_pose: "{bone, target: [x,y,z], frame?, key?: true, keep_end?: true}", key: "{frame?, ease?, tag?}", list_keys: "{}", delete_keys: "{frames}", move_keys: "{frames, delta}",
  set_keys: "{frames, ease?, tag?, lock?}", set_key_values: "{frame, bones: {..deg}, hips?}", link_keys: "{frames}", unlink_keys: "{frames}", same_keys: "{frame}",
  set_propagate: "{mode: off|linked|pose|bone}", insert_frames: "{at, count}", delete_frames: "{at, count}", scale_time: "{factor, frames?}", reverse: "{from, to}", close_loop: "{}",
  mirror_pose: "{mode: l2r|r2l|flip, frame?, key?}", reset_bones: "{bones, frame?, key?}", breakdown: "{t, frame?, key?}", list_poses: "{}", save_pose: "{name, bones?}",
  apply_pose: "{name, frame?, bones?, weight?, mirror?, key?}", list_controls: "{frame?}", set_control: "{name, value, frame?, key?}", add_control: "{name, min?, max?, drives}",
  list_layers: "{}", add_layer: "{...}", set_layer: "{id, ...}", remove_layer: "{id}", set_active_layer: "{id}", list_constraints: "{}", add_constraint: "{type, ...}",
  merge: "{base? (clip to open as the base), discard?, clips: [{clip, parts?: Head|Spine|Arm L|Arm R|Hands|Hips|Legs|Tail (default arms + hands), start?, blend_in=10, blend_out=10, weight=1, cycle=false}], bake=false, name?} -> {layers, baked?}",
  merge_add: "{clip, parts?, start? (-1 = current frame), blend_in=10, blend_out=10, weight=1, cycle=false} -> the layer",
  merge_set: "{id, parts?, start?, blend_in?, blend_out?, weight?, cycle?, speed?, mute?} -> the layer",
  merge_bake: "{name} -> {name, frames, keys, base}: ONE new clip from the base + clips on top (opens unsaved)",
  show_panel: "{title}: bring a panel to the front (Merge, Adjust, Feet, Layers, Dope Sheet, Blend Lab, Clips, ...)",
  adjust: "{bone, x=0, y=0, z=0 (degrees, the TOTAL turn of this adjustment), scope: all|frame|range, frame? (scope frame; default current), from?, to? (scope range), ease=6, mirror=false} -> {layers}; all zero removes it",
  adjust_restore: "{id? | bone?} (neither = all adjustments) -> {restored}", adjustments: "{} -> [{id, bone, scope, start, end, turn (degrees), text}]",
  fill: "{from?, to? (default: the keys around the current frame), engine: shape|library, timing: smooth|even|strike|settle or LEARNED from real motion natural|punch|kick|swing|hit|arrive|land (data/motion_dna.json), flow=0.6, overlap=0.3, anticipate=0, overshoot=0 (0..1), feet=true (planted feet held / stepped), air=0 (cm jump arc), step=0 (key every N frames, 0 = auto), pick=0 (library match)} -> {id, from, to, keys, engine, match, feet, settings}: the frames between two keys made for you; the same span again replaces its fill and keeps the settings you leave out",
  fill_matches: "{from?, to?, n=5} -> [{clip, from, to, mirror, cost, score (0..100), frames (how long that change took there)}]: library stretches that join the two poses",
  fill_remove: "{id? (none = every fill)} -> {removed (keys)}",
  fill_real: "{folder? (sets it; \"\" = our clips only)} -> {folder, clips}: the real-motion folder (the Motion Library's clips) Fill's library searches too, as real/<clip>",
  alive: "{mood: calm|fight|tired|lying|winded, amount=1 (1 = like real idles, 0..3), holds=true (quieter while the base moves), seed=0, from=0, to=-1} -> {id, keys, mood, periods, bones}: breathing, head and arm life learned from real idles, as one Alive layer (replaces the one there was; bakes like any layer)",
  alive_remove: "{} -> {removed (layers)}",
  gait: "{kind: auto|walk|run, speed=0 (H/s; 0 = from the clip's stride), amount=1, from=0, to=-1} -> {id, keys, kind, speed, stride_s, strides, bones}: a real walk / run's torso + chest turn, head counter-turn, arm swing and bob, in time with the clip's own steps, as one Gait layer (replaces the one there was)",
  gait_remove: "{} -> {removed (layers)}",
  balance: "{amount=1, from=0, to=-1} -> {id, keys, kicks, bones}: lean the torso and chest away from every kick in the clip (a thigh lifted past ~35 degrees while the other stands), learned from real swing kicks, only what the clip lacks; one Balance layer (replaces the one there was)",
  balance_remove: "{} -> {removed (layers)}",
  fills: "{} -> [{id, a, b, settings, match?, text}]",
  fx_blocks: "{query?} -> [{id, category, duration, loop, layers, tags}]: the RMT effect library (blocks are made in the RMT Effect Studio)",
  fx_cues: "{} -> [{index, id, socket, mode, t, frame, dur, offset, rot, scale}]: the effects on this clip (its cues), saved or not",
  setup: "{fix?: rig|wrap|soles|sockets|move|effects|checks|saved|all, yes? (without it a fix only returns its plan), name? (save as), save? (sockets: write them, default true), effects? (all: also suggest an effect), new_move?: name} -> {steps: [{id, ok, note, fix: {label, plan}}], ran, log}: the guided run to a game-ready move; wrap / soles are baked by the game's own tools in headless Godot",
  fx_studio: "{open?: id, select?: layer name|index, fold?: {TIMING|TRANSFORM|SHADER|...: open?}, set?: {layer?: name|index, path: \"a.b.c\"|[..], value}, add_layer?: kind, remove_layer?, time? (s: pauses), play?, at?: socket|origin, revert?, save?, manifest?} -> the FX Studio's state: edit one block live (the FX mode); save writes a user override",
  fx_add: "{id, socket, frame? (default: the current frame) | t?, mode: burst|follow, dur=0.5, offset=[ahead, up, toward camera] m at match size, rot=[x, y, z] deg, scale=1} -> {index}: fire a block at a socket at a frame (a burst stays where the socket was; a follow rides it for dur s)",
  fx_edit: "{index, socket?, mode?, frame? | t?, dur?, offset?, rot?, scale?, id?} -> the cue",
  fx_remove: "{index} -> the cues left",
  fx_save: "{} -> writes the clip's cues (data/clip_fx.json); save does it too",
  fx_measure: "{frame?} -> per cue at that frame: live, box (metres in the game's frame: x ahead, y up, z toward the camera, at match size), nearest_sockets, covers_head, height_vs_fighter",
  review: "{sheet? (also render the contact sheet of every angle)} -> {verdict: READY|NEEDS WORK|BLOCKED, counts, cards [{id, title, level: ok|warn|error|info, note, f, more}] (joints, arms, loop, feet, wrap, data, effects, saved), frame_data {startup, active, recovery, total}, strikers [{socket, peak_ms, peak_f, reach_m, fwd_m, at_hit_ms}], effects [{index, id, socket, frame, delta (from the hit), flag}], text, sheet?}: the REVIEW mode's verdict on the open move; it reads the clip and changes nothing",
  compose: "{recipe?: hit_spark|swing_trail|kick_swoosh|heavy_hit|landing_dust|footsteps (without apply: only the plan), apply?, snap?: {index, to: hit|clear|peak|contact|start|end|playhead}, nudge?: {index, frames}, shift_all?: frames, align?: true (the impacts onto the hit mark), swap_side?: index, duplicate?: index, remove?: index, undo?, save?} -> {did, recipes [{id, title, ok, why, fresh, cues}], cues, sheet, undo}: the COMPOSE mode; cues are unsaved until save (or the clip is saved), and every change has one undo",
  fx_studio_godot: "{effect?} -> opens the RMT Effect Studio (Godot) on this fighter, clip and frame (to make or change a block; its own agent API is 127.0.0.1:47670)",
  feet: "{planted? (sets the clip's plant flag first), step=1} -> {planted, soles {footL: {tilt0, ankle_cm}}, counts {flat, pivot, limit, sink, air}, frames [{f, footL: {state, low_cm, tilt}, footR}]}: how the feet stand in the match, per frame",
  set_constraint: "{id, ...}", remove_constraint: "{id}", freeze: "{bone, from?, to?, what?}", bake_to_keys: "{}", lock: "{bones, channels?}", unlock: "{bones}",
  list_sockets: "{}", add_marker: "{frame, name}",
  list_props: "{} -> the clip's props [{id, name, shape, socket | grip, size?, offset, rot, scale, color}]",
  add_prop: "{shape: block|cylinder|sphere|box|bat|blade|ball|can|phone, grip?: cylinder_R|sphere_L|block_R.., socket?, size?: [x,y,z] m, offset?, rot? deg, color?, name?} -> id (clip only, never in the game)",
  set_prop: "{id, ...same fields}", remove_prop: "{id} (or {all: true})",
  set_view: "{layout?, index?, preset?, ortho?, onion?, wrap? (Collision Wrap view), wrap_caps? (its capsules), tool?, bone?, focus_bone?, dist? m, yaw? deg, pitch? deg}", screenshot: "{target: window|view|sheet, width?, height?, cols?, path?}",
  import_motion: "{path (Mixamo FBX / GLB / glTF on disk), name?, anim?, in_place=true, limits=true, fingers=true, plant='auto', loop='auto', discard?: bool} -> report; opens the clip unsaved",
  wrap_report: "{top=6 (rows per list, 0 = all), tol_cm=1} -> {fighter, clip, planted, match_scale, keyed {pairs, rows [{pair, cm, f, frames}]}, solved {pairs, rows}, max_corr_deg, max_corr_bone, max_corr_f, flagged (> 45°), text}: the Collision Wrap clash report of the open clip (the game's ult_clash.gd), as keyed and after the match's Body Solve",
  wrap_state: "{frame?} -> the Body Solve at a frame as the view shows it: {on, frame, max_corr_deg, max_corr_bone, contacts, lift_cm, clashing [piece ids]}",
  checks: "{}", transition_clip: "{clip_b, at, blend, name}", undo: "{}", redo: "{}", history: "{}", say: "{message}", bake_glb: "{}",
};

const deg3 = (e) => e.map((x) => Math.round(x * DEG * 100) / 100);
const rad3 = (a) => v3(a).map((x) => x * RAD);
const m3 = (p) => [p.x, p.y, p.z].map((x) => Math.round(x * 10000) / 10000);
const ints = (a) => (a || []).map((x) => Math.round(Number(x)));

export function makeApi(app) {
  const who = "agent";
  const go = (p) => { if (p.frame !== undefined && !Array.isArray(p.frame)) { app.playing = false; app.setFrame(Number(p.frame)); } };
  const maybeKey = (p) => (p.key !== false ? app.keyNow("", who) : { frame: Math.round(app.frame), keyed: false });

  const D = {
    ping: () => "pong",
    state: () => ({ fighter: app.fighter, clip: app.doc.name, frame: app.frame, frames: app.doc.frames, fps: app.doc.fps, loop: app.doc.loop, plant: app.doc.plant,
      keys: app.doc.keyFrames(), layers: app.doc.layers.length, constraints: app.doc.constraints.length, unsaved: app.history.dirty(), new: app.isNew,
      selected_bone: app.selBone, selected_bones: app.selBones, tool: app.tool, active_layer: app.activeLayer, propagate: app.propagate, autokey: app.autokey,
      layout: app.views.main.layout, pending_unkeyed_edit: !!app.pending, outside_edit: app.doc.outsideEdit }),
    rig: () => {
      const body = app.stage.probe;
      body.apply({});
      return { fighter: app.fighter, height_m: Math.round(app.stage.height * 100) / 100,
        bones: app.bones.map((b) => ({ name: b, parent: body.parentName(b), group: R.groupOf(b), side: R.sideOf(b), mirror: R.mirrorName(b), axes: R.hint(b),
          limits_deg: Object.fromEntries(Object.entries(R.rigData.limits[b] || {}).map(([k, v]) => [k, v.map((x) => Math.round(x * DEG * 10) / 10)])),
          locked: app.doc.lockChannels(b), rest_world: m3(body.worldPos(b)) })),
        limbs: R.LIMBS, masks: Object.keys(R.MASKS), controls: R.rigData.controls.map((c) => c.name), sockets: Object.keys(app.sockSpecs),
        space: "world metres, fighter at the origin facing +Z (the Front view looks at its face), up is +Y; this rig's R bones sit on +X, L bones on -X",
        rotation: "per bone Euler degrees [x, y, z] on top of the rest, applied Z * Y * X (Blender XYZ); a bone missing from a key is at rest",
        rules: ["a knee never bends forward: kneeL / kneeR X stays >= 0 (the tools clamp it)", "thigh (legL / legR) X negative = leg forward; knee X positive = bends; foot X positive = toes down",
          "arm X negative = raised forward; elbow X negative = bends; armL Z negative / armR Z positive = arm out to the side", "torso / chest / head X positive = lean / nod forward; Y = twist; Z = side lean",
          "spins and flips turn the hips; hips dy moves the body up / down", "rolls reuse Vix's escape roll (City Breaker rule)", "fingers / tips / thumb close the whole hand"],
        workflow: "open_clip or new_clip -> set_pose / ik_pose / apply_pose / set_control (each keys by default) -> screenshot target=sheet -> checks -> save" };
    },
    list_fighters: () => app.fighters,
    set_fighter: async (p) => (app.fighters.includes(p.fighter) ? { ok: await app.setFighter(p.fighter) } : { error: "fighters: " + app.fighters.join(", ") }),
    panel: (p) => { app.ui.showPanel(String((p && p.title) || "")); return { title: String((p && p.title) || "") }; },
    rig_v5: (p) => app.v5Info(p && p.tier),
    set_tier: (p) => ({ ok: app.setBoneTier(String((p && p.tier) || "simple")) }),
    v5_controls: (p) => (app.v5 ? app.v5.controls((p && p.tier) || app.boneTier) : []),
    v5_control: (p) => app.applyV5Control(String(p.name || ""), Number(p.value || 0)),
    list_clips: (p) => app.listClips(p.filter || ""),
    open_clip: async (p) => {
      if (app.history.dirty() && !p.discard) return { error: `the open clip ${app.doc.name} has unsaved changes: save first, or pass discard: true` };
      return (await app.openClip(String(p.name || ""), true)) ? { opened: app.doc.name } : { error: "no clip named " + p.name };
    },
    new_clip: async (p) => {
      if (app.history.dirty() && !p.discard) return { error: `the open clip ${app.doc.name} has unsaved changes: save first, or pass discard: true` };
      if ((await window.host.clipExists(String(p.name))) && !p.overwrite) return { error: `a clip named ${p.name} exists (open it, or pass overwrite: true)` };
      if (!app.newClip(String(p.name || ""), Number(p.frames || 30), Number(p.fps || 30), !!p.loop, p.from_pose !== false, who)) return { error: "bad name (letters, digits, _ and -)" };
      return { created: app.doc.name, frames: app.doc.frames, fps: app.doc.fps };
    },
    save: () => app.save(who),
    save_as: (p) => app.saveAs(String(p.name || ""), who),
    get_clip: () => ({ ...app.doc.toDict(), saved: app.doc.saved, keys: app.doc.keys.map((k) => ({ ...k, rot: Object.fromEntries(Object.entries(k.rot || {}).map(([b, e]) => [b, deg3(e)])) })), units: "rot in degrees; hips_* in metres" }),
    set_clip: (p) => { for (const k of ["frames", "fps", "loop", "plant", "override", "ease", "note", "marks"]) if (p[k] !== undefined) app.setClipProp(k, p[k], who); return { frames: app.doc.frames, fps: app.doc.fps, loop: app.doc.loop }; },
    set_frame: (p) => { go(p); return { frame: app.frame }; },
    get_pose: (p) => {
      const frames = Array.isArray(p.frame) ? p.frame : [p.frame ?? app.frame];
      const want = p.bones || [];
      const out = {};
      for (const f of frames) {
        const body = app.stage.probe;
        let pose = p.final !== false ? app.finalPoseOn(body, Number(f)) : E.layerPose(app.doc, Number(f), app.bones);
        if (p.final === false) body.apply(pose);
        if (Math.abs(Number(f) - app.frame) < 1e-3 && app.pending) pose = app.pending;
        const bones = {};
        for (const b of want.length ? want : app.bones) { const e = pose[b] || [0, 0, 0]; if (want.length || Math.hypot(...e) > 1e-4) bones[b] = deg3(e); }
        const entry = { bones, hips: { dx: pose._dx || 0, dy: pose._dy || 0, dz: pose._dz || 0 }, is_key: app.doc.hasKey(Math.round(Number(f))) };
        if (p.world) entry.world = Object.fromEntries((want.length ? want : app.bones).filter((b) => body.has(b)).map((b) => [b, m3(body.worldPos(b))]));
        out[String(Math.round(Number(f)))] = entry;
      }
      return frames.length > 1 ? out : Object.values(out)[0];
    },
    set_pose: (p) => {
      go(p);
      const pose = app.editablePose();
      const bad = [], clamped = [];
      for (const b in p.bones || {}) {
        if (!app.bones.includes(b)) { bad.push(b); continue; }
        const v = p.radians ? v3(p.bones[b]) : rad3(p.bones[b]);
        const old = pose[b] || [0, 0, 0];
        const want = p.mode === "add" ? old.map((x, i) => x + v[i]) : v;
        const got = app.doc.guard(b, old, want);
        if (dist3(got, want) > 1e-6) clamped.push(b);
        pose[b] = got;
        if (p.mirror) { const mn = R.mirrorName(b); if (mn !== b) pose[mn] = app.doc.guard(mn, pose[mn] || [0, 0, 0], R.mirrorEuler(got)); }
      }
      for (const ax of ["dx", "dy", "dz"]) if (p.hips && p.hips[ax] !== undefined) pose["_" + ax] = (p.mode === "add" ? pose["_" + ax] || 0 : 0) + Number(p.hips[ax]);
      app.editPose(pose, `Agent pose f${Math.round(app.frame)}`, p.key !== false, who);
      const r = { frame: Math.round(app.frame), keyed: p.key !== false };
      if (bad.length) r.unknown_bones = bad;
      if (clamped.length) r.clamped_by_limits_or_locks = clamped;
      return r;
    },
    ik_pose: (p) => {
      go(p);
      if (!app.bones.includes(p.bone)) return { error: "no bone " + p.bone };
      const was = app.keepEnd;
      app.keepEnd = p.keep_end !== false;
      const t = new THREE.Vector3(...v3(p.target));
      app.dragBegin("Agent IK " + p.bone);
      app.dragIK(p.bone, t);
      app.keepEnd = was;
      app._dragStart = null;
      if (p.key !== false) app.keyNow(`Agent IK ${p.bone} f${Math.round(app.frame)}`, who);
      const got = app.keyedJoint(p.bone);   // the keys reach it (the view may show the arm pushed out of the body)
      return { frame: Math.round(app.frame), reached: m3(got), miss_m: Math.round(got.distanceTo(t) * 10000) / 10000 };
    },
    key: (p) => { go(p); const r = app.keyNow(`Key f${Math.round(app.frame)}`, who); for (const f of ["ease", "tag"]) if (p[f] !== undefined) app.setKeysField([Math.round(app.frame)], f, p[f], who); return r; },
    list_keys: () => app.doc.keys.map((k) => ({ f: k.f, ease: k.ease || app.doc.ease, tag: k.tag || "key", link: k.link || "", lock: !!k.lock, bones: Object.keys(k.rot || {}) })),
    delete_keys: (p) => { app.deleteKeys(ints(p.frames), who); return { keys: app.doc.keyFrames() }; },
    move_keys: (p) => (app.moveKeys(ints(p.frames), Number(p.delta || 0), who) ? { keys: app.doc.keyFrames() } : { error: "keys cannot land on other keys, before frame 0, or move while locked" }),
    set_keys: (p) => { for (const f of ["ease", "tag", "lock"]) if (p[f] !== undefined) app.setKeysField(ints(p.frames), f, p[f], who); return { ok: true }; },
    set_key_values: (p) => {
      const f = Math.round(Number(p.frame)), k = app.doc.keyAt(f);
      if (!k) return { error: `no key at f${f} (use set_pose with key: true to make one)` };
      if (k.lock) return { error: `the key at f${f} is locked` };
      const before = poseOfKey(k, app.bones), after = { ...before };
      for (const b in p.bones || {}) if (app.bones.includes(b)) after[b] = app.doc.guard(b, before[b], rad3(p.bones[b]));
      for (const ax of ["dx", "dy", "dz"]) if (p.hips && p.hips[ax] !== undefined) after["_" + ax] = Number(p.hips[ax]);
      let updated = [];
      app.mutate(`Agent edit key f${f}`, () => { app.doc.writeKey(f, after, app.bones); if (app.propagate !== "off") updated = app.doc.propagate(f, before, after, app.bones, app.propagate); }, who);
      return { frame: f, also_updated: updated };
    },
    link_keys: (p) => { app.linkKeys(ints(p.frames), who); return { keys: app.doc.keys.map((k) => [k.f, k.link || ""]) }; },
    unlink_keys: (p) => { app.unlinkKeys(ints(p.frames), who); return { ok: true }; },
    same_keys: (p) => app.doc.partners(Math.round(Number(p.frame || 0)), app.bones, true),
    set_propagate: (p) => { if (!["off", "linked", "pose", "bone"].includes(p.mode)) return { error: "mode: off | linked | pose | bone" }; app.propagate = p.mode; app.emit("tool"); return { propagate: app.propagate }; },
    insert_frames: (p) => { app.insertFrames(Number(p.at || 0), Number(p.count || 1), who); return { frames: app.doc.frames, keys: app.doc.keyFrames() }; },
    delete_frames: (p) => { app.deleteFrames(Number(p.at || 0), Number(p.count || 1), who); return { frames: app.doc.frames, keys: app.doc.keyFrames() }; },
    scale_time: (p) => { app.scaleTime(Number(p.factor || 1), ints(p.frames), who); return { frames: app.doc.frames, keys: app.doc.keyFrames() }; },
    reverse: (p) => { app.reverseRange(Number(p.from || 0), Number(p.to ?? app.doc.frames), who); return { keys: app.doc.keyFrames() }; },
    close_loop: () => { app.closeLoop(who); return { keys: app.doc.keyFrames() }; },
    mirror_pose: (p) => { go(p); app.poseMirror(p.mode || "l2r", who); return maybeKey(p); },
    reset_bones: (p) => { go(p); app.resetBones(p.bones || [], who); return maybeKey(p); },
    breakdown: (p) => { go(p); app.breakdown(Number(p.t ?? 0.5), who); return maybeKey(p); },
    list_poses: () => app.listPoses(),
    save_pose: async (p) => { const prev = app.selBones; if (p.bones) app.selBones = p.bones; const ok = await app.saveLibraryPose(String(p.name || ""), !!p.bones); app.selBones = prev; return { saved: ok }; },
    apply_pose: async (p) => {
      go(p);
      const prev = app.selBones;
      if (p.bones) app.selBones = p.bones;
      const ok = await app.applyLibraryPose(String(p.name || ""), !!p.bones, Number(p.weight ?? 1), !!p.mirror, who);
      app.selBones = prev;
      return ok ? maybeKey(p) : { error: "no pose named " + p.name };
    },
    list_controls: (p) => { go(p); const pose = app.editablePose(); return R.rigData.controls.map((c) => ({ name: c.name, value: Math.round(R.controlValue(c, pose) * 1000) / 1000, min: c.min, max: c.max, drives: c.drives })); },
    set_control: (p) => { go(p); const c = R.rigData.controls.find((x) => x.name === p.name); if (!c) return { error: "no control named " + p.name }; app.setControl(c, Number(p.value || 0), who); return maybeKey(p); },
    add_control: async (p) => {
      const drives = (p.drives || []).map((d) => { const i = ["x", "y", "z"].indexOf(String(d[1])); return [String(d[0]), i >= 0 ? i : String(d[1]), i >= 0 ? Number(d[2]) * RAD : Number(d[2])]; });
      R.rigData.controls.push({ name: String(p.name || "control"), min: Number(p.min ?? -1), max: Number(p.max ?? 1), drives });
      await R.saveRigData();
      app.emit("fighter");
      return { controls: R.rigData.controls.length };
    },
    list_layers: () => app.doc.layers,
    add_layer: (p) => { const d = { ...p }; if (typeof d.mask === "string") d.mask = R.MASKS[d.mask] || []; return app.addLayer(d, who); },
    set_layer: async (p) => { const d = { ...p }; delete d.id; if (typeof d.mask === "string") d.mask = R.MASKS[d.mask] || []; await app.setLayer(p.id, d, who); return app.doc.layerById(p.id); },
    remove_layer: (p) => { app.removeLayer(p.id, who); return { layers: app.doc.layers.length }; },
    set_active_layer: (p) => { app.setActiveLayer(p.id || ""); return { active_layer: app.activeLayer }; },
    merge: async (p) => {
      if (p.base && String(p.base) !== app.doc.name) {
        if (app.history.dirty() && !p.discard) return { error: `the open clip ${app.doc.name} has unsaved changes: save first, or pass discard: true` };
        if (!(await app.openClip(String(p.base), true))) return { error: "no clip named " + p.base };
      }
      const made = [];
      for (const c of p.clips || []) {
        const l = await app.mergeAdd(String(c.clip || ""), c.parts || M.DEFAULT_PARTS, Number(c.start ?? 0), Number(c.blend_in ?? 10), Number(c.blend_out ?? 10), Number(c.weight ?? 1), !!c.cycle, who);
        if (!l) return { error: "no clip named " + c.clip, layers: made };
        made.push(l);
      }
      const out = { base: app.doc.name, layers: made, frames: M.length(app.doc) };
      if (p.bake) out.baked = app.mergeBake(String(p.name || app.doc.name + "_merged"), who);
      return out;
    },
    merge_add: async (p) => (await app.mergeAdd(String(p.clip || ""), p.parts || M.DEFAULT_PARTS, Number(p.start ?? -1), Number(p.blend_in ?? 10), Number(p.blend_out ?? 10), Number(p.weight ?? 1), !!p.cycle, who)) || { error: "no clip named " + p.clip },
    merge_set: async (p) => { const d = { ...p }; delete d.id; await app.mergeSet(String(p.id || ""), d, who); return app.doc.layerById(String(p.id || "")); },
    merge_bake: (p) => app.mergeBake(String(p.name || app.doc.name + "_merged"), who),
    show_panel: (p) => { app.ui.showPanel(String(p.title || "")); return { shown: String(p.title || "") }; },
    adjust: (p) => {
      const ls = app.adjustPart(String(p.bone || ""), [p.x, p.y, p.z].map((x) => Number(x || 0) * RAD), String(p.scope || "all"), Number(p.frame ?? -1), Number(p.from ?? 0), Number(p.to ?? -1), Number(p.ease ?? 6), !!p.mirror, who);
      return { layers: ls.map((l) => A.describe(l)) };
    },
    adjust_restore: (p) => ({ restored: app.adjustRestore(String(p.id || ""), String(p.bone || ""), who) }),
    adjustments: () => A.adjustLayers(app.doc).map((l) => ({ id: l.id, bone: l.bone || "", scope: l.scope || "", start: l.start || 0, end: l.end ?? -1,
      turn: A.value(l).map((x) => Math.round(x * DEG * 100) / 100), text: A.describe(l) })),
    fill: (p) => app.fillApply({ ...p }, who),
    fill_matches: (p) => app.fillMatches(p),
    fill_remove: (p) => ({ removed: app.fillRemove(String(p.id || ""), who) }),
    fill_real: (p) => app.fillRealFolder("folder" in p ? String(p.folder ?? "") : null),
    alive: (p) => app.aliveAdd({ ...p }, who),
    alive_remove: () => ({ removed: app.aliveRemove(who) }),
    gait: (p) => app.gaitAdd({ ...p }, who),
    gait_remove: () => ({ removed: app.gaitRemove(who) }),
    balance: (p) => app.balanceAdd({ ...p }, who),
    balance_remove: () => ({ removed: app.balanceRemove(who) }),
    fills: () => app.doc.fills.map((fl) => ({ ...structuredClone(fl), text: FL.describe(fl) })),
    fx_blocks: (p) => app.fx.blockList(String(p.query || "")),
    fx_cues: () => app.fx.list(),
    fx_add: async (p) => {
      const q = { ...p };
      if (q.frame === undefined && q.t === undefined) q.frame = app.frame;
      if (q.socket && q.socket !== "origin" && !app.sockSpecs[q.socket]) return { error: `no socket ${q.socket} (have origin, ${Object.keys(app.sockSpecs).join(", ")})` };
      const i = await app.fx.add(q);
      if (i < 0) return { error: `no block ${p.id} in the RMT effect library (fx_blocks lists them)` };
      app.emit("api");
      return { index: i };
    },
    fx_edit: async (p) => {
      const i = Number(p.index ?? -1);
      if (i < 0 || i >= app.fx.count()) return { error: "no cue " + i };
      await app.fx.edit(i, p);
      return app.fx.describe(i);
    },
    fx_remove: (p) => {
      const i = Number(p.index ?? -1);
      if (i < 0 || i >= app.fx.count()) return { error: "no cue " + i };
      app.fx.remove(i);
      return app.fx.list();
    },
    fx_save: async () => ((await app.fx.save()) ? { clip: app.fx.clip, cues: app.fx.count() } : { error: "save the clip first (cues are kept by its name)" }),
    fx_measure: (p) => { go(p); return app.fx.measure(); },
    fx_studio_godot: async (p) => ((await app.fx.openStudio(String(p.effect || ""))) ? { fighter: app.fighter, clip: app.doc.name, frame: app.frame } : { error: "Godot not found (FIGHT_STUDIO_GODOT)" }),
    feet: (p) => {
      if (p.planted !== undefined && !!p.planted !== app.doc.plant) app.setClipProp("plant", !!p.planted, who);
      return app.feetReport(Number(p.step || 1));
    },
    list_constraints: () => app.doc.constraints,
    add_constraint: (p) => app.addConstraint(conDef(p), who),
    set_constraint: (p) => { const d = conDef(p); delete d.id; app.setConstraint(p.id, d, who); return app.doc.constraintById(p.id); },
    remove_constraint: (p) => { app.removeConstraint(p.id, who); return { constraints: app.doc.constraints.length }; },
    freeze: (p) => { const fr = Number(p.from ?? Math.round(app.frame)); return app.addConstraint({ type: "pin", bone: p.bone, what: p.what || "both", pin_frame: fr, start: fr, end: Number(p.to ?? -1), name: "FREEZE " + p.bone }, who); },
    bake_to_keys: () => { app.bakeToKeys(who); return { keys: app.doc.keys.length }; },
    lock: (p) => { for (const b of p.bones || []) app.setLock(b, p.channels || "xyz", who); return app.doc.locks; },
    unlock: (p) => { for (const b of p.bones || []) app.setLock(b, "", who); return app.doc.locks; },
    list_sockets: () => Object.fromEntries(Object.keys(app.sockSpecs).map((n) => [n, { bone: app.sockSpecs[n].bone, world: m3(app.socketWorld(n)) }])),
    list_props: () => app.doc.props,
    add_prop: (p) => {
      const shape = String(p.shape || "block");
      const pr = { id: newId(app.doc.props, "prop"), name: String(p.name || shape), shape, socket: String(p.socket || "fist_R"), offset: p.offset || [0, 0, 0],
        rot: p.rot || [0, 0, 0], scale: Number(p.scale ?? 1), color: String(p.color || "#9a9aa2") };
      if (p.grip) pr.grip = String(p.grip);
      if (p.size) pr.size = p.size;
      app.mutate("Add prop " + shape, () => app.doc.props.push(pr), who);
      return { id: pr.id };
    },
    set_prop: (p) => { app.mutate("Prop " + p.id, () => { const x = app.doc.props.find((q) => q.id === p.id); if (x) for (const k in p) if (k !== "id") x[k] = p[k]; }, who); return app.doc.props; },
    remove_prop: (p) => {
      if (p.all) app.mutate("Remove props", () => app.doc.props.splice(0), who);
      else app.mutate("Remove prop", () => app.doc.removeById(app.doc.props, String(p.id || "")), who);
      return app.doc.props;
    },
    add_marker: (p) => { const f = Number(p.frame ?? Math.round(app.frame)); app.mutate("Marker " + p.name, () => app.doc.addMarker(f, String(p.name || "marker")), who); return app.doc.markers; },
    // the FX Studio (the FX mode): open a block, read it, set one setting of it, play / scrub, save, revert
    fx_studio: async (p) => {
      const st = app.fxs;
      if (p.open) { if (!(await st.open(String(p.open)))) throw new Error("no effect block " + p.open); }
      if (p.set) {
        const path = Array.isArray(p.set.path) ? p.set.path : String(p.set.path).split(".");
        const lay = p.set.layer === undefined ? null : typeof p.set.layer === "number" ? st.layers()[p.set.layer] : st.layers().find((l) => l.name === p.set.layer);
        if (p.set.layer !== undefined && !lay) throw new Error("no layer " + p.set.layer);
        setAt(lay || st.manifest, path, p.set.value);
        st.refreshPhases();
        st.changed(true, true);
      }
      if (p.select !== undefined) st.select(typeof p.select === "number" ? p.select : st.layers().findIndex((l) => l.name === p.select));
      if (p.fold) { for (const [k, v] of Object.entries(p.fold)) st.fold.set(k, !!v); app.emit("fxstudio"); }
      if (p.add_layer) st.addLayer(String(p.add_layer));
      if (p.remove_layer !== undefined) st.removeLayer(typeof p.remove_layer === "number" ? p.remove_layer : st.layers().findIndex((l) => l.name === p.remove_layer));
      if (p.time !== undefined) st.scrub(Number(p.time));
      if (p.play !== undefined) { st.playing = !!p.play; }
      if (p.at) { st.at = String(p.at); st.seekNow(); }
      if (p.revert) await st.revert();
      if (p.save) await st.save();
      await st.rebuildNow();
      return { id: st.id, status: st.status(), duration: st.duration(), time: st.time, at: st.at, error: st.err,
        layers: st.layers().map((l) => ({ name: l.name, kind: l.kind, span: layerSpan(l, st.manifest.phases, st.duration()) })), manifest: p.manifest ? st.manifest : undefined };
    },
    // the Setup mode: the steps and what is left; fix runs a step's fix (or all of them) only with yes: true, else it says the plan
    setup: async (p) => {
      const st = app.setup;
      await st.refreshInfo();
      const brief = (s) => ({ id: s.id, n: s.n, ok: s.ok, soft: !!s.soft, stale: !!s.stale, note: s.note, fix: s.fix ? { label: s.fix.label, plan: s.fix.plan, confirm: !!s.fix.confirm } : null, more: (s.more || []).map((c) => c.text) });
      let ran;
      if (p.new_move) ran = st.newMove(String(p.new_move));
      if (p.fix) {
        const plan = p.fix === "all" ? st.planAll() : st.plan(String(p.fix));
        if (!p.yes) return { needs_yes: true, plan: plan || "nothing to fix", say: "run it again with yes: true to do this" };
        ran = p.fix === "all" ? await st.fixAll({ effects: !!p.effects, save: p.save !== false }) : await st.fix(String(p.fix), { name: p.name, save: p.save !== false });
      }
      return { fighter: app.fighter, clip: app.doc.name, ran, steps: st.steps().map(brief), log: st.log.slice(-10) };
    },
    // the Review mode: the verdict on the open move (reads only); sheet: true also renders the contact sheet
    review: async (p) => {
      const rep = app.review ? app.review.run() : buildReport(app);
      const out = { ...rep };
      if (p.sheet) out.sheet = (await app.ui.picture("sheet", 1920, 1080, 8)) || "";
      return out;
    },
    // the Compose mode: recipes (plan first, apply: true to put the cues on the clip), snaps, nudges, shifts, undo
    compose: async (p) => {
      const st = app.compose;
      let did;
      if (p.recipe) {
        if (!RECIPES.some((r) => r.id === p.recipe)) throw new Error("recipes: " + RECIPES.map((r) => r.id).join(", "));
        if (!p.apply) return { plan: st.plan(String(p.recipe)), say: "run it again with apply: true to put these cues on the clip" };
        did = await st.apply(String(p.recipe));
      }
      if (p.snap) did = await st.snap(Number(p.snap.index), String(p.snap.to));
      if (p.nudge) did = await st.nudge(Number(p.nudge.index), Number(p.nudge.frames));
      if (p.shift_all !== undefined) did = await st.shiftAll(Number(p.shift_all));
      if (p.align) did = await st.alignToHit();
      if (p.swap_side !== undefined) did = await st.swapSide(Number(p.swap_side));
      if (p.duplicate !== undefined) did = await st.duplicate(Number(p.duplicate));
      if (p.remove !== undefined) did = await st.remove(Number(p.remove));
      if (p.undo) did = await st.undo();
      if (p.save) { const ok = await app.fx.save(); did = { ok, text: ok ? `Saved the effect cues of ${app.fx.clip}.` : "Save the clip first (the cues are kept by its name)." }; }
      st.fresh();
      return { fighter: app.fighter, clip: app.doc.name, did, recipes: st.recipes().map((r) => ({ id: r.id, title: r.title, ok: r.ok, why: r.why, fresh: r.fresh ?? 0, cues: r.cues })),
        cues: app.fx.list(), sheet: st.sheet(), undo: st.stack.map((s) => s.label), dirty: app.fx.dirty };
    },
    set_mode: (p) => {
      if (p.mode && !app.ui.setMode(String(p.mode).toUpperCase())) throw new Error("modes: " + Object.keys(MODES).join(", "));
      return { mode: app.ui.mode, layout: app.views.main.layout, panels: [...app.ui.panels].filter(([, q]) => !q.hidden).map(([t]) => t) };
    },
    set_view: (p) => {
      const vh = app.views.main;
      if (p.layout) vh.setLayout(String(p.layout));
      if (p.preset) { const v = vh.views[Number(p.index || 0)]; if (v) { v.setPreset(p.preset); if (p.ortho !== undefined) { v.ortho = !!p.ortho; v.update(); } } }
      if (p.onion !== undefined) { app.onion.on = !!p.onion; app.applyNow(); }
      if (p.wrap !== undefined || p.wrap_caps !== undefined) {
        if (p.wrap !== undefined) app.show.wrap = !!p.wrap;
        if (p.wrap_caps !== undefined) app.show.wrapCaps = !!p.wrap_caps;
        app.applyNow();
        app.views.stripDirty();
      }
      if (p.tool) app.setTool(p.tool);
      if (p.bone) app.selectBone(p.bone);
      if (p.focus_bone !== undefined || p.yaw !== undefined || p.pitch !== undefined || p.dist !== undefined) {
        const v = vh.views[Number(p.index || 0)];
        if (v) {
          if (p.yaw !== undefined) v.yaw = Number(p.yaw) * RAD;
          if (p.pitch !== undefined) v.pitch = Number(p.pitch) * RAD;
          if (p.focus_bone && app.stage.body.has(String(p.focus_bone))) v.target.copy(app.jointWorld(String(p.focus_bone)));
          if (p.dist !== undefined) v.dist = Number(p.dist);
          v.update();
          vh.focused = v;   // the view a screenshot target=view uses
        }
      }
      app.emit("tool");
      return { layout: vh.layout, views: vh.views.map((v) => v.preset), wrap: app.show.wrap, wrap_caps: app.show.wrapCaps };
    },
    screenshot: async (p) => {
      const kind = p.target || "sheet";
      if (kind === "window") {
        app.views.render(true);
        await new Promise((r) => requestAnimationFrame(() => r()));
        const path = await window.host.captureWindow(p.path || "");
        return path ? { path } : { error: "could not capture" };
      }
      if (kind === "view" && p.index !== undefined) app.views.main.focused = app.views.main.views[Number(p.index)] || app.views.main.focused;
      const path = await app.ui.picture(kind === "view" ? "view" : "sheet", Number(p.width || 1920), Number(p.height || 1080), Number(p.cols || 8), p.path || "");
      return path ? { path } : { error: "render failed" };
    },
    import_motion: async (p) => {
      if (app.history.dirty() && !p.discard) return { error: `the open clip ${app.doc.name} has unsaved changes: save first, or pass discard: true` };
      const opts = { ...p };
      delete opts.path;
      delete opts.discard;
      return app.importMotion(String(p.path || ""), opts, who);
    },
    checks: () => app.runChecks(),
    wrap_report: (p) => app.wrapReport(p.top === undefined ? 6 : Number(p.top), Number(p.tol_cm ?? 1)),
    wrap_state: (p) => {
      go(p);
      const st = app.wrapStats;
      return { on: app.show.wrap && !!st, frame: app.frame, max_corr_deg: st ? Math.round(st.max_corr * DEG * 10) / 10 : 0, max_corr_bone: st ? st.max_corr_bone : "",
        contacts: st ? st.contacts : 0, lift_cm: st ? Math.round(st.lift / app.matchScale * 1000) / 10 : 0,
        clashing: st ? [...app.wrapClashNow(app.stage.body)].map((i) => app.solverOf(app.stage.body).wrap.pieces[i].id) : [] };
    },
    transition_clip: async (p) => {
      if (app.history.dirty() && !p.discard) return { error: "save the open clip first (or pass discard: true)" };
      return { ok: await app.makeTransitionClip(String(p.clip_b || ""), Number(p.at || 0), Number(p.blend ?? 6), String(p.name || "transition"), who), clip: app.doc.name };
    },
    undo: () => { app.undo(); return { keys: app.doc.keyFrames() }; },
    redo: () => { app.redo(); return { keys: app.doc.keyFrames() }; },
    history: () => app.history.labels(60),
    say: (p) => { app.say("Agent: " + (p.message || ""), "agent"); app.agentFlash = 1; app.views.dirty(); return { shown: true }; },
    bake_glb: async () => (app.history.dirty() ? { error: "save the clip first: the bake reads the saved files" } : window.host.bakeAnimato(app.fighter)),
  };

  async function windowShot() {
    app.views.render(true);
    const c = app.views.main;
    const out = document.createElement("canvas");
    out.width = c.gl.width;
    out.height = c.gl.height;
    const g = out.getContext("2d");
    g.drawImage(c.gl, 0, 0);
    g.drawImage(c.ov, 0, 0, out.width, out.height);
    return out.toDataURL("image/png").split(",")[1];
  }

  function conDef(p) {
    const d = structuredClone(p);
    for (const f of ["min_deg", "max_deg"]) if (d[f]) { d[f.slice(0, 3)] = rad3(d[f]); delete d[f]; }
    if (Array.isArray(d.target)) d.target = { pos: d.target };
    return d;
  }

  return async function call(method, params) {
    if (method === "__health") return { ok: true, result: { fighter: app.fighter, clip: app.doc.name } };
    if (method === "__methods") return { ok: true, result: METHODS };
    if (method === "__can_close") {
      if (!app.history.dirty()) return { ok: true, result: true };
      return { ok: true, result: await window.host.confirm(`"${app.doc.name}" has changes that are not saved. Quit anyway?`) };
    }
    let out;
    if (!D[method]) out = { ok: false, error: `unknown method ${method} (GET /methods lists them)` };
    else {
      try {
        const r = await D[method](params || {});
        out = r && typeof r === "object" && !Array.isArray(r) && r.error && r.ok === undefined ? { ok: false, error: r.error } : { ok: true, result: r };
      } catch (e) {
        out = { ok: false, error: String(e && e.message ? e.message : e) };
      }
    }
    const s = JSON.stringify(params || {});
    app.apiLog.push({ time: new Date().toLocaleTimeString(), method, summary: s.length > 140 ? s.slice(0, 140) + "..." : s, ok: out.ok });
    if (!out.ok) app.say(`Agent call ${method} failed: ${out.error}`, "warn");
    app.emit("api");
    return out;
  };
}
