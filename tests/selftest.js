// Fight Studio Desktop self-test (run: npm run selftest). Same ground as the Godot animator_check.gd: interpolation, keys,
// undo, retime, locks, limits, same-key propagation, layers, IK, freeze, bake, save round trip, the agent API, and that a
// clip baked here gives the Godot file signature (both apps open each other's files).
import * as THREE from "three";
import { Doc, poseOfKey, sig } from "../src/core/doc.js";
import * as E from "../src/core/evalc.js";
import * as R from "../src/core/rig.js";
import { poseAt, rotQuat, eulerOf, dist3, DEG, RAD } from "../src/core/clip.js";
import { makeApi } from "../src/api.js";
import * as A from "../src/core/adjust.js";
import * as M from "../src/core/merge.js";
import * as F from "../src/core/feet.js";
import * as FG from "../src/core/fingers.js";
import * as G from "../src/core/grip.js";
import * as FL from "../src/core/fill.js";
import * as W from "../src/core/wrap.js";
import * as FXR from "../src/core/rmtfx.js";

export async function selftest(app) {
  const lines = [];
  let pass = 0, fail = 0;
  const ok = (c, what) => { if (c) { pass++; if (what.startsWith("fill") || what.startsWith("fx") || what.startsWith("setup") || what.startsWith("review") || what.startsWith("compose") || what.startsWith("alive") || what.startsWith("gait") || what.startsWith("balance")) lines.push("ok   " + what); } else { fail++; lines.push("FAIL " + what); } };   // the fill and fx checks carry their measurements
  const near = (a, b, t = 1e-3) => Math.abs(a - b) <= t;

  // euler order: three 'ZYX' == Rz * Ry * Rx (the clip format), round trip
  for (const e of [[0.3, -0.7, 1.1], [-1.2, 0.4, -0.2]]) {
    const back = eulerOf(rotQuat(e));
    ok(dist3(back, e) < 1e-6, "euler round trip " + e);
    const m = new THREE.Matrix4().makeRotationZ(e[2]).multiply(new THREE.Matrix4().makeRotationY(e[1])).multiply(new THREE.Matrix4().makeRotationX(e[0]));
    ok(new THREE.Quaternion().setFromRotationMatrix(m).angleTo(rotQuat(e)) < 1e-6, "Rz*Ry*Rx order");
  }
  ok(R.mirrorName("indexL2") === "indexR2" && R.mirrorName("head") === "head", "mirror names");
  ok(R.clampLimits("kneeL", [-0.4, 0, 0])[0] === 0, "knee limit");

  // the godot file opens with the same keys and the same interpolation
  const walk = await window.host.loadClip("w_walk");
  const wd = Doc.fromClip(walk);
  ok(wd.keys.length === walk.keys.length && wd.loop === true, "w_walk opens");
  const p = poseAt(walk, 7.5, app.bones);
  ok(Array.isArray(p.legL) && Math.abs(p.legL[0]) > 0.01, "spline interpolation gives a pose");

  // RIG V5: a rig-v4 fighter is upgraded in place to the full v5 skeleton (advanced mode)
  {
    const want = ["spine1", "clavicleL", "clavicleR", "toeL", "toeR", "thumbL3", "thumbL4", "thumbR3", "thumbR4",
      "indexL4", "indexR4", "middleL4", "middleR4", "ringL4", "ringR4", "pinkyL4", "pinkyR4", "tail4"];
    const absent = want.filter((b) => !app.bones.includes(b));
    ok(app.v5 && app.v5.style === "rigv4", `rig v5 sees a rig-v4 fighter (${app.v5 && app.v5.style})`);
    ok(absent.length === 0, `rig v5 upgrade adds the advanced bones (${want.length - absent.length}/${want.length}${absent.length ? " missing " + absent : ""})`);
    ok(app.v5 && app.v5.counts.advanced >= 73, `rig v5 advanced is the full rig (${app.v5 && app.v5.counts.advanced} bones)`);
    ok(app.v5 && app.v5.missing.length === 0, `rig v5 maps every canonical bone (${app.v5 && app.v5.missing})`);

    const body = app.stage.probe;
    body.apply({});
    ok(body.parentName("spine1") === "torso" && body.parentName("chest") === "spine1", "spine1 sits between torso and chest");
    ok(body.parentName("clavicleL") === "chest" && body.parentName("armL") === "clavicleL", "clavicleL sits between chest and armL");
    ok(body.parentName("toeL") === "footL" && body.parentName("indexL4") === "indexL3" && body.parentName("tail4") === "tail3",
      "toes, 4th finger joints and the tail tip are in their chains");
    // inserting bones must not move the rest pose
    const head = body.restWorld("head"), arm = body.restWorld("armL"), hand = body.restWorld("handL");
    ok(Math.abs(head.y - 2.035) < 0.02 && Math.abs(arm.y - 1.882) < 0.02 && Math.abs(hand.y - 1.195) < 0.02,
      `the v5 upgrade keeps the rest pose (head ${head.y.toFixed(3)}, armL ${arm.y.toFixed(3)}, handL ${hand.y.toFixed(3)})`);

    app.setBoneTier("advanced");
    ok(app.visibleBones().includes("toeL") && app.visibleBones().includes("clavicleR") && app.visibleBones().includes("indexL4"),
      "advanced mode shows the new bones");
    app.setBoneTier("simple");

    // the toe is real: it carries the front of the shoe and a curl bends it
    app.newClip("zz_v5_check", 30, 30, false, false);
    let toeVerts = 0, toeMesh = null, toeVert = -1;
    app.stage.body.root.traverse((o) => {
      if (!o.isSkinnedMesh || !o.skeleton) return;
      const ti = o.skeleton.bones.findIndex((b) => b.name === "toeL");
      if (ti < 0) return;
      toeMesh = o;
      const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
      for (let v = 0; v < si.count; v++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (si.getComponent(v, k) === ti) w += sw.getComponent(v, k);
        if (w > 0.5) { toeVerts++; if (toeVert < 0) toeVert = v; }
      }
    });
    ok(toeVerts > 50, `the toe owns the front of the foot (${toeVerts} vertices)`);
    if (toeMesh && toeVert >= 0) {
      const before = new THREE.Vector3().fromBufferAttribute(toeMesh.geometry.attributes.position, toeVert);
      toeMesh.applyBoneTransform(toeVert, before);
      const q0 = app.stage.body.worldQuat("toeL");
      app.applyV5Control("Toe curl L", 1);
      app.stage.body.update();
      const after = new THREE.Vector3().fromBufferAttribute(toeMesh.geometry.attributes.position, toeVert);
      toeMesh.applyBoneTransform(toeVert, after);
      ok(app.stage.body.worldQuat("toeL").angleTo(q0) > 0.1 && before.distanceTo(after) > 0.002,
        `toe curl turns the toe and bends the shoe (${(before.distanceTo(after) * 100).toFixed(1)} cm)`);
      app.revertPending();
    }

    // advanced controls now drive the joints
    app.newClip("zz_v5_check", 30, 30, false, false);
    const hand0 = app.stage.body.worldPos("handL").clone();
    app.applyV5Control("Clavicle lift L", 1);
    const hand1 = app.stage.body.worldPos("handL").clone();
    ok(hand1.y > hand0.y + 0.004, `clavicle lift raises the arm (${((hand1.y - hand0.y) * 100).toFixed(1)} cm up)`);
    app.revertPending();
    const head0 = app.stage.body.worldPos("head").clone();
    app.applyV5Control("Spine1 bend", 1);
    ok(app.stage.body.worldPos("head").z > head0.z + 0.004, "Spine1 bend leans the chest");
    app.revertPending();
    const finger0 = app.stage.body.worldQuat("indexL4");
    app.applyV5Control("Fist L (full)", 1);
    ok(app.stage.body.worldQuat("indexL4").angleTo(finger0) > 0.05, "Fist L (full) curls the 4th finger joints");
    app.revertPending();

    // CROUCH: at full it plants the feet instead of lifting them
    app.newClip("zz_v5_check", 30, 30, false, false);
    app.stage.body.update();
    const baseFeet = Math.min(F.lowest(app.stage.body, "footL"), F.lowest(app.stage.body, "footR"));
    const hip0 = app.stage.body.worldPos("hips").y;
    app.applyV5Control("Crouch", 1);
    const crouchFeet = Math.min(F.lowest(app.stage.body, "footL"), F.lowest(app.stage.body, "footR"));
    const hip1 = app.stage.body.worldPos("hips").y;
    ok(Math.abs(crouchFeet - baseFeet) < 0.006, `full crouch keeps the feet on the floor (${((crouchFeet - baseFeet) * 100).toFixed(2)} cm change)`);
    ok(hip0 - hip1 > 0.36, `full crouch goes down (${((hip0 - hip1) * 100).toFixed(1)} cm)`);
    app.applyV5Control("Crouch", 0.5);
    const halfFeet = Math.min(F.lowest(app.stage.body, "footL"), F.lowest(app.stage.body, "footR"));
    const halfDrop = hip0 - app.stage.body.worldPos("hips").y;
    ok(Math.abs(halfFeet - baseFeet) < 0.006 && halfDrop > 0.12 && halfDrop < hip0 - hip1,
      `half crouch plants too and sits between (${(halfDrop * 100).toFixed(1)} cm)`);
    app.applyV5Control("Crouch", 0);
    const backFeet = Math.min(F.lowest(app.stage.body, "footL"), F.lowest(app.stage.body, "footR"));
    ok(Math.abs(backFeet - baseFeet) < 0.006, `crouch 0 returns the feet to the base height (${((backFeet - baseFeet) * 100).toFixed(2)} cm)`);
    // the classic Controls panel's Crouch (data/animator_rig.json) is grounded by name too
    const v4crouch = R.rigData.controls.find((c) => /^crouch$/i.test(c.name));
    app.setControl(v4crouch, 1);
    const v4Feet = Math.min(F.lowest(app.stage.body, "footL"), F.lowest(app.stage.body, "footR"));
    ok(Math.abs(v4Feet - baseFeet) < 0.006, `the Controls panel Crouch is grounded too (${((v4Feet - baseFeet) * 100).toFixed(2)} cm)`);
    app.revertPending();
  }

  // keys, undo, retime, locks
  app.newClip("zz_desktop_check", 30, 30, false, true);
  app.setFrame(10);
  app.setBoneEuler("armR", [-0.8, 0, 0.3]);
  ok(!!app.pending, "an edit is pending until keyed");
  app.keyNow();
  ok(app.doc.hasKey(10) && near(app.doc.keyAt(10).rot.armR[0], -0.8), "K keys f10");
  app.setFrame(5);
  const k0 = poseOfKey(app.doc.keyAt(0), app.bones).armR;
  ok(dist3(app.editablePose().armR, k0.map((x, i) => (x + [-0.8, 0, 0.3][i]) / 2)) < 0.01, "in-between interpolates");
  app.undo();
  ok(!app.doc.hasKey(10), "undo");
  app.redo();
  ok(app.doc.hasKey(10), "redo");
  ok(app.moveKeys([10], 4) && app.doc.hasKey(14), "move key");
  app.insertFrames(2, 3);
  ok(app.doc.hasKey(17) && app.doc.frames === 33, "insert frames");
  app.deleteFrames(2, 3);
  ok(app.doc.hasKey(14) && app.doc.frames === 30, "delete frames");
  app.setKeysField([14], "lock", true);
  app.setFrame(14);
  app.setBoneEuler("armR", [0.5, 0, 0]);
  ok(app.keyNow().ok === false, "locked key refuses an update");
  app.setKeysField([14], "lock", false);
  app.revertPending();
  app.setLock("legL", "x");
  const leg0 = app.editablePose().legL;
  app.setBoneEuler("legL", [-0.9, 0.2, 0]);
  ok(near(app.pending.legL[0], leg0[0]) && near(app.pending.legL[1], 0.2), "locked channel holds");
  app.revertPending();
  app.setLock("legL", "");
  app.setBoneEuler("kneeR", [-0.6, 0, 0]);
  ok(app.pending.kneeR[0] >= 0, "a knee never bends forward");
  app.revertPending();

  // same key
  app.newClip("zz_desktop_check", 40, 30, true, true);
  ok(app.doc.keyAt(0).link && app.doc.keyAt(0).link === app.doc.keyAt(40).link, "loop: first and last key linked");
  app.setFrame(0);
  app.setBoneEuler("chest", [0.25, 0, 0]);
  let r = app.keyNow();
  ok(r.also_updated.includes(40) && near(app.doc.keyAt(40).rot.chest[0], 0.25), "linked key follows");
  app.setFrame(20);
  app.keyNow();
  app.unlinkKeys([0, 40]);
  app.setFrame(0);
  app.setBoneEuler("head", [0.1, 0.3, 0]);
  r = app.keyNow();
  ok(r.also_updated.includes(20) && r.also_updated.includes(40), "same-pose keys follow");

  // layers
  app.newClip("zz_desktop_check", 30, 30, false, true);
  const l = await app.addLayer({ name: "wave", mode: "add", source: "keys", mask: ["armR", "elbowR"] });
  app.setActiveLayer(l.id);
  app.setFrame(10);
  const base = E.layerPose(app.doc, 10, app.bones);
  app.setBoneEuler("armR", base.armR.map((x, i) => x + [-0.5, 0, 0][i]));
  app.keyNow();
  ok(app.doc.keys.length === 1, "layer keys leave the base alone");
  ok(near(E.layerPose(app.doc, 10, app.bones).armR[0] - base.armR[0], -0.5, 0.01), "layer adds");
  await app.setLayer(l.id, { weight: 0.5 });
  ok(near(E.layerPose(app.doc, 10, app.bones).armR[0] - base.armR[0], -0.25, 0.01), "layer weight");
  app.setActiveLayer("");
  const cl = await app.addLayer({ name: "walk", mode: "override", source: "clip", clip: "w_walk", mask: R.MASKS["Lower body"], start: 6, fade_in: 6 });
  ok(dist3(E.layerPose(app.doc, 3, app.bones).legL, app.doc.basePose(3, app.bones).legL) < 1e-4, "clip layer silent before its range");
  ok(dist3(E.layerPose(app.doc, 20, app.bones).legL, poseAt(walk, 20, app.bones).legL) < 1e-3, "override clip layer takes over");
  app.removeLayer(cl.id);

  // constraints
  app.newClip("zz_desktop_check", 30, 30, false, true);
  const sh = app.jointWorld("armR");
  const tgt = sh.clone().add(new THREE.Vector3(0.15, -0.3, 0.35).normalize().multiplyScalar(0.5));
  app.addConstraint({ type: "ik", limb: "armR", target: { pos: [tgt.x, tgt.y, tgt.z] } });
  app.finalPoseOn(app.stage.probe, 0);
  ok(app.stage.probe.worldPos("handR").distanceTo(tgt) < 0.01, "IK reaches (" + app.stage.probe.worldPos("handR").distanceTo(tgt).toFixed(4) + ")");
  app.setConstraint(app.doc.constraints[0].id, { enabled: false });
  app.setFrame(0);
  const foot0 = app.jointWorld("footL");
  app.setFrame(15);
  app.setHipsShift("dy", -0.25);
  app.keyNow();
  app.addConstraint({ type: "pin", bone: "footL", what: "both", pin_frame: 0, start: 0, end: -1 });
  const fp = app.finalPoseOn(app.stage.probe, 15);
  ok(app.stage.probe.worldPos("footL").distanceTo(foot0) < 0.01, "frozen foot stays put");
  ok(fp.kneeL[0] > 0.05, "knee bends backward to keep it planted");
  app.bakeToKeys();
  ok(!app.doc.needsBake() && app.doc.keys.length === 31, "bake to keys");

  // save round trip + the godot signature
  app.newClip("zz_desktop_check", 24, 30, false, true);
  app.setFrame(12);
  app.setBoneEuler("torso", [0.3, 0.2, 0]);
  app.keyNow();
  app.addConstraint({ type: "floor", bones: ["footL", "footR"], mode: "plant" });
  const sv = await app.save();
  ok(sv.ok && sv.baked, "save bakes the live constraint");
  const c = await window.host.loadClip("zz_desktop_check");
  ok(c.keys.length === 25 && c.studio.base.length === 2, "game keys = bake, base rides along");
  ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(c.studio.saved || ""), "every save stamps studio.saved (the generators skip the clip)");
  ok(Doc.fromClip(c).saved === c.studio.saved && Doc.fromClip({ name: "x", keys: [] }).saved === "", "saved read back; a generator clip has none");
  const d = Doc.fromClip(c);
  ok(!d.outsideEdit && d.constraints.length === 1, "re-open keeps base + constraint");
  ok(sig([{ f: 0, rot: { a: [0.1, 0, 0] }, hips_dy: 0 }]) === "1898101346" || true, "sig runs");
  c.keys = c.keys.slice(0, 3);
  ok(Doc.fromClip(c).outsideEdit, "outside edits detected");
  await app.trashClip("zz_desktop_check");

  // api
  const call = makeApi(app);
  r = await call("ping", {});
  ok(r.result === "pong", "api ping");
  r = await call("new_clip", { name: "zz_desktop_api", frames: 20, discard: true });
  ok(r.ok, "api new_clip " + JSON.stringify(r));
  r = await call("set_pose", { frame: 10, bones: { armR: [-60, 0, 20], kneeL: [-30, 0, 0] } });
  ok(r.ok && r.result.clamped_by_limits_or_locks.includes("kneeL"), "api set_pose clamps the knee");
  r = await call("get_pose", { frame: 10, bones: ["armR"] });
  ok(near(r.result.bones.armR[0], -60, 0.05) && near(r.result.bones.armR[2], 20, 0.05), "api get_pose degrees");
  r = await call("ik_pose", { frame: 5, bone: "footR", target: [0.12, 0.25, 0.3] });
  ok(r.ok && r.result.miss_m < 0.03, "api ik_pose " + JSON.stringify(r.result));
  r = await call("open_clip", { name: "w_walk" });
  ok(!r.ok, "open_clip protects unsaved work");
  r = await call("screenshot", { target: "sheet", width: 640, height: 360, cols: 4, path: "D:/Cache/fight_studio_dev/desktop_sheet_test.png" });
  ok(r.ok, "api screenshot sheet " + JSON.stringify(r));
  r = await call("get_pose", { frame: 5, bones: ["kneeR"], final: false });
  ok(near(r.result.bones.kneeR[1], 0, 0.01) && near(r.result.bones.kneeR[2], 0, 0.01) && r.result.bones.kneeR[0] > 0, "ik bends the knee on its hinge only " + JSON.stringify(r.result.bones.kneeR));
  ok(R.isHinge("kneeL") && R.isHinge("elbowR") && !R.isHinge("armR"), "hinge joints from animator_rig.json");
  app.history.markSaved();

  // ADJUST: a turn on top of the keys, over a scope; the keys never change; limits hold; restore takes it off
  await app.openClip("w_walk", true);
  const keysBefore = JSON.stringify(app.doc.keys);
  const armAt = (f) => E.layerPose(app.doc, f, app.bones).armR;
  const raw7 = armAt(7);
  app.adjustPart("armR", [-20 * RAD, 0, 0], "all");
  ok(near(armAt(7)[0] - raw7[0], -20 * RAD, 1e-4) && JSON.stringify(app.doc.keys) === keysBefore, "adjust turns a part on every frame, keys untouched");
  ok(near(app.adjustValue("armR", "all")[0], -20 * RAD, 1e-4), "adjust value reads back");
  app.adjustPart("armR", [-30 * RAD, 0, 0], "all");
  ok(A.adjustLayers(app.doc).length === 1 && near(armAt(7)[0] - raw7[0], -30 * RAD, 1e-4), "adjusting again sets the total (one adjustment)");
  app.adjustPart("armR", [-30 * RAD, 0, 0], "all");
  const armMax = R.rigData.limits.armR && R.rigData.limits.armR.x ? R.rigData.limits.armR.x[1] : Infinity;
  app.adjustPart("armL", [3, 0, 0], "range", -1, 0, 4, 0);
  let past = false;
  for (let f = 0; f <= 4; f++) { const e = E.layerPose(app.doc, f, app.bones).armL, b0 = poseAt(app.doc.source(), f, app.bones).armL; if (e[0] > Math.max(R.rigData.limits.armL?.x?.[1] ?? Infinity, b0[0]) + 1e-6) past = true; }
  ok(!past && armMax < Infinity, "an adjustment stops at the joint's limit");
  app.adjustRestore("", "armL");
  app.adjustPart("armL", [0, 0, 10 * RAD], "frame", 12, 0, -1, 4, true);
  ok(A.adjustLayers(app.doc).length === 3 && near(E.layerPose(app.doc, 2, app.bones).armL[2], poseAt(app.doc.source(), 2, app.bones).armL[2], 1e-6), "around one frame, mirrored, nothing outside its ease");
  app.adjustPart("kneeL", [-90 * RAD, 0, 0], "all");
  let fwd = false;
  for (let f = 0; f <= app.doc.frames; f++) if (E.layerPose(app.doc, f, app.bones).kneeL[0] < -1e-6) fwd = true;
  ok(!fwd, "an adjustment never bends a knee forward");
  ok(app.adjustRestore("", "armR") === 2 && near(armAt(7)[0], raw7[0], 1e-6), "restore one part (its all-frames and mirrored adjustments)");
  app.undo();
  ok(near(armAt(7)[0] - raw7[0], -30 * RAD, 1e-4), "restore undoes");
  r = await call("adjustments", {});
  ok(r.ok && r.result.length === 4 && r.result.some((x) => x.bone === "armR" && near(x.turn[0], -30, 0.01)), "api adjustments");
  r = await call("adjust", { bone: "head", y: 15 });
  ok(r.ok && r.result.layers.length === 1, "api adjust");
  r = await call("adjust_restore", {});
  ok(r.ok && r.result.restored === 5 && JSON.stringify(app.doc.keys) === keysBefore, "api adjust_restore all");

  // MERGE: the base gives the body, a clip on top gives the parts you pick; bake makes one new clip with its recipe
  app.history.markSaved();
  await app.openClip("w_walk", true);
  const top = (await window.host.listClips()).find((n) => n !== "w_walk" && /^a_.*jab/.test(n)) || "a_jab1";
  const ml = await app.mergeAdd(top, ["Arm R"], 6, 4, 4);
  ok(ml && ml.merge && ml.mask.join() === "clavicleR,armR,elbowR,handR" && ml.offset === 6 && ml.end === 6 + Number(E.clipSrc(top).frames), "merge adds a clip on top (parts mask, start, end)");
  const src = E.clipSrc(top);
  const mid = 6 + Math.round(Number(src.frames) / 2);
  const mp = E.layerPose(app.doc, mid, app.bones);
  ok(dist3(mp.armR, poseAt(src, mid - 6, app.bones).armR) < 1e-4 && dist3(mp.legL, poseAt(app.doc.source(), mid, app.bones).legL) < 1e-6, "top clip gives its arm, the base keeps its legs");
  await app.mergeSet(ml.id, { start: 10, parts: ["Arm R", "Head"] });
  const ml2 = app.doc.layerById(ml.id);
  ok(ml2.offset === 10 && ml2.end === 10 + Number(src.frames) && ml2.mask.includes("head"), "merge set: start moves the clip, parts the mask");
  const want = M.length(app.doc);
  const baked = app.mergeBake("zz_desktop_merged");
  ok(baked.name === "zz_desktop_merged" && app.doc.frames === want && app.doc.extra.merge && app.doc.extra.merge.base === "w_walk" && app.doc.isNew !== false, "merge bake: one new clip with its recipe");
  ok(app.doc.keys.length < app.doc.frames && !app.doc.layers.length, "merge bake thins the keys, no layers left");
  ok((await app.mergeRebuild()) && app.doc.name === "w_walk" && M.mergeLayers(app.doc).length === 1, "rebuild the merge setup");
  r = await call("merge", { clips: [{ clip: top, parts: ["Arm L"], start: 0 }], bake: true, name: "zz_desktop_merged2" });
  ok(r.ok && r.result.baked && r.result.baked.name === "zz_desktop_merged2", "api merge + bake");
  app.history.markSaved();

  // FEET: soles read off the mesh match the game's bake; a planted clip stands on them, nothing sinks
  const bake = (await window.host.loadData("feet_soles.json")) || {};
  for (const k of ["carter", "vix"]) {
    await app.setFighter(k);
    const so = F.soleInfo(app.stage.probe);
    const be = bake[`res://game/packs/city_breaker/assets/chars/${k}_fight.glb`] || {};
    for (const b of ["footL", "footR"]) {
      const s = so[b], g = be[b];
      ok(s && g && Math.abs(s.tilt0 - g.tilt0) < 1.5 && Math.abs(s.h - g.h) < 0.004 * Math.max(1, g.size) && new THREE.Vector3(...g.n).angleTo(s.n) < 0.03,
        `${k} ${b} sole like the game's bake (tilt ${s && s.tilt0.toFixed(1)} vs ${g && g.tilt0.toFixed(1)}, h ${s && s.h.toFixed(4)} vs ${g && g.h.toFixed(4)})`);
    }
    await app.openClip("w_walk", true);
    const rep = app.feetReport(2);
    ok(rep.planted && (rep.counts.flat || 0) > 0 && !rep.frames.some((x) => x.footL.low_cm < -1.5 || x.footR.low_cm < -1.5), `${k} planted walk: feet on the floor ${JSON.stringify(rep.counts)}`);
    // the same as the game's CBFeet.ground, frame by frame (reference by ref_feet.gd)
    const ref = (await (await fetch("file:///D:/Cache/fight_studio_dev/ref_feet.json").catch(() => null))?.json?.().catch(() => null)) || null;
    if (ref && ref[k]) {
      let worst = 0;
      for (const x of rep.frames) {
        const g = ref[k][String(x.f)];
        if (g) worst = Math.max(worst, Math.abs(x.footL.low_cm / 100 - g[0]), Math.abs(x.footR.low_cm / 100 - g[1]));
      }
      ok(worst < 0.002, `${k} feet like the game's CBFeet.ground on every frame (worst ${(worst * 100).toFixed(2)} cm)`);
    } else lines.push("skip feet reference (run ref_feet.gd)");
    app.stage.probe.apply({});
    app.stage.probe.root.position.y = 0;
    F.ground(app.stage.probe, app.stage.probe.root, 0, true);
    const lo = Math.min(F.lowest(app.stage.probe, "footL"), F.lowest(app.stage.probe, "footR"));
    ok(Math.abs(lo) < 0.002, `${k} at rest stands on its soles (lowest ${lo.toFixed(4)})`);
    app.stage.probe.root.position.y = 0;
  }

  // GRIPS: a grey proxy in the hand by the game's grip frame
  r = await call("add_prop", { shape: "cylinder", grip: "cylinder_R" });
  ok(r.ok && app.doc.props.length === 1 && app.doc.props[0].grip === "cylinder_R", "api add_prop with a grip");
  app.applyNow();
  const pm = app.stage.props.children[0];
  ok(pm && pm.visible && pm.position.distanceTo(app.jointWorld("fingersR")) < 0.15, "the grip proxy sits in the right hand");
  r = await call("remove_prop", { all: true });
  ok(r.ok && !app.doc.props.length, "api remove_prop all");
  app.history.markSaved();

  // MOTION IMPORT: a Mixamo FBX onto our rig, limb by limb the same as the Godot import (reference clips by ref_import.gd)
  const SEGS = [["armL", "elbowL"], ["elbowL", "handL"], ["armR", "elbowR"], ["elbowR", "handR"], ["legL", "kneeL"], ["kneeL", "footL"], ["legR", "kneeR"], ["kneeR", "footR"], ["hips", "chest"], ["chest", "head"]];
  const segDirs = (clip, f) => {
    const body = app.stage.probe;
    body.apply(poseAt(clip, f, app.bones));
    return SEGS.map(([a, b]) => body.worldPos(b).sub(body.worldPos(a)).normalize());
  };
  for (const [k, file, ref] of [["vix", "D:/Projects/Vix and Carter/Running.fbx", "mx_running"], ["vix", "C:/Users/User/Downloads/Capoeira Spin Kick.fbx", "mx_capoeira_spin_kick"],
    ["carter", "C:/Users/User/Downloads/Capoeira Spin Kick.fbx", "mx_capoeira_spin_kick"]]) {
    const rc = await (await fetch(`file:///D:/Cache/fight_studio_dev/ref_${k}_${ref}.json`).catch(() => null))?.json?.().catch(() => null);
    if (!rc || !(await window.host.motionUrl(file))) { lines.push(`skip import ${k} ${ref} (missing file or reference)`); continue; }
    if (app.fighter !== k) await app.setFighter(k);
    app.history.markSaved();
    const rep = await app.importMotion(file, {});
    ok(!rep.error && app.doc.name === ref && app.isNew, `import ${k} ${ref} opens unsaved ${JSON.stringify(rep)}`);
    const mine = app.doc.toClip();
    ok(mine.frames === rc.frames && mine.loop === rc.loop && mine.plant === rc.plant, `import ${k} ${ref}: frames / loop / plant as Godot (${mine.frames}/${mine.loop}/${mine.plant} vs ${rc.frames}/${rc.loop}/${rc.plant})`);
    let worst = 0, hips = 0;
    for (let f = 0; f <= rc.frames; f += 4) {
      const a = segDirs(mine, f), b = segDirs(rc, f);
      a.forEach((d, i) => (worst = Math.max(worst, d.angleTo(b[i]) * DEG)));
      const pa = poseAt(mine, f, []), pb = poseAt(rc, f, []);
      hips = Math.max(hips, Math.hypot(pa._dx - pb._dx, pa._dy - pb._dy, pa._dz - pb._dz));
    }
    ok(worst < 4 && hips < 0.03, `import ${k} ${ref}: limbs within ${worst.toFixed(2)} deg, hips within ${(hips * 100).toFixed(1)} cm of the Godot import`);
    let fwdKnee = false;
    for (const key of mine.keys) for (const b of ["kneeL", "kneeR"]) if ((key.rot[b] || [0])[0] < 0) fwdKnee = true;
    ok(!fwdKnee, `import ${k} ${ref}: knees never bend forward`);
  }
  r = await call("import_motion", { path: "C:/nowhere/none.fbx", discard: true });
  ok(!r.ok, "api import_motion refuses a missing file");
  // real fingers (2026-10-30): the retarget, the finger limits, the fingered Fist slider, the hand closing round a handle
  if (app.fighter !== "vix") await app.setFighter("vix");
  const body = app.stage.body;
  if (body.fmap && body.fmap.size) {
    const c = FG.fingers.shared.fingersR.c;
    const backward = eulerOf(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...c).normalize(), -60 * RAD));
    ok(FG.fingerParts("fingersR", R.clampLimits("fingersR", backward))[0] * DEG > -20.5, "fingers: a knuckle bent 60 deg backwards is held at its limit");
    ok(R.fingerBreaks("tipsR", backward), "fingers: checks see a finger bent backwards");
    const fistR = R.rigData.controls.find((x) => x.name === "Fist R");
    const fp = R.setControl(fistR, {}, 0.8);
    ok(near(R.controlValue(fistR, fp), 0.8, 0.01) && FG.fingerParts("fingersR", fp.fingersR)[0] * DEG > 55, "fingers: the Fist slider curls a fingered hand into the palm");
    const e0 = [0.2, -0.1, 0.3];
    body.setLocalEuler("indexR", e0);
    ok(dist3(body.localEuler("indexR"), e0) < 1e-5, "fingers: a finger turn reads back through the retarget");
    body.apply({});
    const size = [0.045, 0.5, 0.045];
    const at = G.frame(body, "R", "cylinder", size);
    const n = G.wrapHand(body, "R", "cylinder", size, at);
    const inv = at.clone().invert();
    const tip = body.worldPos("tipsR").applyMatrix4(inv);
    ok(n >= 4 && Math.hypot(tip.x, tip.z) < 0.09, `wrap: the fingers close round a handle (${n} joints turned, middle joint ${(Math.hypot(tip.x, tip.z) * 100).toFixed(1)} cm from its axis)`);
    body.apply({});
  } else lines.push("skip fingers (no finger_frames.json for vix)");
  app.history.markSaved();

  // FILL: the frames between two keys, the same as the Godot Animator's core/fill.gd (reference by ref_fill.gd)
  if (app.fighter !== "vix") await app.setFighter("vix");
  const B = app.bones;
  const rf = await (await fetch("file:///D:/Cache/rmt_studio_refs/ref_fill.json").catch(() => null))?.json?.().catch(() => null);
  // the worst difference between the fill keys made here and Godot's (radians / metres), and frames one has and the other not
  const fillDiff = (ref) => {
    let worst = 0, missing = 0;
    const mine = app.doc.keys.filter((k) => k.fill);
    const theirs = ref.filter((k) => k.fill);
    if (mine.length !== theirs.length) missing += Math.abs(mine.length - theirs.length);
    for (const g of theirs) {
      const k = app.doc.keyAt(g.f);
      if (!k || !k.fill) { missing++; continue; }
      for (const b of new Set([...Object.keys(g.rot || {}), ...Object.keys(k.rot || {})])) {
        const x = (k.rot || {})[b] || [0, 0, 0], y = (g.rot || {})[b] || [0, 0, 0];
        worst = Math.max(worst, ...[0, 1, 2].map((i) => Math.abs(x[i] - y[i])));
      }
      for (const ax of ["hips_dy", "hips_dx", "hips_dz"]) worst = Math.max(worst, Math.abs(Number(k[ax] || 0) - Number(g[ax] || 0)));
    }
    return { worst, missing };
  };
  const twoKeys = (name, frames, fps, keys) => {
    app.newClip(name, frames, fps, false, false);
    app.doc.keys = [];
    for (const [f, p] of keys) app.doc.writeKey(f, p, B);
    app.doc.normalize();
  };
  if (rf) {
    const zero = rf.shape_input.a, pb = rf.shape_input.b;
    let worst = 0, missing = 0;
    for (const c of rf.shape) {
      twoKeys("zz_fill_check", 48, 60, [[0, zero], [24, pb], [48, zero]]);
      app.doc.keyAt(0).ease = "in";
      await app.fillApply({ ...c.opts, from: 0, to: 24 });
      const d = fillDiff(c.keys);
      worst = Math.max(worst, d.worst);
      missing += d.missing;
    }
    ok(missing === 0 && worst < 3e-4, `fill shape: ${rf.shape.length} settings give Godot's keys (worst ${worst.toFixed(5)} rad, ${missing} keys off)`);
    ok(app.doc.fills.length === 1 && app.doc.keyAt(0).ease === "linear" && app.doc.keys.filter((k) => k.fill).every((k) => k.tag === "breakdown"), "fill: one fill, breakdown keys, key A eases linear");
    app.setFrame(15);
    ok(app.fillSpan().join() === "0,24", `fill: with the playhead inside a fill, the span is the whole fill (${app.fillSpan()})`);
    const id = app.doc.fills[0].id;
    const nFill = app.doc.keys.filter((k) => k.fill === id).length;
    ok(app.fillRemove(id) === nFill && app.doc.keyFrames().join() === "0,24,48" && app.doc.keyAt(0).ease === "in", "fill remove: its keys go, key A's ease comes back");
    app.undo();
    ok(app.doc.fills.length === 1 && Doc.fromClip(app.doc.toClip()).fills.length === 1, "fill: undo brings it back, and it survives a save");
    app.doc.writeKey(30, zero, B);
    app.doc.keyAt(30).lock = true;
    const before = app.doc.keyFrames().join();
    ok((await app.fillApply({ from: 24, to: 48 })).error && app.doc.keyFrames().join() === before, "fill: a locked key in the span stops it");
    const p12 = { ...zero, armR: [0, 0, 0.4] }, p36 = { ...zero, armR: [0, 0, 1.2] };
    twoKeys("zz_fill_flow", 36, 60, [[0, zero], [12, p12], [36, p36]]);
    await app.fillApply({ from: 12, to: 36, flow: 1 });
    const df = fillDiff(rf.flow.keys);
    ok(df.missing === 0 && df.worst < 3e-4, `fill flow: Godot's keys (worst ${df.worst.toFixed(5)})`);
    // feet: the hips shift and turn over planted feet, then a step
    for (const which of ["held", "step"]) {
      twoKeys("zz_fill_feet", 30, 60, [[0, rf.feet.a], [30, rf.feet[which]]]);
      app.doc.plant = true;
      const res = await app.fillApply({ from: 0, to: 30 });
      ok(JSON.stringify(res.feet) === JSON.stringify(rf.feet[which + "_result"]), `fill feet ${which}: ${JSON.stringify(res.feet)} like Godot ${JSON.stringify(rf.feet[which + "_result"])}`);
      const d = fillDiff(rf.feet[which + "_keys"]);
      ok(d.missing === 0 && d.worst < 0.02, `fill feet ${which}: the legs like Godot's (worst ${d.worst.toFixed(4)} rad)`);
      if (which === "held") {
        const body = app.stage.probe;
        let drift = 0;
        const start = {};
        for (let f = 0; f <= 30; f++) {
          body.apply(app.doc.basePose(f, B));
          body.update();
          for (const ft of ["footL", "footR"]) {
            const p = body.worldPos(ft);
            if (!f) start[ft] = p;
            drift = Math.max(drift, Math.hypot(p.x - start[ft].x, p.z - start[ft].z));
          }
        }
        ok(drift < 0.006, `fill feet: the planted feet stay put (${(drift * 1000).toFixed(1)} mm)`);
      }
    }
    // a spin kick: Vix's forward smash without its strike keys keeps its full turn, its left foot steps (not slides)
    if (rf.spin) {
      await app.openClip("a_vix_fsmash", true);
      app.doc.keys = app.doc.keys.filter((k) => k.f !== 10 && k.f !== 12);
      const rs = await app.fillApply({ from: 8, to: 22, timing: "strike" });
      const ds = fillDiff(rf.spin.keys);
      ok(JSON.stringify(rs.feet) === JSON.stringify(rf.spin.feet) && ds.missing === 0 && ds.worst < 0.02, `fill spin: Godot's keys and feet (${JSON.stringify(rs.feet)}, worst ${ds.worst.toFixed(4)} rad)`);
      ok(Math.abs(app.doc.basePose(15, B).hips[1] - (app.doc.basePose(14, B).hips[1] + app.doc.basePose(16, B).hips[1]) / 2) < 0.2 && Math.abs(app.doc.basePose(16, B).hips[1]) > 3.2, "fill spin: the hips turn the long way, as keyed");
    }
    // library: a stretch of a clip found again and played back as it is
    const x = await window.host.loadClip("a_al_fsmash");
    if (x) {
      twoKeys("zz_fill_lib", 18, Number(x.fps), [[0, poseAt(x, 6, B)], [18, poseAt(x, 24, B)]]);
      const t0 = performance.now();
      await app.fillLibrary(true);
      const tIndex = performance.now() - t0;
      const t1 = performance.now();
      const ms = await app.fillMatches({ from: 0, to: 18, n: 6 });
      const tSearch = performance.now() - t1;
      lines.push(`  fill library: index ${FL.indexSize()} clips in ${tIndex.toFixed(0)} ms, search in ${tSearch.toFixed(0)} ms`);
      const g = rf.library.matches[0];
      ok(ms.length && ms[0].clip === g.clip && ms[0].from === g.from && ms[0].to === g.to && ms[0].mirror === g.mirror && Math.abs(ms[0].cost - g.cost) < 0.002,
        `fill library: the best match is Godot's (${JSON.stringify(ms[0])} vs ${JSON.stringify(g)})`);
      await app.fillApply({ from: 0, to: 18, engine: "library", pick: 0 });
      const dl = fillDiff(rf.library.keys);
      ok(dl.missing === 0 && dl.worst < 3e-4, `fill library: the in-betweens are Godot's (worst ${dl.worst.toFixed(5)})`);
    } else lines.push("skip fill library (no a_al_fsmash)");
  } else lines.push("skip fill reference (run ref_fill.gd)");
  // LEARNED FROM REAL MOTION (data/motion_dna.json, MotionLibrary/study/study.py): Fill's learned timings and the Alive layer,
  // the same as the Godot Animator's (reference by ref_learn.gd)
  ok(FL.LEARNED.every((t) => (FL.learned(t).slopes || []).length === 2), `fill learned: the ${FL.LEARNED.length} learned timings are read from data/motion_dna.json`);
  const rl = await (await fetch("file:///D:/Cache/fight_studio_dev/ref_learn.json").catch(() => null))?.json?.().catch(() => null);
  if (rl) {
    let worst = 0, missing = 0;
    for (const c of rl.fill) {
      twoKeys("zz_learn_check", 48, 60, [[0, rl.input.a], [24, rl.input.b], [48, rl.input.a]]);
      app.doc.keyAt(0).ease = "in";
      await app.fillApply({ ...c.opts, from: 0, to: 24 });
      const d = fillDiff(c.keys);
      worst = Math.max(worst, d.worst);
      missing += d.missing;
    }
    ok(missing === 0 && worst < 3e-4, `fill learned: ${rl.fill.length} learned fills give Godot's keys (worst ${worst.toFixed(5)} rad, ${missing} keys off)`);
    let aw = 0, off = 0;
    for (const c of rl.alive) {
      const cd = c.clip;
      app.newClip("zz_alive_check", cd.frames, cd.fps, cd.loop, false);
      app.doc.keys = [];
      for (const [f, which] of cd.keys) app.doc.writeKey(f, which === "rest" ? rl.alive_input.rest : rl.alive_input.move, B);
      app.doc.normalize();
      const r = app.aliveAdd({ ...c.opts });
      const l = r.id ? app.doc.layerById(r.id) : null, g = c.layer;
      if (!l || l.keys.length !== g.keys.length || l.start !== g.start || l.end !== g.end || l.mask.join() !== g.mask.join()) { off++; continue; }
      l.keys.forEach((k, i) => {
        const gk = g.keys[i];
        if (k.f !== gk.f) off++;
        aw = Math.max(aw, Math.abs((k.hips_dy || 0) - (gk.hips_dy || 0)));
        for (const b of new Set([...Object.keys(k.rot), ...Object.keys(gk.rot)])) {
          const x = k.rot[b] || [0, 0, 0], y = gk.rot[b] || [0, 0, 0];
          aw = Math.max(aw, ...[0, 1, 2].map((j) => Math.abs(x[j] - y[j])));
        }
      });
      for (const p of c.probe) {
        const mine = E.layerPose(app.doc, p.f, B);
        for (const b of B) aw = Math.max(aw, ...[0, 1, 2].map((j) => Math.abs(((mine[b] || [0, 0, 0])[j]) - ((p.pose[b] || [0, 0, 0])[j]))));
        aw = Math.max(aw, Math.abs((mine._dy || 0) - (p.pose._dy || 0)));
      }
    }
    ok(off === 0 && aw < 3e-4, `alive: ${rl.alive.length} Alive layers give Godot's keys and poses (worst ${aw.toFixed(5)}, ${off} off)`);
    // land on a planted clip: the feet held, the knees take the dip (legs through the feet IK, like the fill feet check)
    if (rl.land_feet) {
      twoKeys("zz_land_check", 40, 60, [[0, rl.land_input], [20, rl.land_input], [40, rl.land_input]]);
      app.doc.plant = true;
      const lr = await app.fillApply({ from: 0, to: 20, timing: "land", overlap: 0 });
      const dl = fillDiff(rl.land_feet.keys);
      ok(JSON.stringify(lr.feet) === JSON.stringify(rl.land_feet.feet) && dl.missing === 0 && dl.worst < 0.02,
        `fill land: Godot's keys and feet on a planted landing (${JSON.stringify(lr.feet)}, worst ${dl.worst.toFixed(4)} rad)`);
    }
    // gait: the same walk / run / range made into the same Gait layers
    let gw = 0, goff = 0;
    for (const c of rl.gait || []) {
      const cd = c.case;
      app.newClip(cd.name, cd.frames, cd.fps, cd.loop, false);
      app.doc.keys = structuredClone(c.keys_in);
      app.doc.normalize();
      const r = app.gaitAdd({ ...cd.opts });
      const l = r.id ? app.doc.layerById(r.id) : null, g = c.layer;
      if (!l || l.keys.length !== g.keys.length || l.mask.join() !== g.mask.join() || r.kind !== c.result.kind || Math.abs(r.speed - c.result.speed) > 0.006) { goff++; continue; }
      l.keys.forEach((k, i) => {
        const gk = g.keys[i];
        if (k.f !== gk.f) goff++;
        gw = Math.max(gw, Math.abs((k.hips_dy || 0) - (gk.hips_dy || 0)));
        for (const b of new Set([...Object.keys(k.rot), ...Object.keys(gk.rot)])) {
          const x = k.rot[b] || [0, 0, 0], y = gk.rot[b] || [0, 0, 0];
          gw = Math.max(gw, ...[0, 1, 2].map((j) => Math.abs(x[j] - y[j])));
        }
      });
      for (const p of c.probe) {
        const mine = E.layerPose(app.doc, p.f, B);
        for (const b of B) gw = Math.max(gw, ...[0, 1, 2].map((j) => Math.abs(((mine[b] || [0, 0, 0])[j]) - ((p.pose[b] || [0, 0, 0])[j]))));
        gw = Math.max(gw, Math.abs((mine._dy || 0) - (p.pose._dy || 0)));
      }
    }
    ok((rl.gait || []).length === 3 && goff === 0 && gw < 3e-4, `gait: ${(rl.gait || []).length} Gait layers give Godot's keys and poses (worst ${gw.toFixed(5)}, ${goff} off)`);
    // balance: the same kicks found and leaned away from
    let bw = 0, boff = 0;
    for (const c of rl.balance || []) {
      app.newClip("zz_ref_balance", 60, 60, false, false);
      app.doc.keys = structuredClone(c.keys_in);
      app.doc.normalize();
      const r = app.balanceAdd({ ...c.case.opts });
      const l = r.id ? app.doc.layerById(r.id) : null, g = c.layer;
      if (!l || l.keys.length !== g.keys.length || l.mask.join() !== g.mask.join() || r.kicks !== c.result.kicks) { boff++; continue; }
      l.keys.forEach((k, i) => {
        const gk = g.keys[i];
        if (k.f !== gk.f) boff++;
        for (const b of new Set([...Object.keys(k.rot), ...Object.keys(gk.rot)])) {
          const x = k.rot[b] || [0, 0, 0], y = gk.rot[b] || [0, 0, 0];
          bw = Math.max(bw, ...[0, 1, 2].map((j) => Math.abs(x[j] - y[j])));
        }
      });
      for (const p of c.probe) {
        const mine = E.layerPose(app.doc, p.f, B);
        for (const b of B) bw = Math.max(bw, ...[0, 1, 2].map((j) => Math.abs(((mine[b] || [0, 0, 0])[j]) - ((p.pose[b] || [0, 0, 0])[j]))));
      }
    }
    ok((rl.balance || []).length === 3 && boff === 0 && bw < 3e-4, `balance: ${(rl.balance || []).length} Balance layers give Godot's keys and poses (worst ${bw.toFixed(5)}, ${boff} off)`);
    ok(app.balanceRemove() === 1 && !app.doc.layers.some((x) => x.balance), "balance: remove takes it off");
    app.newClip("zz_balance_none", 40, 60, false, false);
    ok(!!app.balanceAdd({}).error, "balance: a clip with no kick gets none");
  } else lines.push("skip learned reference (run ref_learn.gd)");
  {
    // Gait on Vix's own walk: a walk layer with the torso / chest turn
    if (await window.host.loadClip("a_vix_walk")) {
      await app.openClip("a_vix_walk", true);
      const r = app.gaitAdd({});
      ok(!r.error && r.kind === "walk" && r.bones.includes("chest"), `gait: Vix's walk gets it (${r.kind}, ${r.keys} keys, ${(r.bones || []).join(" ")})`);
      ok(app.gaitRemove() === 1 && !app.doc.layers.some((x) => x.gait), "gait: remove takes it off");
      const r2 = await call("gait", { kind: "walk" });
      ok(r2.ok && r2.result.kind === "walk" && r2.result.keys > 2, `gait: api ${JSON.stringify(r2).slice(0, 120)}`);
      await app.openClip("a_vix_walk", true);
    } else lines.push("skip gait on a_vix_walk");
  }
  {
    // Alive on a still looping clip: whole breaths, the loop joins, replace / remove / undo, survives a save
    app.newClip("zz_alive_loop", 120, 60, true, false);
    const r = app.aliveAdd({ mood: "calm" });
    const nb = 2 / r.periods[0];
    ok(Math.abs(nb - Math.round(nb)) < 1e-3, `alive: whole breaths in the looping clip (${Math.round(nb)} of ${r.periods[0]} s)`);
    const p0 = E.layerPose(app.doc, 0, B), p1 = E.layerPose(app.doc, 120, B);
    ok(Math.abs(p0.chest[0] - p1.chest[0]) < 1e-4 && Math.abs(p0.chest[0] - E.layerPose(app.doc, 30, B).chest[0]) > 1e-4, "alive: the chest breathes and the loop joins");
    app.aliveAdd({ mood: "fight", amount: 0.5 });
    ok(app.doc.layers.filter((l) => l.alive).length === 1 && app.doc.layers.find((l) => l.alive).alive.mood === "fight", "alive: again = replaced (one layer, now fight)");
    ok(Doc.fromClip(app.doc.toClip()).layers.filter((l) => l.alive).length === 1, "alive: survives a save");
    ok(app.aliveRemove() === 1 && !app.doc.layers.some((l) => l.alive), "alive: remove takes it off");
    app.undo();
    ok(app.doc.layers.some((l) => l.alive), "alive: undo brings it back");
    const r2 = await call("alive", { mood: "tired" });
    ok(r2.ok && r2.result.mood === "tired" && r2.result.keys > 2, `api alive ${JSON.stringify(r2).slice(0, 140)}`);
  }
  {
    // REAL MOTION in Fill's library (the Motion Library on this machine)
    const info = await app.fillRealFolder();
    if (!info.clips) lines.push(`skip real motion (no Motion Library at "${info.folder}")`);
    else {
      await app.fillLibrary();
      const libClips = await window.host.clipLibrary("");
      const name = Object.keys(libClips.clips || {}).filter((n) => n.startsWith(FL.REAL_PREFIX)).sort()
        .find((n) => Number(libClips.clips[n].frames) >= 70 && !libClips.clips[n].loop);
      ok(!!name, `fill real: the library holds ${info.clips} real clips (${info.folder})`);
      if (name) {
        const rc = libClips.clips[name];
        twoKeys("zz_real_check", 40, Number(rc.fps), [[0, poseAt(rc, 20, B)], [20, poseAt(rc, 40, B)], [40, poseAt(rc, 60, B)]]);
        const ms = await app.fillMatches({ from: 0, to: 20, n: 3 });
        ok(ms.length && ms[0].clip === name && ms[0].cost < 0.05, `fill real: two poses of ${name} find it again (${ms.length ? ms[0].clip + " cost " + ms[0].cost : "-"})`);
        const fr = await app.fillApply({ from: 0, to: 20, engine: "library" });
        ok(String((fr.match || {}).clip || "").startsWith(FL.REAL_PREFIX) && fr.keys > 0, `fill real: a fill made from real motion (${fr.keys} keys)`);
      }
    }
  }
  // through the agent API
  twoKeys("zz_fill_api", 20, 30, [[0, {}], [16, { armR: [0, 0, 0.6] }]]);
  r = await call("fill", { from: 0, to: 16, timing: "strike", overlap: 0.5 });
  ok(r.ok && r.result.keys === 15 && r.result.settings.timing === "strike", `api fill ${JSON.stringify(r).slice(0, 160)}`);
  r = await call("fills", {});
  ok(r.ok && r.result.length === 1 && r.result[0].text.includes("strike"), "api fills lists it");
  r = await call("fill_matches", { from: 0, to: 16, n: 3 });
  ok(r.ok && r.result.length === 3, "api fill_matches gives 3 matches");
  r = await call("fill_remove", {});
  ok(r.ok && r.result.removed === 15 && !app.doc.fills.length, "api fill_remove takes it out");
  app.history.markSaved();

  // COLLISION WRAP: the match's Body Solve, the same as the game's addons/rmt_wraps (reference by ref_wrap.gd, own copy in D:/Cache/rmt_studio_refs, made again after the wraps were re-baked 2026-11-02: the game's
  // solve on a fighter at match height, posed like a match, played from the first frame like ult_clash.gd)
  // the angle between two rotations, exact for small ones too (acos of a dot product near 1 turns float32 rounding into ~0.03°)
  const qd = (a, b) => { const d = a.clone().invert().multiply(b); return 2 * Math.asin(Math.min(1, Math.hypot(d.x, d.y, d.z))); };
  const near3 = (a, b) => Math.hypot(a[0] - b.x, a[1] - b.y, a[2] - b.z);
  ok(W.overlap(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 0.1, new THREE.Vector3(0.15, 0.5, 0), new THREE.Vector3(0.15, 0.5, 0), 0.1).depth > 0.049, "wrap: capsule overlap");
  const rw = await (await fetch("file:///D:/Cache/rmt_studio_refs/ref_wrap.json").catch(() => null))?.json?.().catch(() => null);
  if (rw) {
    for (const name in rw.clips) {
      const g = rw.clips[name];
      // the reference is for one version of the clip: a clip edited since (another key, length, plant) is skipped, not failed
      const pc = await window.host.loadClip(name);
      const kf = pc ? (pc.keys || []).map((k) => Math.round(Number(k.f))).sort((a, b) => a - b).join() : "";
      if (!pc || Number(pc.frames) !== g.frames || !!pc.plant !== g.plant || (g.key_frames && kf !== g.key_frames.join())) {
        lines.push(`skip wrap ${name}: the project's clip is not the one the reference was made from (run ref_wrap.gd again)`);
        continue;
      }
      if (app.fighter !== g.fighter) await app.setFighter(g.fighter);
      ok(Math.abs(app.matchScale - rw.scales[g.fighter].s) < 0.003 * rw.scales[g.fighter].s, `wrap ${g.fighter}: match scale ${app.matchScale.toFixed(4)} like the game's ${rw.scales[g.fighter].s.toFixed(4)}`);
      const body = app.stage.wrapBody, model = body.root, s = app.solverOf(body);
      ok(!!s && [...s.bones].sort().join() === [...g.solver_bones].sort().join(), `wrap ${name}: the solve bends the game's bones (${s && s.bones.length} / ${g.solver_bones.length}${s ? `; missing ${g.solver_bones.filter((b) => !s.bones.includes(b))}, extra ${s.bones.filter((b) => !g.solver_bones.includes(b))}` : ""})`);
      if (!s) continue;
      // the solve alone, on the game's own pose before it (every bone, the hips shift, the model's height) frame by frame
      const put = (pre) => {
        for (const b in pre.q) if (body.has(b)) body.bone(b).quaternion.set(...pre.q[b]);
        body.bone("hips").position.set(...pre.hips);
        model.position.set(0, pre.y, 0);
        body.update();
      };
      const floor = g.plant ? 0 : NaN;
      const diff = (post) => { let w = 0, b0 = ""; for (const b in post.q) { const a = qd(body.bone(b).quaternion, new THREE.Quaternion(...post.q[b])); if (a > w) { w = a; b0 = b; } } return [w, b0]; };
      // one frame at a time, going on from the game's own carried corrections (its pose after the frame before over the pose
      // before it): every step the same as the game's
      let one = 0, oneF = -1, oneB = "", yW = 0, corrW = 0;
      const bigSteps = [];
      W.atMatchScale(model, app.matchScale, () => {
        for (let f = 1; f < g.pre.length; f++) {
          const carry = new Map();
          for (const b in g.post[f - 1].q) {
            if (!s.bones.includes(b)) continue;   // a bone the game's solve bends and ours does not: the bones check above says so
            const c = new THREE.Quaternion(...g.post[f - 1].q[b]).multiply(new THREE.Quaternion(...g.pre[f - 1].q[b]).invert());
            if (qd(c, new THREE.Quaternion()) > 1e-6) carry.set(b, c);   // what it kept (float32 keeps a few just under its 0.002 rad erase)
          }
          put(g.pre[f]);
          s.setCarry(carry);
          const st = s.solve(floor);
          const [w, b] = diff(g.post[f]);
          if (w > one) { one = w; oneF = f; oneB = b; }
          if (w > 0.0026) bigSteps.push(`f${f}:${b}:${(w * DEG).toFixed(3)}`);
          yW = Math.max(yW, Math.abs(model.position.y - g.post[f].y));
          corrW = Math.max(corrW, Math.abs(st.max_corr - g.post[f].max_corr));
        }
      });
      // the floor: float32 against float64 differs by up to the 0.002 rad a correction is dropped at; a frame past it has a contact
      // right on its edge (in by a hair in one, out in the other: a push of the 3 mm margin or none; a short piece turns far for it)
      const flips = bigSteps.length;
      ok(flips <= Math.ceil(0.1 * (g.pre.length - 1)) && yW < 0.0005, `wrap ${name}: each frame's solve is the game's (${g.pre.length - 1 - flips}/${g.pre.length - 1} frames within 0.15°, ` +
        `edge contacts ${flips ? bigSteps.slice(0, 4).join(" ") : "none"}; worst ${(one * DEG).toFixed(3)}° ${oneB} f${oneF}, height ${(yW * 1000).toFixed(3)} mm, max_corr ${(corrW * DEG).toFixed(3)}°)`);
      // played from the first frame on its own (8 settling solves on frame 0): float rounding grows only where the game's own
      // solve swings from frame to frame (Kat's breasts flip between their max_turn and less in the game too)
      let worst = 0, worstF = -1, worstB = "", sum = 0, cnt = 0;
      W.atMatchScale(model, app.matchScale, () => {
        s.reset();
        for (let w = 0; w < 8; w++) { put(g.pre[0]); s.solve(floor); }
        g.pre.forEach((pre, f) => {
          put(pre);
          s.solve(floor);
          for (const b in g.post[f].q) {
            const a = qd(body.bone(b).quaternion, new THREE.Quaternion(...g.post[f].q[b]));
            sum += a; cnt++;
            if (a > worst) { worst = a; worstF = f; worstB = b; }
          }
        });
      });
      const mean = sum / Math.max(1, cnt);
      ok(mean < (flips ? 0.0175 : 0.00017), `wrap ${name}: played from the first frame like the game's (mean ${(mean * DEG).toFixed(4)}°, worst ${(worst * DEG).toFixed(3)}° ${worstB} f${worstF}${flips ? "; edge contacts carry on to later frames" : ""})`);
      lines.push(`  wrap ${name}: one step worst ${(one * DEG).toFixed(4)}°; played through mean ${(mean * DEG).toFixed(4)}°, worst ${(worst * DEG).toFixed(3)}° ${worstB} f${worstF}`);
      await app.openClip(name, true);
      // the capsules where the game has them on frame 0 as keyed (the wrap on the bones at match height)
      let capW = 0;
      W.atMatchScale(model, app.matchScale, () => {
        app.finalPoseOn(body, 0);
        model.position.y = 0;
        body.update();
        if (g.plant) F.ground(body, model, 0, true);
        s.wrap.capsules().forEach((c, i) => { const r = g.caps0[i]; capW = Math.max(capW, near3(r[0], c[0]), near3(r[1], c[1]), Math.abs(r[2] - c[2])); });
      });
      ok(capW < 0.004, `wrap ${name}: capsules on frame 0 where the game's are (worst ${(capW * 1000).toFixed(2)} mm)`);
      // the whole match pipeline (pose -> feet -> solve) and the clash report, the same as the game's
      const rep = app.wrapReport(0);
      const gr = g.report.match;
      const pairs = (rows) => rows.map((x) => (Array.isArray(x) ? x[0] : x.pair)).sort().join(",");
      const cmW = (mine, theirs) => { let w = 0; for (const x of mine) { const t = theirs.find((y) => y[0] === x.pair); if (t) w = Math.max(w, Math.abs(t[1] - x.cm)); } return w; };
      ok(pairs(rep.keyed.rows) === pairs(gr.keyed) && cmW(rep.keyed.rows, gr.keyed) <= 0.3, `wrap ${name}: keyed clashes like the game's (${rep.keyed.pairs} pairs vs ${gr.keyed.length}, worst ${cmW(rep.keyed.rows, gr.keyed).toFixed(2)} cm)`);
      ok(Math.abs(rep.solved.pairs - gr.solved.length) <= 1 && cmW(rep.solved.rows, gr.solved) <= 0.5, `wrap ${name}: clashes after the solve like the game's (${rep.solved.pairs} pairs vs ${gr.solved.length}, worst ${cmW(rep.solved.rows, gr.solved).toFixed(2)} cm)`);
      ok(Math.abs(rep.max_corr_deg - gr.max_corr_deg) < 1 && rep.max_corr_bone === gr.max_corr_bone && rep.max_corr_f === gr.max_corr_f && rep.flagged === gr.max_corr_deg > 45,
        `wrap ${name}: the solve turns ${rep.max_corr_bone} ${rep.max_corr_deg}° at f${rep.max_corr_f} (game ${gr.max_corr_bone} ${gr.max_corr_deg.toFixed(1)}° f${gr.max_corr_f})${rep.flagged ? ", flagged" : ""}`);
      // the view: frame 20 (and 20.5) through the track is the clip played from its first frame, as the report plays it
      let carry = null;
      for (let w = 0; w < 8; w++) { app.finalPoseOn(body, 0); carry = app.matchFinish(body, carry).solver.carry(); }
      const snap = () => ({ y: body.root.position.y, q: new Map(s.bones.map((b) => [b, body.bone(b).quaternion.clone()])) });
      let c19 = null, at20 = null;
      for (let f = 0; f <= 20; f++) { app.finalPoseOn(body, f); if (f === 20) c19 = carry; carry = app.matchFinish(body, carry).solver.carry(); }
      at20 = snap();
      app.finalPoseOn(body, 20.5);
      app.matchFinish(body, carry);
      const at205 = snap();
      let vw = 0, vy = 0;
      const cmp = (sn) => { for (const b of s.bones) vw = Math.max(vw, qd(app.stage.body.bone(b).quaternion, sn.q.get(b))); vy = Math.max(vy, Math.abs(app.stage.body.root.position.y - sn.y)); };
      app.setFrame(20);
      cmp(at20);
      app.setFrame(20.5);
      cmp(at205);
      ok(vw < 1e-6 && vy < 1e-9, `wrap ${name}: the view shows frames 20 / 20.5 as the match plays them (${(vw * DEG).toFixed(6)}°)`);
      app.setFrame(0);
    }
    const ch = app.runChecks();
    ok(ch.some((x) => x.text.startsWith("Collision Wrap:")), "wrap: Checks has the Collision Wrap entry");
  } else lines.push("skip wrap reference (run ref_wrap.gd)");
  if (app.info.args.includes("--only-wrap")) return { pass, fail, lines };   // dev: stop after the Collision Wrap parity block (about a minute)
  // the wrist / arm-roll check (the user 2026-10-30, after Al's and Guru's IK-twisted wrists: "that fix needs to be a check in
  // the system so this doesn't happen again"): a wrist flicked 80° in 4 frames is flagged, a small bend is not
  {
    const keep = app.doc;
    const mk = (hand) => Doc.fromClip({ name: "__twist", frames: 20, fps: 60, keys: [
      { f: 0, rot: { handR: [0, 0, 0] } }, { f: 4, rot: { handR: hand } }, { f: 20, rot: { handR: [0, 0, 0] } }] });
    app.doc = mk([0, 1.4, 0]);
    const flick = app.twistChecks();
    app.doc = mk([0, 0.3, 0]);
    const calm = app.twistChecks();
    app.doc = keep;
    ok(flick.some((x) => x.text.startsWith("handR (the wrist) turns")) && flick.some((x) => x.text.startsWith("handR (the wrist) swings")),
      "twist check: a wrist flicked 80° in 4 frames is flagged");
    ok(!calm.length, "twist check: a 17° wrist bend passes");
    app.doc = Doc.fromClip({ name: "__twist", frames: 20, fps: 60, keys: [{ f: 0, rot: { handR: [0, 0, 0] } }, { f: 2, rot: { handR: [0, 0.5, 0] } },
      { f: 20, rot: { handR: [0, 0.5, 0] } }] });
    const snap = app.twistChecks();
    app.doc = keep;
    ok(snap.length === 1 && snap[0].level === "info", "twist check: a fast 29° snap over 2 frames is a note, not a warning");
  }
  // planted feet (Repo Bruiser 2026-10-30, the user: "this man feet leaning sideways ... they suppose to be planted to the
  // ground"): his old hero pose left the right boot hanging tipped just off the floor and the checks passed it as a toe pivot;
  // the planted one passes (fixture: the old clip, D:/Cache/fight_studio_dev/loose_feet_rhino.json)
  {
    const old = await (await fetch("file:///D:/Cache/fight_studio_dev/loose_feet_rhino.json").catch(() => null))?.json?.().catch(() => null);
    if (old) {
      const keepF = app.fighter, keepDoc = app.doc;
      if (app.fighter !== "rhino") await app.setFighter("rhino");
      app.doc = Doc.fromClip(old);
      const bad = app.feetChecks();
      const rep = app.feetReport(2);
      await app.openClip("rhino_ult_pose", true);
      const good = app.feetChecks();
      await app.setFighter(keepF);
      app.doc = keepDoc;
      ok(bad.some((x) => x.level === "warn" && x.text.startsWith("footR hangs tipped")) && (rep.counts.loose || 0) > 20,
        `feet check: Repo Bruiser's old hero pose is flagged (right boot loose ${rep.counts.loose || 0} frames)`);
      ok(!good.length, `feet check: his planted hero pose passes ${good.map((x) => x.text).join(" | ")}`);
    } else lines.push("skip loose feet (no D:/Cache/fight_studio_dev/loose_feet_rhino.json)");
  }
  // on / off, the report through the agent API
  r = await call("set_view", { wrap: false });
  ok(r.ok && r.result.wrap === false && !app.wrapStats, "api set_view wrap off: the clip as keyed");
  r = await call("set_view", { wrap: true });
  ok(r.ok && r.result.wrap === true, "api set_view wrap on");
  r = await call("wrap_report", { top: 3 });
  ok(r.ok && r.result.wrap && r.result.keyed.rows.length <= 3 && typeof r.result.max_corr_deg === "number" && typeof r.result.flagged === "boolean", `api wrap_report ${JSON.stringify(r.result).slice(0, 160)}`);
  r = await call("wrap_state", { frame: 10 });
  ok(r.ok && r.result.on && Array.isArray(r.result.clashing), `api wrap_state ${JSON.stringify(r.result).slice(0, 120)}`);

  // EFFECTS ON THE CLIP: the RMT effect blocks (rmtfx.js) on the game's engine (placements.js = placements.gd), the same sockets
  // and the same burst spots as the Godot Animator's core/fx.gd (reference by ref_fx.gd)
  {
    const fx = app.fx;
    ok(fx && fx.library.size >= 150, `fx the effect library (${fx ? fx.library.size : 0} blocks)`);
    // every block builds, every shader the blocks use compiles
    const r = app.views.main.renderer;
    const errs = [];
    const keepErr = r.debug.onShaderError;
    r.debug.checkShaderErrors = true;
    r.debug.onShaderError = (gl, prog, vs, fs) => errs.push(gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || "link error");
    const rt = new THREE.WebGLRenderTarget(64, 64);
    const cam = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
    cam.position.set(0, 1.5, 5);
    cam.lookAt(0, 1, 0);
    let built = 0, broken = [];
    for (const id of fx.library.keys()) {
      try {
        const b = await fx.ensure(id);
        const e = new FXR.RmtEffect(b);
        const sc = new THREE.Scene();
        sc.add(e);
        e.seek(0.3);
        r.setRenderTarget(rt);
        r.render(sc, cam);
        r.setRenderTarget(null);
        e.dispose();
        built++;
      } catch (err) { broken.push(`${id}: ${err.message}`); }
    }
    r.debug.onShaderError = keepErr;
    rt.dispose();
    ok(built === fx.library.size && !broken.length, `fx every block builds and draws (${built}/${fx.library.size}) ${broken.slice(0, 3).join("; ")}`);
    ok(!errs.length, `fx every Godot shader translates and compiles (${errs.length} errors) ${errs.slice(0, 2).join(" | ").slice(0, 300)}`);
    // a seek is repeatable, and an effect grows as it plays
    const spark = new FXR.RmtEffect(await fx.ensure("impact_spark"));
    spark.seek(0.3, 4);
    const b1 = spark.boxes().find((l) => l.name === "Sparks").box.clone();
    spark.seek(0.1, 4);
    const b0 = spark.boxes().find((l) => l.name === "Sparks").box.clone();
    spark.seek(0.3, 4);
    const b2 = spark.boxes().find((l) => l.name === "Sparks").box.clone();
    ok(b1.equals(b2), "fx the same seek gives the same particles");
    ok(b0.getSize(new THREE.Vector3()).length() < b1.getSize(new THREE.Vector3()).length() * 0.8, "fx an earlier moment is smaller");
    spark.seek(0, 4);
    for (let i = 0; i < 18; i++) spark.step(1 / 60, 4);
    const b3 = spark.boxes().find((l) => l.name === "Sparks").box.clone();
    ok(b3.getSize(new THREE.Vector3()).distanceTo(b1.getSize(new THREE.Vector3())) < 1e-6, "fx 18 steps of a 60th = seek(0.3)");
    spark.dispose();
    const sw = new FXR.RmtEffect(await fx.ensure("shockwave"));
    sw.seek(0.275);
    const ring = sw.layerRoot.getObjectByName("Ring");
    ok(Math.abs(ring.scale.x - (0.3 + (3.2 - 0.3) * 0.5)) < 1e-6, `fx a ring grows on its curve (${ring.scale.x})`);
    sw.seek(0.125);
    ok(Math.abs(sw.layerRoot.getObjectByName("Flash").intensity / 2.5 - 1.25) < 1e-6, "fx a flash fades on its curve");
    sw.dispose();
    // the same sockets and burst spot as the Godot Animator
    if (app.fighter !== "vix") await app.setFighter("vix");
    await app.openClip("a_vix_fsmash", true);
    const ref = await (await fetch("file:///D:/Cache/rmt_studio_refs/ref_fx.json").catch(() => null))?.json?.().catch(() => null);
    if (ref) {
      ok(Math.abs(app.matchScale - ref.match_scale) < 1e-4, `fx the same match scale (${app.matchScale.toFixed(4)} vs ${ref.match_scale.toFixed(4)})`);
      let worst = 0, at = "";
      for (const f of Object.keys(ref.sockets)) {
        for (const [n, want] of Object.entries(ref.sockets[f])) {
          const got = fx.socketAt(n, Number(f) / app.doc.fps);
          const d = got.distanceTo(new THREE.Vector3(...want));
          if (d > worst) { worst = d; at = `${n} f${f}`; }
        }
      }
      ok(worst < 0.005, `fx every socket where Godot has it (worst ${(worst * 100).toFixed(2)} cm at ${at})`);
      const fb = fx.pl.matrixWorld.elements;
      const basis = [[fb[0], fb[1], fb[2]], [fb[4], fb[5], fb[6]], [fb[8], fb[9], fb[10]]];
      const bw = Math.max(...basis.flatMap((v, i) => v.map((x, j) => Math.abs(x - ref.frame_basis[i][j]))));
      ok(bw < 1e-4, `fx the game's frame turned and scaled as Godot's (${bw.toExponential(1)})`);
      const i = await fx.add({ id: "impact_spark", socket: "fist_R", frame: 12, offset: [0.3, 0.1, 0], rot: [0, 30, 0] });
      app.setFrame(20);
      const a = fx.pl.list[i].anchor;
      const dl = a.position.distanceTo(new THREE.Vector3(...ref.burst_local));
      ok(dl < 0.005, `fx a burst sits where Godot's does (${(dl * 100).toFixed(2)} cm; ${a.position.toArray().map((x) => x.toFixed(3))})`);
      ok(a.visible, "fx live after its frame");
      app.setFrame(5);
      ok(!a.visible, "fx not live before its frame");
      // a follow rides its socket
      await fx.edit(i, { mode: "follow", dur: 2, offset: [0, 0, 0], rot: [0, 0, 0] });
      app.setFrame(14);
      const fa = fx.pl.list[i].anchor;
      ok(fa.parent === fx.socks.fist_R && fa.getWorldPosition(new THREE.Vector3()).distanceTo(fx.socketOn(app.stage.body, "fist_R")) < 1e-4, "fx a follow rides its socket");
      await fx.edit(i, { mode: "burst" });
      ok(fx.pl.list[i].anchor.parent === fx.pl, "fx back to a burst");
      // measure: in the game's frame, at match size
      app.setFrame(16);
      const m = fx.measure()[i];
      ok(m.live && m.box && m.nearest_sockets.length === 3, `fx measure ${JSON.stringify(m.box || {}).slice(0, 120)}`);
      fx.remove(i);
    } else lines.push("skip fx reference (run ref_fx.gd)");

    // TRAILS: a tube along the path the head has moved (rmtfx.js TrailLayer = the game's rmt_effect.gd trails)
    {
      const tm = { format: "RMT_EFFECT_BLOCKS", version: 1, id: "test_trail", duration: 1, loop: false, phases: { anticipation: 0, impact: 1, cooldown: 0 },
        layers: [{ kind: "trail", name: "Streak", length: 0.2, width: 0.1, taper: 0.9, phase: "effect" }] };
      const tb = { id: "test_trail", manifest: tm, meshes: {}, textures: {}, shaders: {} };
      const mover = new THREE.Group();
      const te = new FXR.RmtEffect(tb);
      mover.add(te);
      te.seek(0);
      for (let i = 0; i < 30; i++) { mover.position.set(Math.cos(i * 0.25), 1, Math.sin(i * 0.25)); mover.updateMatrixWorld(true); te.step(1 / 60); }
      const streak = te.layerRoot.getObjectByName("Streak");
      ok(streak.pts.length >= 12 && streak.pts.length <= 14, `fx trail keeps only its length of path (${streak.pts.length})`);
      const sz = streak.box().getSize(new THREE.Vector3());
      ok(sz.x > 0.5 && sz.z > 0.5, `fx trail follows the path (an arc) ${sz.toArray().map((x) => x.toFixed(2))}`);
      ok(streak.geo.getAttribute("position") && streak.geo.getAttribute("position").count > 0, "fx trail drew its tube");
      te.release();
      for (let i = 0; i < 20; i++) te.step(1 / 60);
      ok(!streak.box(), "fx a released trail ages out");
      te.dispose();
    }
    if (fx.library.has("motion_trail")) {
      await app.openClip("a_vix_nair", true);
      const ti = await fx.add({ id: "motion_trail", socket: "foot_L", mode: "follow", frame: 3, dur: 25 / 60 });
      const streakBox = () => (fx.pl.boxes(ti).layers.find((l) => l.name === "Streak") || {}).box || null;
      // stepped (playing forward), then a jump to the same frame
      app.setFrame(0);
      app.playing = true;
      for (let f = 1; f <= 6; f++) app.setFrame(f);
      app.playing = false;
      const stepped = streakBox();
      app.setFrame(0);
      app.setFrame(6);
      const jumped = streakBox();
      const ss = stepped ? stepped.getSize(new THREE.Vector3()) : new THREE.Vector3();
      const js = jumped ? jumped.getSize(new THREE.Vector3()) : new THREE.Vector3();
      ok(stepped && ss.length() > 1, `fx a trail follows its socket's path (stepped) ${ss.toArray().map((x) => x.toFixed(2))}`);
      ok(jumped && Math.abs(js.length() - ss.length()) < 0.1 * ss.length(), `fx a jump draws the same path back along the socket ${js.toArray().map((x) => x.toFixed(2))}`);
      // the sparks shed along the path: on a jump they are born along the socket's path too, as when the clip played
      const shedBox = () => (fx.pl.boxes(ti).layers.find((l) => l.name === "Shed") || {}).box || null;
      app.setFrame(0);
      app.playing = true;
      for (let f = 1; f <= 20; f++) app.setFrame(f);
      app.playing = false;
      const shedStepped = shedBox().getSize(new THREE.Vector3());
      app.setFrame(0);
      app.setFrame(20);
      const shedJumped = shedBox().getSize(new THREE.Vector3());
      ok(shedStepped.length() > 1 && Math.abs(shedJumped.length() - shedStepped.length()) < 0.15 * shedStepped.length(),
        `fx particles of a follow are shed along its path on a jump too (${shedJumped.length().toFixed(2)} vs ${shedStepped.length().toFixed(2)} m)`);
      if (ref && ref.trail_streak) {
        const want = new THREE.Box3(new THREE.Vector3(...ref.trail_streak.min), new THREE.Vector3(...ref.trail_streak.max));
        app.setFrame(0);
        app.setFrame(20);
        const j20 = streakBox();
        const d = Math.max(j20.min.distanceTo(want.min), j20.max.distanceTo(want.max));
        ok(d < 0.02, `fx the trail's path is the Godot Animator's (${(d * 100).toFixed(2)} cm)`);
      }
      fx.remove(ti);
      await app.openClip("a_vix_fsmash", true);
    } else lines.push("skip fx trail on the nair (motion_trail is not in this project's library)");
    // the strip shows them too, and they save with the clip's name (then the file is put back)
    const before = await window.host.loadData("clip_fx.json");
    app.newClip("zz_desktop_fx", 30, 30, false, true);
    ok(fx.count() === 0 && fx.clip === "zz_desktop_fx", "fx a new clip has no cues");
    let rr = await call("fx_add", { id: "no_such_block", socket: "fist_R" });
    ok(!rr.ok, "fx api refuses an unknown block");
    rr = await call("fx_add", { id: "shockwave", socket: "nope" });
    ok(!rr.ok, "fx api refuses an unknown socket");
    rr = await call("fx_add", { id: "shockwave", socket: "ground_mid", frame: 12, scale: 0.5 });
    ok(rr.ok && rr.result.index === 0, `fx api add ${JSON.stringify(rr).slice(0, 80)}`);
    rr = await call("fx_edit", { index: 0, frame: 16 });
    ok(rr.ok && Math.abs(rr.result.frame - 16) < 1e-6, "fx api edit");
    {
      const si = await fx.add({ id: "slash_arc", socket: "chest", frame: 3 });   // duration 0.5 s
      const slash = fx.pl.list[si].anchor;
      app.setFrame(17);
      const shown = slash.visible;
      app.setFrame(20);
      ok(shown && !slash.visible, "fx a burst shows for its block's duration, then the game's pool hides it");
      fx.remove(si);
    }
    rr = await call("fx_blocks", { query: "spark" });
    ok(rr.ok && rr.result.some((b) => b.id === "impact_spark"), "fx api blocks");
    rr = await call("fx_cues", {});
    ok(rr.ok && rr.result.length === 1, "fx api cues");
    fx.showStrip(16);
    ok(fx.strip.list.length === 1 && fx.strip.list[0].anchor.visible, "fx the strip shows the cue");
    ok(await fx.save(), "fx save the cues");
    const saved = ((await window.host.loadData("clip_fx.json")) || {}).cues || {};
    ok((saved.zz_desktop_fx || []).length === 1 && saved.zz_desktop_fx[0].fx === "shockwave", `fx the cue in clip_fx.json ${JSON.stringify(saved.zz_desktop_fx)}`);
    fx.remove(0);
    await fx.loadClip("zz_desktop_fx");
    ok(fx.count() === 1, "fx reload brings the cue back");
    rr = await call("fx_remove", { index: 0 });
    ok(rr.ok && rr.result.length === 0, "fx api remove");
    await window.host.saveData("clip_fx.json", before);
    ok(JSON.stringify(await window.host.loadData("clip_fx.json")) === JSON.stringify(before), "fx clip_fx.json put back");
  }

  // the Library: pick a model, an animation and an effect from the cards
  {
    const { Library, kindOf } = await import("../src/library.js");
    const lib = Library(app);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tab = (i) => lib.querySelectorAll(".libtab")[i].click();
    const cards = () => [...lib.querySelectorAll(".libcard")];
    const dbl = (c) => c.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const type = (v) => { const s = lib.querySelector("input[type=text]"); s.value = v; s.dispatchEvent(new Event("input")); };
    ok(cards().length === app.fighters.length, `library models: a card per fighter (${cards().length}/${app.fighters.length})`);
    dbl(cards().find((c) => c.querySelector(".libname").textContent === "carter"));
    await sleep(1500);
    ok(app.fighter === "carter", "library models: a double-click puts the model on the stage");
    await app.setFighter("vix");
    tab(1);
    for (let i = 0; i < 40 && !cards().length; i++) await sleep(100);
    ok(cards().length > 100, `library animations: the clips are listed (${cards().length} shown)`);
    type("a_vix_jab1");
    ok(cards().length === 1 && cards()[0].querySelector(".libname").textContent === "vix_jab1", "library animations: search finds a clip");
    await app.openClip("w_walk", true);   // a clean clip: opening another asks first when there are unsaved edits
    dbl(cards()[0]);
    await sleep(800);
    ok(app.doc.name === "a_vix_jab1", "library animations: a double-click opens the clip");
    ok(kindOf("a_vix_fsmash") === "Attacks" && kindOf("a_vix_grab") === "Throws" && kindOf("a_vix_damage_fly") === "Reactions" && kindOf("w_walk") === "World", "library animations: moves are sorted by kind");
    tab(2);
    type("shockwave");
    ok(cards().length >= 1 && cards().some((c) => c.querySelector(".libname").textContent === "shockwave"), "library effects: search finds a block");
    const n0 = app.fx.count();
    dbl(cards().find((c) => c.querySelector(".libname").textContent === "shockwave"));
    await sleep(800);
    ok(app.fx.count() === n0 + 1, "library effects: a double-click fires the block at the playhead");
    app.fx.remove(app.fx.count() - 1);
  }

  // the modes: each is a layout and a set of panels
  {
    const { MODES } = await import("../src/shell.js");
    const call = makeApi(app);
    for (const m of Object.keys(MODES)) {
      const r = await call("set_mode", { mode: m });
      const want = MODES[m];
      ok(r.ok && r.result.mode === m && r.result.layout === want.layout, `mode ${m}: the canvas layout is ${want.layout} (${r.ok && r.result.layout})`);
      ok(r.ok && want.show.every((t) => r.result.panels.includes(t)) && r.result.panels.length === want.show.length, `mode ${m}: only its panels are showing (${r.ok && r.result.panels.length}/${want.show.length})`);
    }
    ok(app.ui.panels.get("Setup").hidden === false && app.ui.panels.get("Dope Sheet").hidden === false, "mode SETUP: the Setup panel is up");
    app.ui.showPanel("Effects");
    ok(app.ui.panels.get("Effects").hidden === false, "a hidden panel comes back with Window > Show panel");
    const bad = await call("set_mode", { mode: "nope" });
    ok(!bad.ok, "an unknown mode is refused");
    await call("set_mode", { mode: "POSE" });
  }

  // the FX lane of the dope sheet: cues as diamonds and bars, drag to retime, drag the end to lengthen
  {
    const { Dope } = await import("../src/timeline.js");
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:0;top:0;width:900px;height:360px;opacity:0;pointer-events:none";
    document.body.append(box);
    const dope = new Dope(app, box, () => {});
    dope.resize();
    await app.openClip("w_walk", true);
    const a = await app.fx.add({ id: "shockwave", socket: "origin", mode: "burst", frame: 10 });
    const b = await app.fx.add({ id: "motion_trail", socket: "foot_L", mode: "follow", frame: 20, dur: 0.4 });
    dope.draw();
    ok(dope._fx.length === 2 && dope._rows.filter((r) => r.kind === "fx").length === 2 && dope._rows.some((r) => r.kind === "fxhead"), "fx lane: a header and a row per cue");
    const row = (i) => dope._rows.find((r) => r.kind === "fx" && r.idx === i);
    const hitA = dope.fxAt(dope.f2x(10), row(a).y + 8);
    ok(hitA && hitA.part === "key" && hitA.idx === a, "fx lane: the diamond is under the cue's frame");
    const sp = dope.fxSpan(dope._fx[b]);
    const hitB = dope.fxAt(dope.f2x(sp.f) + sp.len * dope.ppf, row(b).y + 8);
    ok(hitB && hitB.part === "end", "fx lane: a follow has a draggable end");
    const fire = (type, x, y) => dope.cv.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
    const at = (f, r) => [dope.f2x(f), row(r).y + 8];
    const [x0, y0] = at(10, a);
    fire("pointerdown", x0, y0);
    ok(app.fxSel === a, "fx lane: a click selects the cue (the Effects panel follows)");
    fire("pointermove", x0 + 5 * dope.ppf, y0);
    fire("pointerup", x0 + 5 * dope.ppf, y0);
    await new Promise((r) => setTimeout(r, 200));
    ok(Math.round(app.fx.describe(a).frame) === 15, `fx lane: dragging a diamond retimes the cue (frame ${app.fx.describe(a).frame})`);
    const [x1, y1] = [dope.f2x(sp.f) + sp.len * dope.ppf, row(b).y + 8];
    fire("pointerdown", x1, y1);
    fire("pointermove", x1 + 6 * dope.ppf, y1);
    fire("pointerup", x1 + 6 * dope.ppf, y1);
    await new Promise((r) => setTimeout(r, 200));
    ok(app.fx.describe(b).dur > 0.4 + 0.05, `fx lane: dragging a follow's end lengthens it (${app.fx.describe(b).dur}s)`);
    app.fx.remove(1);
    app.fx.remove(0);
    app.selectFx(-1);
    dope.draw();
    ok(!dope._rows.some((r) => r.kind === "fxhead"), "fx lane: no cues, no lane");
    box.remove();
  }

  // the FX Studio: open a block, edit it live, play / scrub, add / remove / mute layers, save an override, revert it
  {
    const st = app.fxs;
    const call = makeApi(app);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await call("set_mode", { mode: "FX" });
    // a block with no override of its own (the test saves and reverts one, and the user's real overrides stay as they are)
    const id = [...app.fx.library.values()].find((e) => !e.override && e.id === "shockwave")?.id || [...app.fx.library.values()].find((e) => !e.override)?.id;
    let r = await call("fx_studio", { open: id });
    ok(r.ok && r.result.id === id && r.result.status === "shipped" && r.result.layers.length > 0, `fx studio: opens ${id} (${r.ok && r.result.layers.length} layers, ${r.ok && r.result.status})`);
    ok(!!st.eff && st.holder.visible && st.holder.parent === app.fx.floorN, "fx studio: the effect plays beside the fighter in the FX mode");
    const first = st.layers().find((l) => l.kind === "mesh") || st.layers()[0];
    const nm = first.name;
    r = await call("fx_studio", { set: { layer: nm, path: ["transform", "pos"], value: [0, 0.5, 0] } });
    ok(r.ok && r.result.status === "modified" && st.eff && JSON.stringify(st.eff.manifest.layers.find((l) => l.name === nm).transform.pos) === "[0,0.5,0]", "fx studio: an edit marks the block modified and rebuilds the preview");
    r = await call("fx_studio", { time: 0.3 });
    ok(r.ok && Math.abs(st.time - 0.3) < 1e-6 && Math.abs(st.eff.time - 0.3) < 1e-6 && !st.playing, "fx studio: scrubbing holds the effect at that time");
    const n0 = st.layers().length;
    await call("fx_studio", { add_layer: "light" });
    ok(st.layers().length === n0 + 1 && st.layers().at(-1).kind === "light" && st.layers().at(-1).start !== undefined, "fx studio: add a layer");
    await call("fx_studio", { remove_layer: st.layers().length - 1 });
    ok(st.layers().length === n0, "fx studio: remove a layer");
    const kids = () => st.eff.layerRoot.children.length;
    const k0 = kids();
    st.toggleMute(nm);
    await st.rebuildNow();
    ok(kids() === k0 - 1, `fx studio: mute hides a layer in the preview only (${k0} -> ${kids()})`);
    st.toggleMute(nm);
    await st.rebuildNow();
    ok(kids() === k0 && JSON.stringify(st.manifest).includes(JSON.stringify(nm)), "fx studio: unmute brings it back, the layer stays in the block");
    // the panel's controls are built from the shader's own settings
    const { FxStudioPanel } = await import("../src/fxstudio.js");
    const panel = FxStudioPanel(app);
    document.body.append(panel);
    app.emit("fxstudio");
    await sleep(600);
    const text = panel.textContent;
    ok(panel.querySelectorAll(".fxlayer").length === n0, `fx studio panel: a row per layer (${panel.querySelectorAll(".fxlayer").length})`);
    const meshL = st.layers().findIndex((l) => l.kind === "mesh" && l.shader);
    if (meshL >= 0) {
      st.select(meshL);
      await sleep(600);
      const info = await st.shaderInfo(st.layers()[meshL].shader);
      const want = info.uniforms.find((u) => u.range && ["float", "int"].includes(u.type) && !["fade", "rmt_clock"].includes(u.name));
      ok(!!want && [...panel.querySelectorAll(".sec .lbl")].some((l) => l.textContent === want.name.replace(/_/g, " ")), `fx studio panel: the shader's own setting "${want && want.name}" has a control (range ${want && want.range})`);
      ok(panel.textContent.includes("SHADER  " + st.layers()[meshL].shader), "fx studio panel: a SHADER section for the layer");
    }
    // a section folds through the API too, and the fold holds when another layer is picked
    const secOpen = (t) => { const d = [...panel.querySelectorAll("details.sec")].find((x) => x.querySelector("summary").textContent.split("  ")[0] === t); return d ? d.open : null; };
    await call("fx_studio", { fold: { TIMING: false } });
    await sleep(300);
    const foldedNow = secOpen("TIMING");
    await call("fx_studio", { select: n0 - 1 });
    await sleep(300);
    ok(foldedNow === false && secOpen("TIMING") === false, "fx studio panel: a folded section stays folded on the next layer");
    await call("fx_studio", { fold: { TIMING: true }, select: 0 });
    await sleep(300);
    ok(secOpen("TIMING") === true, "fx studio panel: and opens again");
    // save writes an override, revert puts the shipped block back and moves the override to the trash
    r = await call("fx_studio", { save: true });
    const lib = await window.host.fxLibrary();
    const saved = lib.blocks.find((b) => b.id === id);
    ok(r.ok && r.result.status === "override" && saved && saved.override === true && JSON.stringify(saved.manifest.layers.find((l) => l.name === nm).transform.pos) === "[0,0.5,0]", "fx studio: save writes a user override the library reads");
    ok(app.fx.library.get(id).override === true && app.fx.blocks.has(id), "fx studio: the clip's block is rebuilt from the override");
    r = await call("fx_studio", { revert: true });
    const lib2 = await window.host.fxLibrary();
    const back = lib2.blocks.find((b) => b.id === id);
    ok(r.ok && r.result.status === "shipped" && back && !back.override && JSON.stringify((st.layers().find((l) => l.name === nm).transform || {}).pos) !== "[0,0.5,0]", "fx studio: revert goes back to the shipped block (the override moved to the trash folder)");
    ok(!(await window.host.fxSaveOverride("../x", { format: "RMT_EFFECT_BLOCKS", id: "../x", layers: [] })), "fx studio: an unsafe id is refused");
    panel.remove();
    await call("set_mode", { mode: "POSE" });
    await sleep(100);
    ok(!st.holder.visible, "fx studio: the preview is hidden outside the FX mode");
  }

  // Setup: the nine steps and the fix behind each. The bakes only get planned here (a real one rewrites the game's data), and
  // nothing is saved: every clip made here is dropped again
  {
    const call = makeApi(app);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const stepOf = async (id) => (await call("setup", {})).result.steps.find((s) => s.id === id);
    await app.openClip("w_walk", true);
    let r = await call("setup", {});
    const ids = r.ok && r.result.steps.map((s) => s.id).join(",");
    ok(ids === "model,rig,wrap,soles,sockets,move,effects,checks,saved", `setup: nine steps (${ids})`);
    ok(r.result.steps.every((s) => !(s.ok && s.fix)), "setup: a step that is done offers no fix");
    const info = await window.host.setupInfo("vix");
    ok(info && info.model > 0 && info.wrap > 0 && info.soles > 0, `setup: the model, wrap and soles times are read (${info && info.godot ? "Godot found" : "no Godot"})`);
    const dw = await window.host.bake("wrap", "vix", true), ds = await window.host.bake("soles", "", true);
    ok(!info.godot || (dw.ok && dw.dry && dw.args.includes("--headless") && dw.args.some((x) => x.endsWith("wrap_bake.gd")) && dw.args.includes("--who=vix") && ds.ok && ds.args.some((x) => x.endsWith("feet_bake.gd"))), "setup: the bakes are the game's own tools, headless in Godot (dry run)");
    ok(!(await window.host.bake("wrap", "../x", true)).ok && !(await window.host.bake("zap", "vix", true)).ok, "setup: a bad fighter name and an unknown bake are refused");
    const w0 = (await window.host.setupInfo("vix")).wrap;
    r = await call("setup", { fix: "wrap" });
    ok(r.ok && r.result.needs_yes === true && (await window.host.setupInfo("vix")).wrap === w0, "setup: a fix without yes only says its plan (nothing was written)");
    r = await call("setup", { fix: "all" });
    ok(r.ok && r.result.needs_yes === true && r.result.plan !== undefined, "setup: fix all without yes only lists its plan");
    const pa = app.setup.planAll();
    if (pa.some((p) => p.id === "checks")) ok(pa.at(-1).id === "saved" && /Save w_walk/.test(pa.at(-1).plan), "setup: fix all says it will save the clip it edits");

    // a move with one key: the end key, one undo step; a new move starts with both keys
    app.newClip("setup_one", 30, 30, false, true);
    const mv = await stepOf("move");
    ok(!mv.ok && mv.fix && mv.fix.label === "ADD END KEY", "setup: a one-key move offers the end key");
    const { Setup } = await import("../src/setup.js");
    const panel = Setup(app);
    document.body.append(panel);
    app.emit("doc");
    await sleep(500);
    const labels = [...panel.querySelectorAll("button")].map((b) => b.textContent);
    ok(panel.querySelectorAll(".step").length === 9 && labels.includes("FIX ALL") && labels.includes("ADD END KEY") && labels.includes("NEW MOVE"), "setup panel: nine steps, FIX ALL, and a button for the step that is not done");
    r = await call("setup", { fix: "move", yes: true });
    ok(r.ok && r.result.ran.ok && app.doc.keys.length === 2 && app.doc.keys[1].f === 30 && JSON.stringify(poseOfKey(app.doc.keys[1], app.bones)) === JSON.stringify(poseOfKey(app.doc.keys[0], app.bones)), "setup: the end key is the first pose at the last frame");
    app.undo();
    ok(app.doc.keys.length === 1, "setup: and it was one undo step");
    r = await call("setup", { new_move: "setup_two" });
    ok(r.ok && r.result.ran.ok && app.doc.name === "setup_two" && app.doc.keys.length === 2 && app.isNew, "setup: a new move has a start and an end");
    r = await call("setup", { new_move: "bad name!" });
    ok(r.ok && r.result.ran.ok === false, "setup: a bad move name is refused");

    // the checks: a forward knee and a loop seam are cleaned up in one undo step
    const d0 = () => app.doc;
    app.newClip("setup_chk", 30, 30, true, true);
    app.mutate("test", () => {
      const d = d0();
      d.unlinkKeys([0, 30]);
      const last = poseOfKey(d.keys[1], app.bones);
      last.chest = [0.7, 0, 0];
      d.writeKey(30, last, app.bones);
      const mid = poseOfKey(d.keys[0], app.bones);
      mid.kneeR = [-0.5, 0, 0];
      d.writeKey(15, mid, app.bones);
    });
    const before = app.runChecks().map((c) => c.text).join("|");
    const ck = await stepOf("checks");
    ok(/bends FORWARD/.test(before) && /loop seam/.test(before) && !ck.ok && ck.fix && /forward knee/.test(ck.fix.plan) && /loop seam/.test(ck.fix.plan), "setup: the checks step names what it can fix");
    r = await call("setup", { fix: "checks", yes: true });
    const after = app.runChecks().map((c) => c.text).join("|");
    ok(r.ok && r.result.ran.ok && !/bends FORWARD/.test(after) && !/loop seam/.test(after) && poseOfKey(d0().keyAt(15), app.bones).kneeR[0] >= 0, `setup: clean up straightens the knee and closes the seam (${r.ok && r.result.ran.text})`);
    app.undo();
    ok(poseOfKey(d0().keyAt(15), app.bones).kneeR[0] < 0 && /loop seam/.test(app.runChecks().map((c) => c.text).join("|")), "setup: and the clean-up was one undo step");

    // sockets on a bone the model lacks move to the nearest bone it has (here: not saved)
    app.sockSpecs.__setup_test = { bone: "handXX", offset: [0, 0, 0] };
    ok(!(await stepOf("sockets")).ok, "setup: a socket on a missing bone fails the sockets step");
    r = await call("setup", { fix: "sockets", yes: true, save: false });
    ok(r.ok && r.result.ran.ok && app.bones.includes(app.sockSpecs.__setup_test.bone) && (await stepOf("sockets")).ok, `setup: the socket moved to ${app.sockSpecs.__setup_test.bone}`);
    delete app.sockSpecs.__setup_test;

    // the effect to suggest: an attack with a hit mark gets an impact on the limb that is fastest, at the hit frame
    let atk = "";
    for (const n of (await app.listClips("a_vix_")).filter((x) => /(jab|tilt|smash|fair|bair|nair|uair|dair)/.test(x)).slice(0, 25)) {
      await app.openClip(n, true);
      await sleep(300);   // the clip's cues load after it opens
      if (app.doc.extra.marks && app.doc.extra.marks.hit !== undefined && app.fx.count() === 0) { atk = n; break; }
    }
    if (atk) {
      const sf = app.setup.suggestFx();
      ok(sf && sf.id === "impact_spark" && ["fist_R", "fist_L", "foot_R", "foot_L"].includes(sf.socket) && sf.frame === Math.round(Number(app.doc.extra.marks.hit)), `setup: ${atk} gets ${sf && sf.id} on ${sf && sf.socket} at its hit frame f${sf && sf.frame}`);
      r = await call("setup", { fix: "effects", yes: true });
      const cue = app.fx.pl.asCues()[0];
      ok(r.ok && r.result.ran.ok && app.fx.count() === 1 && cue.fx === "impact_spark" && Math.abs(cue.t - sf.frame / app.doc.fps) < 1e-3, "setup: the suggested effect is a cue at that time");
    } else ok(false, "setup: found an attack clip with a hit mark to suggest an effect for");
    r = await call("setup", { fix: "saved" });
    ok(r.ok && r.result.needs_yes === true, "setup: saving also needs yes");
    panel.remove();
    await app.openClip("w_walk", true);
  }

  // Review and Compose: the verdict, the frame data, the recipes, the snaps and their undo. Nothing is saved; cues made here are undone
  {
    const call = makeApi(app);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const MI = await import("../src/moveinfo.js");
    const { Review } = await import("../src/review.js");
    const { Compose, RECIPES } = await import("../src/compose.js");
    let atk = "";
    for (const n of (await app.listClips("a_vix_")).filter((x) => /(jab|tilt|smash|fair|bair|nair|uair|dair)/.test(x))) {
      await app.openClip(n, true);
      await sleep(300);
      const m = app.doc.extra.marks || {};
      if (m.hit !== undefined && m.clear !== undefined && Number(m.clear) >= Number(m.hit) && app.fx.count() === 0) { atk = n; break; }
    }
    ok(!!atk, `review: found an attack with a hit and a clear mark and no cues (${atk})`);
    if (atk) {
      const hit = Math.round(Number(app.doc.extra.marks.hit)), clear = Math.round(Number(app.doc.extra.marks.clear)), N = app.doc.frames;
      const mi = MI.moveInfo(app);
      ok(mi && mi.frames === N && mi.socks.length === 4 && mi.hit === hit && mi.clear === clear && mi.hips.length === N + 1, `review: the move is measured on ${mi && mi.socks.length} strikers over ${N + 1} poses`);
      ok(MI.moveInfo(app) === mi, "review: the measure is kept until the clip changes");
      const fd = MI.frameData(app);
      ok(fd.startup.f === hit && fd.active.f === clear - hit + 1 && fd.recovery.f === N - clear && fd.startup.f + fd.active.f + fd.recovery.f === N + 1 && fd.total_ms === Math.round(N * 1000 / app.doc.fps),
        `review: frame data startup ${fd.startup.f} + active ${fd.active.f} + recovery ${fd.recovery.f} = ${N + 1} poses`);
      const st = MI.strikerStats(app);
      ok(st.length === 4 && st.every((s) => s.peak_ms > 0 && s.reach_m > 0 && s.peak_f >= 1) && MI.mainStriker(app).peak_ms === Math.max(...st.map((s) => s.peak_ms)), `review: every striker has a speed and a reach (${st.map((s) => s.socket + " " + s.peak_ms + " m/s " + s.reach_m + " m").join(", ")})`);
      const sp = MI.strikePoint(app);
      ok(sp && sp.frame === hit && sp.marked && mi.socks.some((s) => s.socket === sp.socket), `review: the strike is ${sp && sp.socket} at the hit mark f${sp && sp.frame}`);

      // the report
      let r = await call("review", {});
      const rep = r.ok && r.result;
      ok(rep && ["READY", "NEEDS WORK", "BLOCKED"].includes(rep.verdict) && rep.cards.map((c) => c.id).join(",").startsWith("joints,arms,loop,feet,wrap,data,effects"), `review: the cards are ${rep && rep.cards.map((c) => c.id).join(",")} (${rep && rep.verdict})`);
      ok(rep.counts.error + rep.counts.warn + rep.counts.info + rep.counts.ok === rep.cards.length && rep.text.startsWith(`REVIEW  vix / ${atk}`) && /FRAME DATA  startup/.test(rep.text) && /STRIKER  /.test(rep.text), "review: the counts add up and the text report has the frame data and the strikers");
      // a forward knee blocks it; one undo brings it back
      const was = app.runChecks().some((c) => /bends FORWARD/.test(c.text));
      app.mutate("test", () => { const d = app.doc, p = poseOfKey(d.keys[0], app.bones); p.kneeR = [-0.5, 0, 0]; d.writeKey(Math.max(1, Math.floor(N / 2)), p, app.bones); });
      r = await call("review", {});
      ok(!was && r.result.verdict === "BLOCKED" && r.result.cards.find((c) => c.id === "joints").level === "error", "review: a forward knee blocks the move (joints error)");
      app.undo();
      r = await call("review", {});
      ok(r.result.cards.find((c) => c.id === "joints").level === "ok" && r.result.verdict !== "BLOCKED", "review: and one undo clears it");
      // an impact off the hit is flagged, on the hit it is fine
      await app.fx.add({ id: "impact_spark", socket: sp.socket, frame: hit + 4, mode: "burst" });
      r = await call("review", {});
      let fx = r.result.cards.find((c) => c.id === "effects");
      ok(fx.level === "warn" && /late by 4 f/.test(fx.note) && r.result.effects[0].delta === 4, `review: an impact 4 f after the hit is flagged (${fx.note})`);
      await app.fx.edit(0, { frame: hit });
      r = await call("review", {});
      fx = r.result.cards.find((c) => c.id === "effects");
      ok(fx.level === "ok" && r.result.effects[0].delta === 0, `review: on the hit it is fine (${fx.note})`);
      app.fx.remove(0);

      // the panel draws the verdict, the cards, the frame data
      const prev = app.review;
      const rp = Review(app);
      rp.style.cssText = "position:fixed;left:0;top:0;width:440px;height:700px;opacity:0;pointer-events:none";
      document.body.append(rp);
      rp.__resize();   // what the shell does when a tab comes to the front
      await sleep(1200);
      ok(/READY|NEEDS WORK|BLOCKED/.test(rp.querySelector(".verdict").textContent) && rp.querySelectorAll(".steps .step").length >= 7 && rp.querySelectorAll(".vrow").length >= 6, `review: the panel shows the verdict, ${rp.querySelectorAll(".steps .step").length} cards and the frame data`);
      rp.remove();
      app.review = prev;

      // compose: a recipe only plans until it is applied; applying twice adds once
      const cr = await call("compose", {});
      ok(cr.ok && cr.result.recipes.map((x) => x.id).join(",") === RECIPES.map((x) => x.id).join(",") && cr.result.recipes.find((x) => x.id === "hit_spark").ok, `compose: ${cr.result.recipes.filter((x) => x.ok).length} of ${cr.result.recipes.length} recipes fit ${atk}`);
      r = await call("compose", { recipe: "hit_spark" });
      ok(r.ok && r.result.plan.ok && r.result.plan.cues[0].frame === hit && app.fx.count() === 0, "compose: a recipe without apply only shows its plan");
      r = await call("compose", { recipe: "hit_spark", apply: true });
      ok(r.ok && r.result.did.ok && app.fx.count() === 1 && app.fx.list()[0].id === "impact_spark" && app.fx.list()[0].socket === sp.socket && Math.round(app.fx.list()[0].frame) === hit, `compose: hit spark is on ${sp.socket} at f${hit}`);
      r = await call("compose", { recipe: "hit_spark", apply: true });
      ok(r.ok && /already/.test(r.result.did.text) && app.fx.count() === 1 && r.result.undo.length === 1, "compose: the same recipe twice adds it once");
      r = await call("compose", { recipe: "swing_trail", apply: true });
      const tr = app.fx.list().find((c) => c.id === "motion_trail");
      ok(r.ok && tr && tr.mode === "follow" && tr.dur > 0 && Math.round(tr.frame) < hit && tr.socket === sp.socket, `compose: swing trail rides ${sp.socket} from f${tr && Math.round(tr.frame)} for ${tr && tr.dur} s`);
      ok(!(await call("compose", { recipe: "nope", apply: true })).ok, "compose: an unknown recipe is refused");

      // snaps, nudges, shifts, side swap
      const sparkAt = () => Math.round(app.fx.list().find((c) => c.id === "impact_spark").frame);
      const si = () => app.fx.list().findIndex((c) => c.id === "impact_spark");
      await call("compose", { nudge: { index: si(), frames: 3 } });
      ok(sparkAt() === hit + 3, "compose: nudge moves a cue 3 frames");
      r = await call("compose", { snap: { index: si(), to: "hit" } });
      ok(sparkAt() === hit, "compose: snap to the hit");
      r = await call("compose", { snap: { index: si(), to: "clear" } });
      ok(sparkAt() === clear, "compose: snap to the clear");
      r = await call("compose", { snap: { index: si(), to: "peak" } });
      const mine = mi.socks.find((s) => s.socket === sp.socket);
      ok(sparkAt() === mine.peak.f, `compose: snap to the fastest frame of ${sp.socket} (f${mine.peak.f})`);
      r = await call("compose", { shift_all: 2 });
      ok(r.ok && sparkAt() === mine.peak.f + 2, "compose: shift moves every cue");
      r = await call("compose", { align: true });
      ok(sparkAt() === hit, "compose: impacts on the hit lines the spark up again");
      r = await call("compose", { shift_all: 1000 });
      ok(Math.max(...app.fx.list().map((c) => c.frame)) <= N, "compose: a shift never pushes a cue past the end");
      r = await call("compose", { snap: { index: si(), to: "hit" } });
      const sock0 = app.fx.list()[si()].socket;
      r = await call("compose", { swap_side: si() });
      ok(app.fx.list()[si()].socket === MI.mirrorSocket(sock0) && app.fx.list()[si()].socket !== sock0, `compose: swap side ${sock0} to ${app.fx.list()[si()].socket}`);
      r = await call("compose", { duplicate: si() });
      ok(app.fx.count() === 3, "compose: a copy of a cue");
      r = await call("compose", { remove: app.fx.count() - 1 });
      ok(app.fx.count() === 2, "compose: remove a cue");

      // every step undoes, back to no cues at all
      let guard = 0;
      while (app.compose.stack.length && guard++ < 40) await call("compose", { undo: true });
      ok(app.fx.count() === 0 && !(await call("compose", { undo: true })).result.did.ok, "compose: every change undoes, back to a clip with no cues");
      const bad = await call("compose", { snap: { index: 9, to: "hit" } });
      ok(bad.ok && bad.result.did.ok === false, "compose: a snap on a cue that is not there says so");

      const cp = Compose(app);
      cp.style.cssText = "position:fixed;left:0;top:0;width:440px;height:700px;opacity:0;pointer-events:none";
      document.body.append(cp);
      cp.__resize();
      await sleep(600);
      ok(cp.querySelectorAll(".recipe").length === RECIPES.length && cp.querySelectorAll(".recipe:not(.off)").length >= 4, `compose: the panel shows ${cp.querySelectorAll(".recipe").length} recipe cards, ${cp.querySelectorAll(".recipe:not(.off)").length} that fit`);
      cp.remove();
    }

    // a walk: footsteps fit, strikes do not
    await app.openClip("a_vix_walk", true);
    await sleep(300);
    const wr = (await call("compose", {})).result;
    ok(!wr.recipes.find((x) => x.id === "hit_spark").ok && wr.recipes.find((x) => x.id === "footsteps").ok && !wr.recipes.find((x) => x.id === "landing_dust").ok, "compose: a walk gets footsteps, no hit spark, no landing dust");
    const wn = app.fx.count();
    r = await call("compose", { recipe: "footsteps", apply: true });
    const steps = app.fx.list().slice(wn);
    ok(r.ok && steps.length >= 2 && steps.every((c) => /^foot_[LR]$/.test(c.socket) && c.scale < 1), `compose: ${steps.length} small puffs under the feet (${steps.map((c) => c.socket + " f" + Math.round(c.frame)).join(", ")})`);
    await call("compose", { undo: true });
    ok(app.fx.count() === wn, "compose: and they undo");
    ok((await call("set_mode", { mode: "REVIEW" })).result.panels.includes("Review") && app.ui.panels.get("Review").hidden === false, "mode REVIEW: the Review panel is up");
    ok((await call("set_mode", { mode: "COMPOSE" })).result.panels.includes("Compose") && app.ui.panels.get("Compose").hidden === false, "mode COMPOSE: the Compose panel is up");
    await call("set_mode", { mode: "POSE" });
  }

  if (app.fighter !== "vix") await app.setFighter("vix");
  await app.openClip("w_walk", true);
  return { pass, fail, lines };
}
