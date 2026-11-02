// Bake the rig-v5 skeleton into the game's v4 fighter GLBs.
//
// The app can upgrade a rig-v4 skeleton on load (src/core/rig_upgrade.js). This tool does the same thing to the
// GLB files on disk, so the game and the Godot Animator see the v5 joints too:
//
//   - Spine1 is inserted between torso and chest, each clavicle between chest and its upper arm.
//   - Each toe is placed at the ball of the baked foot sole (data/feet_soles.json), and the front of the foot is
//     re-weighted onto it, so a toe curl bends the shoe.
//   - The 4th finger joints, the 3rd / 4th thumb joints and the tail tip are added past their parents.
//
// The mesh, material and texture bytes are left exactly as they are; only the skin (new joints + inverse bind
// matrices) and the foot weights change. Existing joints keep their indices, rest transforms and inverse bind
// matrices, so every old clip and every wrap / feet / socket file means the same thing. New nodes carry
// `extras: { rig_v5: true }` so the app's Body Solve knows to walk past them (its wrap was baked on rig v4).
//
// Usage:
//   node tools/bake_rig_v5.mjs                     # every rig-v4 fighter in the project
//   node tools/bake_rig_v5.mjs --who=vix,carter    # only those
//   node tools/bake_rig_v5.mjs --dry               # report, write nothing
//   node tools/bake_rig_v5.mjs --project=D:/Games/BSP-Universe
//
// The originals are copied to D:/Cache/gridbake/v4_skeleton_backup/<name>.<sha12>.glb before anything is written.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith("--") && a.includes("=")).map((a) => [a.slice(2).split("=")[0], a.slice(2).split("=").slice(1).join("=")]));
const flags = new Set(args.filter((a) => a.startsWith("--") && !a.includes("=")).map((a) => a.slice(2)));
const PROJECT = opt.project || process.env.FIGHT_STUDIO_PROJECT || "D:/Games/BSP-Universe";
const PACK = path.join(PROJECT, "game/packs/city_breaker");
const CHARS = path.join(PACK, "assets/chars");
const DATA = path.join(PACK, "data");
const BACKUP = opt.backup || "D:/Cache/gridbake/v4_skeleton_backup";
const DRY = flags.has("dry");
const only = (opt.who || "").split(",").filter(Boolean);

const schema = JSON.parse(fs.readFileSync(path.join(DATA, "rig_v5.json"), "utf8"));
const solesAll = JSON.parse(fs.readFileSync(path.join(DATA, "feet_soles.json"), "utf8"));

const IDENT = [0, 0, 0, 1];
const same = (a, b, t = 1e-6) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= t);
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a))); return t * t * (3 - 2 * t); };
const align4 = (n) => (n + 3) & ~3;

// ------------------------------------------------------------------ GLB
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
  if (!json) throw new Error("no JSON chunk");
  return { json, bin };
}

