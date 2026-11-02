// Rig v5 pilot check: canonical mapping over rig-v4 (Vix) and Mixamo (Hypebeast).
import fs from "node:fs";
import { build } from "../src/core/rig_v5.js";

const DATA = "D:/Games/bsp-universe/game/packs/city_breaker/data/rig_v5.json";
const VIx = "D:/Games/bsp-universe/game/packs/city_breaker/assets/chars/vix_fight.glb";
const HYPE = "D:/Cache/gridbake/orig/hypebeast.glb";
let pass = 0, fail = 0;
const check = (ok, label) => { ok ? pass++ : fail++; console.log((ok ? "PASS  " : "FAIL  ") + label); };

function bones(path) {
  const b = fs.readFileSync(path);
  let off = 12, json = null;
  while (off < b.length) {
    const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4);
    off += 8;
    if (type === 0x4e4f534a) json = JSON.parse(b.subarray(off, off + len).toString("utf8"));
    off += len;
  }
  const out = [];
  for (const s of json.skins || []) for (const i of s.joints) out.push(json.nodes[i].name);
  return out;
}

const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
const vix = build(data, bones(VIx));
const hype = build(data, bones(HYPE));
check(vix.style === "rigv4", "Vix detected as rig v4");
check(hype.style === "mixamo", "Hypebeast detected as Mixamo");
check(vix.counts.simple === 27, `Vix simple is 27 (${vix.counts.simple})`);
check(vix.counts.advanced === 73, `Vix advanced is the baked full v5 rig, 73 (${vix.counts.advanced})`);
check(hype.counts.simple === 17, `Hypebeast simple is 17 (${hype.counts.simple})`);
check(hype.counts.advanced === 66, `Hypebeast advanced is 66 (${hype.counts.advanced})`);
check(vix.bones("simple").includes("hips") && vix.bones("simple").includes("earL"), "Vix simple keeps hips + ears");
check(["spine1", "clavicleL", "toeL", "indexL4", "tail4"].every((b) => vix.bones("advanced").includes(b)), "Vix advanced has the baked v5 joints");
check(hype.bones("simple").some((b) => /Hips$/.test(b)) && !hype.bones("simple").some((b) => /HandIndex1$/.test(b)), "Hypebeast simple hides fingers");
check(hype.bones("advanced").some((b) => /HandIndex1$/.test(b)) && hype.bones("advanced").some((b) => /ToeBase$/.test(b)), "Hypebeast advanced exposes fingers + toes");
const bend = hype.controls("simple").find((c) => c.name === "Spine bend");
check(!!bend && bend.drives.some((d) => /Spine$/.test(d[0])), "Spine bend maps to Mixamo spine");
const fist = hype.controls("advanced").find((c) => c.name === "Fist L (full)");
check(!!fist && fist.drives.length >= 10, "advanced fist drives the Mixamo finger chains");
check(vix.missing.length === 0, `Vix maps every canonical bone (${vix.missing})`);
check(hype.missing.includes("tail1") && hype.missing.includes("earL1"), "Hypebeast records missing tail/ears");

// the v4 -> v5 upgrade rules in the schema: every joint a rig-v4 fighter lacks has a rule
const upgrades = Object.entries(data.bones).filter(([, info]) => info.upgrade);
check(upgrades.length === 18, `schema carries 18 v4 -> v5 upgrade rules (${upgrades.length})`);
check(data.bones.spine1.upgrade.insert === 0.4, "Spine1 splits torso -> chest at 0.4");
check(data.bones.clavicleL.upgrade.insert === 0.5 && data.bones.clavicleR.upgrade.insert === 0.5, "clavicles split chest -> arm at 0.5");
check(data.bones.toeL.upgrade.insert === "sole" && data.bones.toeL.upgrade.ball === 0.62, "toes are placed at the ball of the baked sole");
check(data.bones.indexL4.upgrade.extend === 1.0 && data.bones.tail4.upgrade.extend === 1.0, "4th finger joints and the tail tip extend their last segment");
const crouch = data.controls.find((c) => c.name === "Crouch");
check(!!crouch && crouch.grounded === true, "Crouch is marked grounded (the hips follow the leg fold)");
check(!!data.limits && !!data.limits.toeL && !!data.limits.spine1 && !!data.limits.clavicleL, "the v5 joints have natural limits");

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail ? 1 : 0);
