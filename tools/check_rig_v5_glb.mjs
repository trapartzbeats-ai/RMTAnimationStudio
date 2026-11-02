// Check the baked rig-v5 fighter GLBs against the v4 backups (tools/bake_rig_v5.mjs wrote them).
// Proves: the mesh/material/texture bytes are untouched, every old joint keeps its index / rest / inverse bind
// matrix, the new joints are present with the right hierarchy and inverse bind matrices, and every vertex's
// weights still sum to 1 (with the front of each foot on its toe).
//
//   node tools/check_rig_v5_glb.mjs [--project=...] [--backup=...]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith("--") && a.includes("=")).map((a) => [a.slice(2).split("=")[0], a.slice(2).split("=").slice(1).join("=")]));
const PROJECT = opt.project || process.env.FIGHT_STUDIO_PROJECT || "D:/Games/BSP-Universe";
const PACK = path.join(PROJECT, "game/packs/city_breaker");
const CHARS = path.join(PACK, "assets/chars");
const BACKUP = opt.backup || "D:/Cache/gridbake/v4_skeleton_backup";

const IDENT = [0, 0, 0, 1];
const same = (a, b, t = 1e-6) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= t);
const sum = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const align4 = (n) => (n + 3) & ~3;

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
  let off = 12, json = null, bin = Buffer.alloc(0);
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    off += 8;
    const data = buf.subarray(off, off + len);
    off += len;
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
    else if (type === 0x004e4942) bin = data;
  }
  return { json, bin, size: buf.length };
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const byName = (json) => new Map(json.nodes.map((n, i) => [n.name, i]));
function parentOf(json) {
  const p = new Array(json.nodes.length).fill(-1);
  json.nodes.forEach((n, i) => (n.children || []).forEach((c) => (p[c] = i)));
  return p;
}
function worlds(json) {
  const parent = parentOf(json), world = new Array(json.nodes.length).fill(null);
  const at = (i) => {
    if (world[i]) return world[i];
    const t = json.nodes[i].translation || [0, 0, 0];
    world[i] = parent[i] >= 0 ? sum(at(parent[i]), t) : t.slice();
    return world[i];
  };
  json.nodes.forEach((_, i) => at(i));
  return world;
}
function accessorSlice(json, bin, index) {
  const a = json.accessors[index], bv = json.bufferViews[a.bufferView];
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
  const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  return bin.subarray(start, start + a.count * size * n);
}

let pass = 0, fail = 0;
const ok = (c, what) => { c ? pass++ : fail++; console.log((c ? "PASS  " : "FAIL  ") + what); };