function writeGlb(file, json, bin) {
  let js = Buffer.from(JSON.stringify(json), "utf8");
  const jsPad = (4 - (js.length % 4)) % 4;
  if (jsPad) js = Buffer.concat([js, Buffer.alloc(jsPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binOut = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;
  const total = 12 + 8 + js.length + 8 + binOut.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(js.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  js.copy(out, 20);
  const bo = 20 + js.length;
  out.writeUInt32LE(binOut.length, bo);
  out.writeUInt32LE(0x004e4942, bo + 4);
  binOut.copy(out, bo + 8);
  fs.writeFileSync(file, out);
}

// ------------------------------------------------------------------ accessors
const COMP = {
  5120: { size: 1, read: (b, o) => b.readInt8(o), write: (b, o, v) => b.writeInt8(v, o), max: 127 },
  5121: { size: 1, read: (b, o) => b.readUInt8(o), write: (b, o, v) => b.writeUInt8(v, o), max: 255 },
  5122: { size: 2, read: (b, o) => b.readInt16LE(o), write: (b, o, v) => b.writeInt16LE(v, o), max: 32767 },
  5123: { size: 2, read: (b, o) => b.readUInt16LE(o), write: (b, o, v) => b.writeUInt16LE(v, o), max: 65535 },
  5125: { size: 4, read: (b, o) => b.readUInt32LE(o), write: (b, o, v) => b.writeUInt32LE(v, o), max: 4294967295 },
  5126: { size: 4, read: (b, o) => b.readFloatLE(o), write: (b, o, v) => b.writeFloatLE(v, o), max: 1 },
};
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessorInfo(json, index) {
  const a = json.accessors[index];
  const bv = json.bufferViews[a.bufferView];
  const c = COMP[a.componentType];
  if (!c) throw new Error("component type " + a.componentType);
  if (a.sparse) throw new Error("sparse accessors are unsupported");
  const n = NCOMP[a.type];
  const stride = bv.byteStride || c.size * n;
  return { a, bv, c, n, stride, base: (bv.byteOffset || 0) + (a.byteOffset || 0), count: a.count };
}

function readComp(info, bin, i, c) {
  const o = info.base + i * info.stride + c * info.c.size;
  const v = info.c.read(bin, o);
  if (info.a.normalized && info.a.componentType !== 5126) {
    if (info.a.componentType === 5120) return Math.max(v / 127, -1);
    if (info.a.componentType === 5122) return Math.max(v / 32767, -1);
    return v / info.c.max;
  }
  return v;
}
function writeComp(info, bin, i, c, v) {
  const o = info.base + i * info.stride + c * info.c.size;
  let q = v;
  if (info.a.normalized && info.a.componentType !== 5126) {
    q = Math.round(v * (info.a.componentType === 5120 || info.a.componentType === 5122 ? info.c.max : info.c.max));
    q = Math.min(info.c.max, Math.max(info.a.componentType === 5120 || info.a.componentType === 5122 ? -info.c.max - 1 : 0, q));
  }
  info.c.write(bin, o, q);
}
function readVec(info, bin, i) {
  const out = [];
  for (let c = 0; c < info.n; c++) out.push(readComp(info, bin, i, c));
  return out;
}
function readPos(info, bin, i) {
  const o = info.base + i * info.stride;
  return [bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8)];
}

// ------------------------------------------------------------------ data helpers
function soleFor(key, side) {
  const k = String(key).toLowerCase() + "_fight.glb";
  const entry = Object.keys(solesAll).find((p) => p.toLowerCase().endsWith("/" + k)) || Object.keys(solesAll).find((p) => p.toLowerCase().endsWith(k));
  return entry && solesAll[entry] && solesAll[entry]["foot" + side] ? solesAll[entry]["foot" + side] : null;
}

function identityLocal(n) {
  return (!n.rotation || same(n.rotation, IDENT)) && (!n.scale || same(n.scale, [1, 1, 1])) && !n.matrix;
}

// ------------------------------------------------------------------ one file
function bakeFile(file, key) {
  const { json, bin } = readGlb(file);
  const report = { key, file: path.basename(file), added: [], skipped: [], toe_verts: { toeL: 0, toeR: 0 }, old_joints: json.skins?.[0]?.joints?.length || 0 };
  if (!json.skins || json.skins.length !== 1) throw new Error("expected one skin");
  if (!json.buffers || json.buffers.length !== 1) throw new Error("expected one buffer");
  if ((json.extensionsRequired || []).some((e) => /meshopt|quantization/i.test(e))) throw new Error("compressed meshes are unsupported");
  const skin = json.skins[0];
  const nodes = json.nodes;
  const joints = skin.joints || [];
  const byName = new Map();
  nodes.forEach((n, i) => { if (n.name && !byName.has(n.name)) byName.set(n.name, i); });
  const mixamo = joints.some((i) => /^mixamorig/i.test(nodes[i].name || ""));
  if (mixamo) { report.skip = "Mixamo skeleton"; return report; }
  if (!joints.some((i) => nodes[i].name === "hips")) { report.skip = "not a rig-v4 skeleton"; return report; }
  for (const i of joints) if (!identityLocal(nodes[i])) throw new Error("joint " + nodes[i].name + " has a non-identity rest (not rig v4)");

  // parent map and the bone world translations (rig v4: every rest rotation is identity; no non-bone node on a
  // bone path may turn or scale)
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
  const meshNode = nodes.findIndex((n) => n.mesh !== undefined && n.skin !== undefined);
  if (meshNode < 0) throw new Error("no skinned mesh");
  const world = new Array(nodes.length).fill(null);
  const worldT = (i) => {
    if (world[i]) return world[i];
    const p = parent[i];
    if (!identityLocal(nodes[i])) throw new Error("node " + nodes[i].name + " on a bone path has a transform");
    const t = nodes[i].translation || [0, 0, 0];
    world[i] = p >= 0 ? add(worldT(p), t) : t;
    return world[i];
  };
  for (const i of [...joints, meshNode]) worldT(i);

  const map = new Map();   // canonical -> node index
  for (const [canonical, info] of Object.entries(schema.bones)) {
    const alias = (info.aliases && info.aliases.rigv4) || "";
    const idx = alias ? byName.get(alias) : byName.get(canonical);
    if (idx !== undefined) map.set(canonical, idx);
  }
  const kids = new Map();
  for (const [canonical, info] of Object.entries(schema.bones)) {
    const p = info.parent || "";
    if (!p) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(canonical);
  }
  const worldOf = (idx) => world[idx] || [0, 0, 0];
  const addChild = (parentIdx, childIdx) => {
    const n = nodes[parentIdx];
    n.children = n.children || [];
    if (!n.children.includes(childIdx)) n.children.push(childIdx);
    parent[childIdx] = parentIdx;
  };
  const childSlot = (parentIdx, childIdx) => {
    const arr = nodes[parentIdx].children || [];
    const i = arr.indexOf(childIdx);
    if (i < 0) throw new Error("parent/child mismatch in schema at node " + nodes[parentIdx].name);
    return i;
  };

  let nextNode = nodes.length;
  const newJoints = [];
  for (const [canonical, info] of Object.entries(schema.bones)) {
    if (map.has(canonical)) continue;
    const up = info.upgrade;
    if (!up) continue;
    const parentIdx = map.get(info.parent || "");
    if (parentIdx === undefined) { report.skipped.push(canonical); continue; }
    const childCanonical = (kids.get(canonical) || []).find((c) => map.has(c));
    const node = { name: canonical, extras: { rig_v5: true } };
    if (childCanonical && typeof up.insert === "number") {
      const childIdx = map.get(childCanonical);
      const c = nodes[childIdx].translation || [0, 0, 0];
      const bp = mul(c, Math.min(0.95, Math.max(0.05, up.insert)));
      node.translation = bp;
      node.children = [childIdx];
      nodes[childIdx].translation = sub(c, bp);
      const slot = childSlot(parentIdx, childIdx);
      nodes[parentIdx].children[slot] = nextNode;
      parent[childIdx] = nextNode;
      parent[nextNode] = parentIdx;
    } else if (up.insert === "sole") {
      const side = canonical.endsWith("R") ? "R" : "L";
      const footIdx = parentIdx;
      const footW = worldOf(footIdx);
      const sole = soleFor(key, side);
      let off;
      if (sole && sole.pts && sole.pts.length >= 3) {
        const n = norm(sole.n || [0, 1, 0]);
        let fw = [0, 0, 1];
        fw = norm(sub(fw, mul(n, dot(fw, n))));
        let lo = Infinity, hi = -Infinity;
        for (const p of sole.pts) { const d = dot(p, fw); lo = Math.min(lo, d); hi = Math.max(hi, d); }
        const ball = lo + (hi - lo) * (Number(up.ball) || 0.62);
        const h = Number(sole.h) || Math.max(0.02, (hi - lo) * 0.3);
        off = add(mul(fw, ball), mul(n, -h * (Number(up.lift) || 0.85)));
      } else {
        off = [0, -0.04, 0.16];
      }
      node.translation = off;
      addChild(parentIdx, nextNode);
      report.toe = report.toe || {};
      report.toe[side] = { footW, off, sole: !!sole };
    } else {
      const ext = Number.isFinite(up.extend) ? up.extend : 1;
      node.translation = mul(nodes[parentIdx].translation || [0, 0, 0], ext);
      addChild(parentIdx, nextNode);
    }
    nodes.push(node);
    map.set(canonical, nextNode);
    byName.set(canonical, nextNode);
    newJoints.push({ canonical, idx: nextNode });
    nextNode++;
    report.added.push(canonical);
  }
  if (!newJoints.length) { report.already = true; return report; }

  // bone world translations after the edits
  world.fill(null);
  for (const j of newJoints) worldT(j.idx);
  for (const j of newJoints) if (!world[j.idx]) throw new Error("new node " + j.canonical + " is not in the scene");

  // append inverse bind matrices: the old matrices come first, untouched, then the new joints'
  // (rig v4 rests are translations: inverse = translation(-world))
  const oldIbm = json.accessors[skin.inverseBindMatrices];
  if (oldIbm.count !== joints.length) throw new Error("inverse bind matrix count " + oldIbm.count + " != joints " + joints.length);
  const oldIbmBv = json.bufferViews[oldIbm.bufferView];
  const oldIbmBase = (oldIbmBv.byteOffset || 0) + (oldIbm.byteOffset || 0);
  const oldLen = json.buffers[0].byteLength;
  const offset = align4(oldLen);
  const ibm = Buffer.alloc((joints.length + newJoints.length) * 64);
  bin.copy(ibm, 0, oldIbmBase, oldIbmBase + joints.length * 64);
  newJoints.forEach((j, k) => {
    const w = world[j.idx];
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -w[0], -w[1], -w[2], 1];
    const at = (joints.length + k) * 64;
    for (let i = 0; i < 16; i++) ibm.writeFloatLE(m[i], at + i * 4);
  });
  const newBinLen = offset + ibm.length;
  const binOut = Buffer.concat([bin.subarray(0, Math.min(oldLen, bin.length)), Buffer.alloc(Math.max(0, offset - Math.min(oldLen, bin.length))), ibm]);
  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: ibm.length });
  const ibmAccessor = json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: joints.length + newJoints.length, type: "MAT4" }) - 1;
  skin.inverseBindMatrices = ibmAccessor;
  skin.joints = [...joints, ...newJoints.map((j) => j.idx)];
  json.buffers[0].byteLength = newBinLen;

  // move the front of each foot onto its toe
  const toeJoint = new Map();
  for (const side of ["L", "R"]) {
    const toe = newJoints.find((j) => j.canonical === "toe" + side);
    const footIdx = map.get("foot" + side);
    if (!toe || footIdx === undefined) continue;
    const toeJointIndex = skin.joints.indexOf(toe.idx);
    const footJointIndex = skin.joints.indexOf(footIdx);
    if (footJointIndex < 0 || toeJointIndex < 0) continue;
    const footW = world[footIdx];
    const toeLocal = nodes[toe.idx].translation;
    const sole = soleFor(key, side);
    let n = [0, 1, 0], pts = null, frontFix = null;
    if (sole && sole.n && sole.pts) { n = norm(sole.n); pts = sole.pts; }
    let fw;
    if (pts) {
      fw = norm(sub([0, 0, 1], mul(n, n[2])));
      if (len(fw) < 0.5) fw = [0, 0, 1];
    } else {
      fw = [0, 0, 1];
    }
    const ball = dot(toeLocal, fw);
    // the foot's vertices, for the fallback front extent (and to check a missing sole)
    const footPts = [];
    for (const p of json.meshes || []) for (const prim of p.primitives || []) {
      const jc = prim.attributes && prim.attributes.JOINTS_0, wc = prim.attributes && prim.attributes.WEIGHTS_0;
      if (jc === undefined || wc === undefined) continue;
      const ji = accessorInfo(json, jc), wi = accessorInfo(json, wc);
      if (ji.n !== 4 || wi.n !== 4) continue;
      for (let v = 0; v < ji.count; v++) {
        const w = [readComp(wi, bin, v, 0), readComp(wi, bin, v, 1), readComp(wi, bin, v, 2), readComp(wi, bin, v, 3)];
        const j = [readComp(ji, bin, v, 0), readComp(ji, bin, v, 1), readComp(ji, bin, v, 2), readComp(ji, bin, v, 3)];
        let wf = 0;
        for (let k = 0; k < 4; k++) if (j[k] === footJointIndex) wf += w[k];
        if (wf <= 1e-6) continue;
        const p = readPos(accessorInfo(json, prim.attributes.POSITION), bin, v);
        footPts.push(sub(p, footW));
      }
    }
    let front = 0;
    if (pts) {
      for (const p of pts) front = Math.max(front, dot(p, fw) - ball);
    } else if (footPts.length) {
      let hi = -Infinity;
      for (const p of footPts) hi = Math.max(hi, dot(p, fw));
      front = hi - ball;
    }
    front = Math.max(0.05, front);
    const a = Math.max(0.012, front * 0.18), b = Math.max(a + 0.025, front * 0.62);
    let moved = 0;
    for (const p of json.meshes || []) for (const prim of p.primitives || []) {
      const jc = prim.attributes && prim.attributes.JOINTS_0, wc = prim.attributes && prim.attributes.WEIGHTS_0, pc = prim.attributes && prim.attributes.POSITION;
      if (jc === undefined || wc === undefined || pc === undefined) continue;
      const ji = accessorInfo(json, jc), wi = accessorInfo(json, wc), pi = accessorInfo(json, pc);
      if (ji.n !== 4 || wi.n !== 4 || pi.n !== 3) continue;
      const jbuf = json.bufferViews[ji.a.bufferView];
      const wbuf = json.bufferViews[wi.a.bufferView];
      // edits go into the new (padded) binary; the old bin is the first part
      const jOut = binOut;
      const wOut = binOut;
      for (let v = 0; v < ji.count; v++) {
        const j = [readComp(ji, bin, v, 0), readComp(ji, bin, v, 1), readComp(ji, bin, v, 2), readComp(ji, bin, v, 3)];
        const w = [readComp(wi, bin, v, 0), readComp(wi, bin, v, 1), readComp(wi, bin, v, 2), readComp(wi, bin, v, 3)];
        let wf = 0;
        for (let k = 0; k < 4; k++) if (j[k] === footJointIndex) wf += w[k];
        if (wf <= 1e-6) continue;
        const p = readPos(pi, bin, v);
        const pl = sub(p, footW);
        const k = smoothstep(a, b, dot(pl, fw) - ball);
        if (k <= 1e-4) continue;
        let left = k * wf;
        for (let s = 0; s < 4 && left > 1e-9; s++) if (j[s] === footJointIndex) { const d = Math.min(w[s], left); w[s] -= d; left -= d; }
        let slot = -1;
        for (let s = 0; s < 4; s++) if (j[s] !== toeJointIndex && w[s] <= 1e-9) { slot = s; break; }
        if (slot < 0) {
          let small = Infinity;
          for (let s = 0; s < 4; s++) if (j[s] !== footJointIndex && j[s] !== toeJointIndex && w[s] < small) { small = w[s]; slot = s; }
        }
        if (slot < 0) slot = 3;
        const keep = j[slot] === toeJointIndex ? w[slot] : 0;
        j[slot] = toeJointIndex;
        w[slot] = keep + k * wf;
        const sum = w[0] + w[1] + w[2] + w[3];
        if (sum > 1e-6) for (let s = 0; s < 4; s++) w[s] /= sum;
        for (let s = 0; s < 4; s++) { writeComp(ji, jOut, v, s, j[s]); writeComp(wi, wOut, v, s, w[s]); }
        moved++;
      }
    }
    report.toe_verts["toe" + side] = moved;
    toeJoint.set(side, { toeJointIndex, footJointIndex, moved });
  }

  return { ...report, json, bin: binOut, report };
}