const reports = fs.readdirSync(BACKUP).filter((f) => /^report_.*\.json$/.test(f)).sort();
if (!reports.length) { console.log("no bake report in " + BACKUP); process.exit(1); }
const report = JSON.parse(fs.readFileSync(path.join(BACKUP, reports[reports.length - 1]), "utf8"));
let checked = 0;
for (const e of report) {
  if (!e.backup) continue;
  const key = e.key;
  const bakedPath = path.join(CHARS, `${key}_fight.glb`);
  if (!fs.existsSync(bakedPath)) { ok(false, `${key}: baked file exists`); continue; }
  const old = readGlb(e.backup), now = readGlb(bakedPath);
  const oj = old.json, nj = now.json;
  const oldJoints = oj.skins[0].joints, newJoints = nj.skins[0].joints;
  const oldNames = oldJoints.map((i) => oj.nodes[i].name);
  const oldByName = byName(oj), newByName = byName(nj);
  const OW = worlds(oj), NW = worlds(nj);
  ok(newJoints.length === oldJoints.length + e.added.length, `${key}: joints ${oldJoints.length} -> ${newJoints.length} (+${e.added.length})`);
  ok(nj.accessors[nj.skins[0].inverseBindMatrices].count === newJoints.length, `${key}: inverse bind matrices ${nj.accessors[nj.skins[0].inverseBindMatrices].count} = joints`);
  // every old joint keeps its name, index, rest world and inverse bind matrix
  let sameRest = true, sameIbm = true, sameIndex = true;
  for (const name of oldNames) {
    const oi = oldByName.get(name), ni = newByName.get(name);
    if (oi === undefined || ni === undefined || oldJoints.indexOf(oi) !== newJoints.indexOf(ni)) { sameIndex = false; break; }
    if (!same(OW[oi], NW[ni], 1e-5)) sameRest = false;
  }
  ok(sameIndex, `${key}: every old joint kept its node and skin index`);
  ok(sameRest, `${key}: every old joint kept its rest world position`);
  const oldIbmAcc = oj.accessors[oj.skins[0].inverseBindMatrices];
  const newIbmAcc = nj.accessors[nj.skins[0].inverseBindMatrices];
  const oldIbm = accessorSlice(oj, old.bin, oj.skins[0].inverseBindMatrices);
  const newIbm = accessorSlice(nj, now.bin, nj.skins[0].inverseBindMatrices);
  const oldCount = oldIbmAcc.count;
  sameIbm = oldIbm.equals(newIbm.subarray(0, oldCount * 64));
  ok(sameIbm, `${key}: the first ${oldCount} inverse bind matrices are byte-identical`);
  // every new joint's IBM is inverse(rest world)
  let newIbmOk = true;
  for (let k = oldCount; k < newJoints.length; k++) {
    const name = nj.nodes[newJoints[k]].name;
    if (!e.added.includes(name)) continue;
    const w = NW[newJoints[k]];
    const at = k * 64;
    if (Math.abs(newIbm.readFloatLE(at + 48) + w[0]) > 1e-4 || Math.abs(newIbm.readFloatLE(at + 52) + w[1]) > 1e-4 || Math.abs(newIbm.readFloatLE(at + 56) + w[2]) > 1e-4) newIbmOk = false;
  }
  ok(newIbmOk, `${key}: every new joint's inverse bind matrix matches its rest world`);
  // new nodes marked, in the right parent
  let marked = true;
  for (const name of e.added) {
    const ni = newByName.get(name);
    if (ni === undefined || !nj.nodes[ni].extras || nj.nodes[ni].extras.rig_v5 !== true) marked = false;
  }
  ok(marked, `${key}: every new joint is marked extras.rig_v5`);
  // the mesh, material, texture and the skin weights
  const op = oj.meshes[0].primitives[0].attributes, np = nj.meshes[0].primitives[0].attributes;
  ok(sha(accessorSlice(oj, old.bin, op.POSITION)) === sha(accessorSlice(nj, now.bin, np.POSITION)) &&
    sha(accessorSlice(oj, old.bin, op.NORMAL)) === sha(accessorSlice(nj, now.bin, np.NORMAL)) &&
    sha(accessorSlice(oj, old.bin, op.TEXCOORD_0)) === sha(accessorSlice(nj, now.bin, np.TEXCOORD_0)), `${key}: positions, normals and UVs are byte-identical`);
  ok(JSON.stringify(oj.materials) === JSON.stringify(nj.materials) && JSON.stringify(oj.textures) === JSON.stringify(nj.textures) &&
    JSON.stringify(oj.images) === JSON.stringify(nj.images) && JSON.stringify(oj.samplers) === JSON.stringify(nj.samplers), `${key}: materials and textures unchanged`);
  // weights: sum 1, joint indices in range, toe owns some vertices
  const jAcc = nj.accessors[np.JOINTS_0], wAcc = nj.accessors[np.WEIGHTS_0];
  const jbv = nj.bufferViews[jAcc.bufferView], wbv = nj.bufferViews[wAcc.bufferView];
  const jStride = jbv.byteStride || 4 , wStride = wbv.byteStride || 16;
  const jBase = (jbv.byteOffset || 0) + (jAcc.byteOffset || 0), wBase = (wbv.byteOffset || 0) + (wAcc.byteOffset || 0);
  const toeIdx = new Set(e.added.includes("toeL") || e.added.includes("toeR") ? newJoints.map((_, k) => k).filter((k) => /^toe[LR]$/.test(nj.nodes[newJoints[k]].name)) : []);
  let badSum = 0, badJoint = 0, toeVerts = 0;
  for (let v = 0; v < jAcc.count; v++) {
    let s = 0, hasToe = false;
    for (let c = 0; c < 4; c++) {
      const jj = jStride === 4 ? now.bin.readUInt8(jBase + v * jStride + c) : now.bin.readUInt16LE(jBase + v * jStride + c * 2);
      const w = now.bin.readFloatLE(wBase + v * wStride + c * 4);
      s += w;
      if (jj >= newJoints.length) badJoint++;
      if (toeIdx.has(jj) && w > 0.5) hasToe = true;
    }
    if (Math.abs(s - 1) > 0.002) badSum++;
    if (hasToe) toeVerts++;
  }
  ok(badSum === 0 && badJoint === 0, `${key}: every vertex's weights sum to 1 and every joint index is in range`);
  ok(toeVerts > 0 || (!e.added.includes("toeL") && !e.added.includes("toeR")), `${key}: ${toeVerts} vertices carry the toe (>0.5)`);
  checked++;
}
console.log(`\n--- ${pass} passed, ${fail} failed (${checked} baked models) ---`);
process.exit(fail ? 1 : 0);