// ------------------------------------------------------------------ main
fs.mkdirSync(BACKUP, { recursive: true });
const files = fs.readdirSync(CHARS).filter((f) => f.endsWith("_fight.glb")).sort();
const summary = [];
for (const f of files) {
  const key = f.slice(0, -10);
  if (only.length && !only.includes(key)) continue;
  const file = path.join(CHARS, f);
  const before = fs.readFileSync(file);
  try {
    const r = bakeFile(file, key);
    if (r.skip) { summary.push({ key, skip: r.skip }); console.log(`${key.padEnd(8)} skip: ${r.skip}`); continue; }
    if (r.already) { summary.push({ key, already: true }); console.log(`${key.padEnd(8)} already v5 (${r.old_joints} joints)`); continue; }
    if (DRY) {
      summary.push({ key, dry: true, added: r.added.length, old: r.old_joints, new: r.old_joints + r.added.length, toe: r.toe_verts });
      console.log(`${key.padEnd(8)} DRY  ${r.old_joints} -> ${r.old_joints + r.added.length} joints, +${r.added.length}: ${r.added.join(", ")}  toes ${r.toe_verts.toeL}/${r.toe_verts.toeR}`);
      continue;
    }
    const sha = crypto.createHash("sha256").update(before).digest("hex").slice(0, 12);
    const bak = path.join(BACKUP, `${f}.${sha}.glb`);
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, before);
    writeGlb(file, r.json, r.bin);
    const after = fs.readFileSync(file);
    summary.push({ key, old: r.old_joints, new: r.old_joints + r.added.length, added: r.added, toe: r.toe_verts, sha: crypto.createHash("sha256").update(after).digest("hex").slice(0, 12), backup: bak });
    console.log(`${key.padEnd(8)} baked ${r.old_joints} -> ${r.old_joints + r.added.length} joints, +${r.added.length}, toes ${r.toe_verts.toeL}/${r.toe_verts.toeR}, ${Math.round(after.length / 1024)} KB`);
  } catch (e) {
    summary.push({ key, error: String(e && e.message ? e.message : e) });
    console.log(`${key.padEnd(8)} ERROR ${e && e.message ? e.message : e}`);
    if (!DRY) process.exitCode = 1;
  }
}
fs.writeFileSync(path.join(BACKUP, `report_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`), JSON.stringify(summary, null, 2));
console.log(`\n${DRY ? "dry run" : "done"}: ${summary.length} files, backups in ${BACKUP}`);
