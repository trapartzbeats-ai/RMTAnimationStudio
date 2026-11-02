// RMT effect blocks in three.js: the same manifests the game plays (addons/rmt_effects/assets/<id>/<id>.json), built layer by
// layer like the game's builder (rmt_effects/core/builder.gd) and driven by the same clock as RmtEffect (rmt_effect.gd):
// phases (anticipation / effect / cooldown), seek(t) = the effect as it is t seconds after it fires, frozen there, and step(dt)
// = on one frame, so a moving socket leaves its particles along its path.
//
// Particles are simulated on the CPU from the manifest's ParticleProcessMaterial fields (emission shape, direction + spread,
// velocity, gravity, damping, radial / tangential pull, turbulence, scale curve, colour ramp, flipbook), every particle from its
// own seed, so the same time always gives the same picture (as Godot's fixed seeds do there). The look is close to the game's,
// not the same pixels: GPU particles and the game's glow do not exist here. Meshes use the game's own shaders (gdshader.js).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as GD from "./gdshader.js";

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const _glbs = new Map();     // url -> Promise<{name: geometry}>
const _texs = new Map();     // url -> Promise<Texture>
const SIM_DT = 1 / 60;

// ---------------------------------------------------------------- assets

// everything a block needs, loaded once: {manifest, meshes, textures: {rel: Texture}, shaders: {name: text}}
export async function prepare(entry, readShader) {
  const m = entry.manifest;
  const base = entry.dir.endsWith("/") ? entry.dir : entry.dir + "/";
  const glb = String((m.assets || {}).glb || "");
  const glbUrl = glb ? (glb.startsWith("res://") ? entry.resUrl(glb) : new URL(glb, base).href) : "";
  const meshes = glbUrl ? await loadGlb(glbUrl) : {};
  const textures = {};
  const shaders = {};
  for (const l of allLayers(m)) {
    if (l.texture && !(l.texture in textures)) textures[l.texture] = await loadTex(l.texture.startsWith("res://") ? entry.resUrl(l.texture) : new URL(l.texture, base).href);
    const sh = l.kind === "mesh" ? l.shader : (l.material || {}).shader;
    if (sh && !(sh in shaders)) shaders[sh] = await readShader(sh);
  }
  return { id: m.id, manifest: m, meshes, textures, shaders };
}

function allLayers(m) {
  const out = [];
  for (const l of m.layers || []) {
    out.push(l);
    if (l.sub && l.sub.layer) out.push({ ...l.sub.layer, kind: "particles" });
  }
  return out;
}

function loadGlb(url) {
  if (!_glbs.has(url)) {
    _glbs.set(url, new Promise((res) => loader.load(url, (g) => {
      const out = {};
      g.scene.traverse((o) => { if (o.isMesh) out[o.name] = o.geometry; });
      res(out);
    }, undefined, () => res({}))));
  }
  return _glbs.get(url);
}

function loadTex(url) {
  if (!_texs.has(url)) {
    _texs.set(url, new Promise((res) => texLoader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; res(t); }, undefined, () => res(null))));
  }
  return _texs.get(url);
}

function meshNamed(meshes, want) {
  return meshes[want] || meshes["mesh_" + want] || (Object.keys(meshes).length === 1 ? Object.values(meshes)[0] : null);
}

// manifest colours are sRGB hex; the GPU wants linear (Manifest.color_from_hex)
export function color(hex, fallback = [1, 1, 1, 1]) {
  if (typeof hex !== "string" || hex.replace("#", "").length < 6) return fallback;
  const h = hex.replace("#", "");
  const c = new THREE.Color().setRGB(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b, h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
}

const v3 = (v, f = [0, 0, 0]) => (Array.isArray(v) && v.length >= 3 ? v.map(Number) : f);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// a curve [[x, y], ...] (CurveTexture) or a ramp [[x, "hex"], ...] (GradientTexture1D) at u
function curveAt(points, u, fallback = 1) {
  if (!Array.isArray(points) || !points.length) return fallback;
  if (u <= points[0][0]) return Number(points[0][1]);
  for (let i = 1; i < points.length; i++) {
    if (u <= points[i][0]) {
      const a = points[i - 1], b = points[i];
      return lerp(Number(a[1]), Number(b[1]), (u - a[0]) / Math.max(1e-6, b[0] - a[0]));
    }
  }
  return Number(points[points.length - 1][1]);
}

function rampAt(ramp, u) {
  if (!ramp.length) return [1, 1, 1, 1];
  if (u <= ramp[0][0]) return ramp[0][1];
  for (let i = 1; i < ramp.length; i++) {
    if (u <= ramp[i][0]) {
      const a = ramp[i - 1], b = ramp[i];
      const k = (u - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return a[1].map((x, j) => lerp(x, b[1][j], k));
    }
  }
  return ramp[ramp.length - 1][1];
}

// ---------------------------------------------------------------- seeded randomness

function hash(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// cheap smooth 3D noise for turbulence (value noise, three channels)
function noise3(x, y, z, k) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t) => t * t * (3 - 2 * t);
  const r = (i, j, l) => (hash(xi + i + k * 31, yi + j, zi + l) / 4294967296) * 2 - 1;
  const u = s(xf), v = s(yf), w = s(zf);
  return lerp(lerp(lerp(r(0, 0, 0), r(1, 0, 0), u), lerp(r(0, 1, 0), r(1, 1, 0), u), v), lerp(lerp(r(0, 0, 1), r(1, 0, 1), u), lerp(r(0, 1, 1), r(1, 1, 1), u), v), w);
}

// ---------------------------------------------------------------- particle layer

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _y = new THREE.Vector3();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _camQ = new THREE.Quaternion();
const _col = new THREE.Color();

class ParticleLayer extends THREE.Object3D {
  constructor(layer, block, index) {
    super();
    this.isParticleLayer = true;
    this.L = layer;
    this.index = index;
    this.amount = Math.max(1, Number(layer.amount ?? 32));
    this.lifetime = Math.max(0.01, Number(layer.lifetime ?? 1));
    this.loop = layer.loop !== undefined ? !!layer.loop : true;
    this.explosiveness = Number(layer.explosiveness ?? 0);
    this.randomness = Number(layer.randomness ?? 0.3);
    this.local = !!layer.local_coords;
    this.preprocess = this.loop ? Math.max(Number(layer.preprocess ?? 0), this.lifetime) : 0;
    this.velocityAlign = layer.align === "velocity";
    const e = layer.emission || {};
    this.em = { shape: e.shape || "point", radius: Number(e.radius ?? (e.shape === "ring" ? 0.5 : 0.2)), inner: Number(e.inner_radius ?? 0.35),
      height: Number(e.height ?? 0), extents: v3(e.extents, [0.2, 0.05, 0.2]) };
    this.dir = new THREE.Vector3(...v3(layer.direction, [0, 1, 0])).normalize();
    this.spread = THREE.MathUtils.degToRad(Number(layer.spread ?? 15));
    this.gravity = v3(layer.gravity, [0, 0, 0]);
    const r = (k, a = 0, b = a) => [Number((layer[k] || {}).min ?? a), Number((layer[k] || {}).max ?? b)];
    this.vel = r("initial_velocity");
    this.damp = r("damping");
    this.radial = r("radial_accel");
    this.tangential = r("tangential_accel");
    this.angle = r("angle").map(THREE.MathUtils.degToRad);
    this.spin = r("angular_velocity").map(THREE.MathUtils.degToRad);
    this.sizeRange = [Number((layer.scale || {}).min ?? 1), Number((layer.scale || {}).max ?? 1)];
    this.scaleCurve = (layer.scale || {}).curve || [];
    const t = layer.turbulence || {};
    this.turb = t.enabled ? { strength: Number(t.strength ?? 0.5), scale: Number(t.scale ?? 1), influence: t.influence || [[0, 0], [1, 1]] } : null;
    this.base = color(layer.color, [1, 1, 1, 1]);
    this.ramp = (layer.color_ramp || []).map(([x, h]) => [Number(x), color(h)]);
    const fr = layer.frames || {};
    this.frames = { h: Number(fr.h || 1), v: Number(fr.v || 1), loop: fr.loop !== false };
    this.anim = { offset: Number((layer.anim || {}).offset ?? 0), speed: Number((layer.anim || {}).speed ?? 1) };
    this.sub = null;              // at_end children: {layer: ParticleLayer, amount}
    this.triggers = null;         // for an at_end child: the parent's deaths [{t, p: Vector3, v: Vector3}]
    this.stopAt = Infinity;       // release(): no new particles after this local time
    this.lt = -1;                 // local time (seconds since this layer started); < 0 = not started
    this.history = [];            // [{t, m: Matrix4}] the emitter's world transform per step (world-space particles)
    this.seed = 1;
    this._state = null;
    this._stateKey = "";
    // the draw pass: the layer's mesh, one instance per particle
    const geo = meshNamed(block.meshes, String(layer.mesh || "card")) || new THREE.PlaneGeometry(1, 1);
    this.mat = this._material(layer, block);
    this.mesh = new THREE.InstancedMesh(geo, this.mat, this.amount);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _col.set(1, 1, 1));
    this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(this.amount), 1);
    this.aFrame = new THREE.InstancedBufferAttribute(new Float32Array(this.amount), 1);
    this.mesh.geometry = geo.clone();   // its own copy: the per-particle alpha and flipbook frame ride on it
    this.mesh.geometry.setAttribute("aAlpha", this.aAlpha);
    this.mesh.geometry.setAttribute("aFrame", this.aFrame);
    this.mesh.count = 0;
    this.mesh.onBeforeRender = (_r, _sc, cam) => this._draw(cam);
    if (!this.local) this.mesh.matrixWorldAutoUpdate = false;   // world-space particles: instance matrices are world matrices
    this.add(this.mesh);
  }

  _material(layer, block) {
    const spec = layer.material || {};
    if (spec.shader && block.shaders[spec.shader]) {
      const params = { ...(spec.params || {}) };
      if (layer.color) params.base_color = layer.color;
      return GD.material(block.shaders[spec.shader], params);
    }
    const tex = layer.texture ? block.textures[layer.texture] : null;
    const add = String(spec.blend || "add") === "add";
    const m = new THREE.MeshBasicMaterial({ map: tex || null, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: add ? THREE.AdditiveBlending : THREE.NormalBlending, vertexColors: false });
    const h = this.frames.h, v = this.frames.v;
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aAlpha;\nattribute float aFrame;\nvarying float vAlpha;")
        .replace("#include <uv_vertex>", `#include <uv_vertex>
        vAlpha = aAlpha;
        #ifdef USE_MAP
          { float fi = floor(aFrame + 0.5); float fx = mod(fi, ${h.toFixed(1)}); float fy = floor(fi / ${h.toFixed(1)});
            vMapUv = (uv + vec2(fx, fy)) / vec2(${h.toFixed(1)}, ${v.toFixed(1)}); }
        #endif`);
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vAlpha;")
        .replace("#include <alphamap_fragment>", "#include <alphamap_fragment>\ndiffuseColor.a *= vAlpha;");
    };
    m.customProgramCacheKey = () => `rmtp${h}x${v}`;
    return m;
  }

  // the emitter's world transform at local time lt (world-space particles are born where the emitter was then)
  _emitterAt(lt) {
    if (this.local || !this.history.length) return this.matrixWorld;
    let best = this.history[0];
    for (const h of this.history) { if (h.t <= lt + 1e-6) best = h; else break; }
    return best.m;
  }

  // every live particle at local time lt: [{p, v, s, c: [r, g, b, a], angle, frame}] in the space they draw in
  _simulate(lt) {
    const key = `${lt.toFixed(5)}|${this.seed}|${this.history.length}|${this.stopAt}|${this.triggers ? this.triggers.length : -1}`;
    if (key === this._stateKey && this._state) return this._state;
    const out = [];
    const deaths = [];
    if (lt >= 0) {
      const births = this._births(lt);
      for (const b of births) {
        const age = lt - b.t;
        if (age < 0 || age >= b.life) {
          if (age >= b.life && this.sub) deaths.push(b);
          continue;
        }
        out.push(this._advance(b, age));
      }
    }
    if (this.sub) this.sub.layer.triggers = deaths.map((b) => { const end = this._advance(b, b.life - 1e-4); return { t: b.t + b.life, p: end.p, v: end.v }; });
    this._state = out;
    this._stateKey = key;
    return out;
  }

  // the particles born up to lt: {i, t (birth, local time), life, r (rng), m (emitter matrix)}
  _births(lt) {
    const out = [];
    const life = this.lifetime;
    if (this.triggers) {   // an at_end child: amount_at_end particles where each parent died
      let i = 0;
      for (const tr of this.triggers) {
        for (let k = 0; k < this.subAmount; k++, i++) {
          if (tr.t > lt) continue;
          out.push({ i, t: tr.t, life, r: rng(hash(this.seed, i, 7)), at: tr.p, inherit: tr.v });
        }
      }
      return out;
    }
    // Godot's emission timing: particle i starts its cycles at phase (i / amount) * (1 - explosiveness), nudged by randomness;
    // a looping layer has been running `preprocess` seconds before it starts
    const n = this.amount;
    const t0 = this.loop ? -this.preprocess : 0;
    for (let i = 0; i < n; i++) {
      const r0 = rng(hash(this.seed, i, 0));
      const phase = (i / n) * (1 - this.explosiveness) + this.randomness * r0() * (1 / n);
      if (!this.loop) {
        const tb = phase * life;
        if (tb <= lt && tb <= this.stopAt) out.push({ i, t: tb, life, r: rng(hash(this.seed, i, 101)), m: this._emitterAt(Math.max(0, tb)) });
        continue;
      }
      let cLo = Math.ceil(t0 / life - phase - 1e-9);
      if (!this.sub) cLo = Math.max(cLo, Math.floor((lt - life) / life - phase));   // only the cycles that can still be alive
      const cHi = Math.floor(lt / life - phase + 1e-9);
      for (let c = cLo; c <= cHi; c++) {
        const tb = (c + phase) * life;
        if (tb > this.stopAt) break;
        if (tb < t0 - 1e-9) continue;
        out.push({ i, t: tb, life, r: rng(hash(this.seed, i, c + 101)), m: this._emitterAt(Math.max(0, tb)) });
      }
    }
    return out;
  }

  // one particle `age` seconds after its birth
  _advance(b, age) {
    const r = b.r;
    const rnd = () => r();
    // where it starts (the emission shape), which way and how fast
    const p = new THREE.Vector3();
    const e = this.em;
    if (e.shape === "sphere") p.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize().multiplyScalar(e.radius * Math.cbrt(rnd()));
    else if (e.shape === "sphere_surface") p.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize().multiplyScalar(e.radius);
    else if (e.shape === "box") p.set((rnd() * 2 - 1) * e.extents[0], (rnd() * 2 - 1) * e.extents[1], (rnd() * 2 - 1) * e.extents[2]);
    else if (e.shape === "ring") {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(lerp(e.inner * e.inner, e.radius * e.radius, rnd()));
      p.set(Math.cos(a) * rr, (rnd() - 0.5) * e.height, Math.sin(a) * rr);
    }
    const dir = this.dir.clone();
    if (this.spread > 0) {
      const cosMax = Math.cos(Math.min(Math.PI, this.spread));
      const z = lerp(1, cosMax, rnd());
      const phi = rnd() * Math.PI * 2;
      const sxy = Math.sqrt(Math.max(0, 1 - z * z));
      const local = new THREE.Vector3(sxy * Math.cos(phi), sxy * Math.sin(phi), z);
      _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      dir.copy(local.applyQuaternion(_q));
    }
    const v = dir.multiplyScalar(lerp(this.vel[0], this.vel[1], rnd()));
    const damp = lerp(this.damp[0], this.damp[1], rnd());
    const rad = lerp(this.radial[0], this.radial[1], rnd());
    const tan = lerp(this.tangential[0], this.tangential[1], rnd());
    const size = lerp(this.sizeRange[0], this.sizeRange[1], rnd());
    const ang0 = lerp(this.angle[0], this.angle[1], rnd());
    const spin = lerp(this.spin[0], this.spin[1], rnd());
    const g = new THREE.Vector3(...this.gravity);
    let unit = 1;
    if (b.at) {   // a sub-emitter's particle starts where its parent died (world space)
      p.add(b.at);
      if (b.inherit && this.keepVelocity) v.add(b.inherit);
    } else if (!this.local) {   // into the world as the emitter stood at the birth (its scale scales the burst)
      const m = b.m;
      const o = new THREE.Vector3().setFromMatrixPosition(m);
      const basis = new THREE.Matrix3().setFromMatrix4(m);
      p.applyMatrix3(basis).add(o);
      v.applyMatrix3(basis);
      unit = new THREE.Vector3().setFromMatrixScale(m).x;
    }
    const origin = b.at ? b.at.clone() : this.local ? new THREE.Vector3() : new THREE.Vector3().setFromMatrixPosition(b.m);
    // integrate in 60ths (gravity, radial / tangential pull, damping, turbulence)
    const steps = Math.min(600, Math.ceil(age / SIM_DT));
    const dt = steps ? age / steps : 0;
    for (let k = 0; k < steps; k++) {
      const acc = g.clone();
      if (rad || tan) {
        const d = p.clone().sub(origin);
        const len = d.length();
        if (len > 1e-5) {
          d.divideScalar(len);
          if (rad) acc.addScaledVector(d, rad * unit);
          if (tan) acc.addScaledVector(new THREE.Vector3(0, 1, 0).cross(d).normalize(), tan * unit);
        }
      }
      if (this.turb) {
        const u = (k * dt) / b.life;
        const s = this.turb.scale;
        const infl = curveAt(this.turb.influence, u, 1) * this.turb.strength * 6;
        acc.add(new THREE.Vector3(noise3(p.x * s, p.y * s, p.z * s, 1), noise3(p.x * s, p.y * s, p.z * s, 2), noise3(p.x * s, p.y * s, p.z * s, 3)).multiplyScalar(infl * unit));
      }
      v.addScaledVector(acc, dt);
      if (damp > 0) {
        const sp = v.length() - damp * unit * dt;
        if (sp <= 0) v.set(0, 0, 0); else v.setLength(sp);
      }
      p.addScaledVector(v, dt);
    }
    const u = clamp01(age / b.life);
    const c = rampAt(this.ramp, u).map((x, j) => x * this.base[j]);
    const total = this.frames.h * this.frames.v;
    let fr = this.anim.offset + this.anim.speed * u;
    fr = this.frames.loop ? fr - Math.floor(fr) : clamp01(fr);
    return { p, v, s: size * curveAt(this.scaleCurve, u, 1) * unit, c, angle: ang0 + spin * age, frame: Math.min(total - 1, Math.floor(fr * total)) };
  }

  // instance matrices for this camera: billboards face it, velocity-aligned ones stretch along their motion
  _draw(cam) {
    const list = this.visible && this.lt >= 0 ? this._simulate(this.lt) : [];
    const n = Math.min(list.length, this.mesh.instanceMatrix.count);
    cam.getWorldQuaternion(_camQ);
    const inv = this.local ? new THREE.Matrix4().copy(this.mesh.matrixWorld).invert() : null;
    for (let i = 0; i < n; i++) {
      const q = list[i];
      _s.setScalar(Math.max(0, q.s));
      if (this.velocityAlign && q.v.lengthSq() > 1e-8) {
        _y.copy(q.v).normalize();
        const viewDir = new THREE.Vector3(0, 0, 1).applyQuaternion(_camQ);
        if (this.local) viewDir.transformDirection(inv);
        _x.crossVectors(_y, viewDir);
        if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
        _x.normalize();
        _z.crossVectors(_x, _y).normalize();
        _m.makeBasis(_x, _y, _z).scale(_s).setPosition(q.p);
      } else {
        _q.copy(_camQ);
        if (this.local) _q.premultiply(new THREE.Quaternion().setFromRotationMatrix(inv));
        if (q.angle) _q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), q.angle));
        _m.compose(q.p, _q, _s);
      }
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _col.setRGB(q.c[0], q.c[1], q.c[2]));
      this.aAlpha.array[i] = q.c[3];
      this.aFrame.array[i] = q.frame;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.aAlpha.needsUpdate = true;
    this.aFrame.needsUpdate = true;
    if (!this.local) this.mesh.matrixWorld.identity();
  }

  // world-space box of the live particles now (Godot's capture_aabb: positions)
  box() {
    const list = this.visible && this.lt >= 0 ? this._simulate(this.lt) : [];
    if (!list.length) return null;
    const b = new THREE.Box3();
    for (const q of list) b.expandByPoint(this.local ? q.p.clone().applyMatrix4(this.mesh.matrixWorld) : q.p);
    return b;
  }

  // sampler (a follow's socket path, effect time -> world point) lets a jump give world-space particles the path the emitter
  // came along, so they are born along it as they were when the clip played (else all at the emitter's place now)
  seek(lt, seed, sampler = null, start = 0) {
    this.seed = seed;
    this.history = [];
    this.stopAt = Infinity;
    this.lt = lt;
    this._stateKey = "";
    if (lt < 0 || this.local) return;
    this.updateWorldMatrix(true, false);
    if (sampler) {
      const here = sampler(start + lt);   // first: the host may have posed its body elsewhere meanwhile
      const lift = new THREE.Vector3().setFromMatrixPosition(this.matrixWorld).sub(here);
      const from = Math.max(0, lt - this.lifetime - 0.02);
      const k = Math.ceil((lt - from) / SIM_DT - 1e-9);
      for (let i = 0; i <= k; i++) {
        const u = Math.min(from + i * SIM_DT, lt);
        const m = this.matrixWorld.clone();
        m.setPosition(sampler(start + u).add(lift));
        this.history.push({ t: u, m });
      }
      this.history[this.history.length - 1] = { t: lt, m: this.matrixWorld.clone() };
    } else this.history.push({ t: 0, m: this.matrixWorld.clone() });
  }

  step(lt) {
    this.lt = lt;
    if (!this.local) {
      this.updateWorldMatrix(true, false);
      this.history.push({ t: lt, m: this.matrixWorld.clone() });
    }
  }
}

// ---------------------------------------------------------------- trail layer

// a trail (the game's rmt_effect.gd trails): the layer node marks the head; a world-space tube is drawn along where the head
// has been over the last `length` seconds, thinner (taper) and fading (color_ramp, head 0 -> tail 1) toward the tail
const TRAIL_STEP = 1 / 60;

class TrailLayer extends THREE.Object3D {
  constructor(layer) {
    super();
    this.isTrailLayer = true;
    this.L = layer;
    this.length = Math.max(0.01, Number(layer.length ?? 0.25));
    this.width = Number(layer.width ?? 0.08);
    this.taper = clamp01(Number(layer.taper ?? 1));
    this.sides = Math.max(3, Math.min(16, Number(layer.sides ?? 6)));
    this.ramp = (layer.color_ramp || [[0, "ffffffff"], [1, "ffffff00"]]).map(([x, h]) => [Number(x), color(h)]);
    this.pts = [];            // [[effect time, world Vector3]]
    this.released = false;
    const add = String(layer.blend || "add") === "add";
    this.geo = new THREE.BufferGeometry();
    this.tube = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: add ? THREE.AdditiveBlending : THREE.NormalBlending }));
    this.tube.frustumCulled = false;
    this.tube.matrixWorldAutoUpdate = false;   // its vertices are world positions
    this.add(this.tube);
  }

  head() { this.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(this.matrixWorld); }

  // the head's place now (if started and not released), then only the last `length` of path, then the tube
  record(t, start, scale) {
    if (t >= start && !this.released) {
      const p = this.head();
      if (!this.pts.length || this.pts[this.pts.length - 1][0] < t - 1e-6) this.pts.push([t, p]);
      else this.pts[this.pts.length - 1] = [t, p];
    }
    this.prune(t);
    this.draw(t, scale);
  }

  prune(t) {
    this.pts = this.pts.filter((p, i) => p[0] >= t - this.length || (i + 1 < this.pts.length && this.pts[i + 1][0] > t - this.length));
  }

  // a jump: the path over the last `length` seconds, sampled back along the host's path (or just here)
  seekTo(t, start, sampler, scale) {
    this.released = false;
    this.pts = [];
    if (t >= start) {
      const from = Math.max(start, t - this.length);
      if (sampler) {
        const here = sampler(t);   // first: the host may have posed its body elsewhere meanwhile
        const lift = this.head().sub(here);
        const k = Math.ceil((t - from) / TRAIL_STEP - 1e-9);
        for (let i = 0; i <= k; i++) {
          const tt = Math.min(from + i * TRAIL_STEP, t);
          this.pts.push([tt, sampler(tt).add(lift)]);
        }
        this.pts[this.pts.length - 1] = [t, this.head()];
      } else this.pts.push([t, this.head()]);
    }
    this.draw(t, scale);
  }

  box() {
    if (this.pts.length < 2) return null;
    const b = new THREE.Box3();
    for (const p of this.pts) b.expandByPoint(p[1]);
    return b;
  }

  // the tube: a ring of `sides` round every point (Catmull-Rom between them), thinner and fainter toward the tail
  draw(t, scale) {
    const pts = this.pts;
    if (pts.length < 2) { this.geo.setIndex(null); this.geo.deleteAttribute("position"); this.geo.deleteAttribute("color"); return; }
    const path = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)][1], p1 = pts[i][1], p2 = pts[i + 1][1], p3 = pts[Math.min(i + 2, pts.length - 1)][1];
      for (let k = 0; k < 4; k++) {
        const u = k / 4;
        path.push([lerp(pts[i][0], pts[i + 1][0], u), cubic(p1, p2, p0, p3, u)]);
      }
    }
    path.push(pts[pts.length - 1]);
    const width = this.width * scale;
    const pos = [], col = [];
    const rings = path.map((pt, i) => {
      const a = path[Math.max(i - 1, 0)][1], b = path[Math.min(i + 1, path.length - 1)][1];
      const tan = b.clone().sub(a);
      if (tan.lengthSq() < 1e-12) tan.set(1, 0, 0);
      tan.normalize();
      let nrm = tan.clone().cross(new THREE.Vector3(0, 1, 0));
      if (nrm.length() < 1e-4) nrm = tan.clone().cross(new THREE.Vector3(1, 0, 0));
      nrm.normalize();
      const bin = tan.clone().cross(nrm).normalize();
      const age = clamp01((t - pt[0]) / this.length);
      const r = width * 0.5 * lerp(1, 1 - this.taper, age);
      const ring = [];
      for (let s = 0; s < this.sides; s++) {
        const ang = (Math.PI * 2 * s) / this.sides;
        ring.push(pt[1].clone().addScaledVector(nrm, Math.cos(ang) * r).addScaledVector(bin, Math.sin(ang) * r));
      }
      return [ring, rampAt(this.ramp, age)];
    });
    for (let i = 0; i < rings.length - 1; i++) {
      const [r0, c0] = rings[i], [r1, c1] = rings[i + 1];
      for (let s = 0; s < this.sides; s++) {
        const j = (s + 1) % this.sides;
        for (const [v, c] of [[r0[s], c0], [r1[s], c1], [r1[j], c1], [r0[s], c0], [r1[j], c1], [r0[j], c0]]) {
          pos.push(v.x, v.y, v.z);
          col.push(c[0], c[1], c[2], c[3]);   // RGBA: three uses the vertex alpha (blending scales by it, as Godot's alpha does)
        }
      }
    }
    this.geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    this.geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
    this.geo.computeBoundingSphere();
  }
}

// Godot's Vector3.cubic_interpolate (Catmull-Rom): p1 -> p2 with p0 before and p3 after
function cubic(p1, p2, p0, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
  return new THREE.Vector3(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}

// ---------------------------------------------------------------- the effect

export class RmtEffect extends THREE.Group {
  constructor(block) {
    super();
    this.block = block;
    this.manifest = block.manifest;
    this.name = "Fx_" + block.id;
    this.time = 0;
    this.layerRoot = new THREE.Group();
    this.layerRoot.name = "Layers";
    this.add(this.layerRoot);
    this._build();
  }

  _build() {
    const m = this.manifest;
    let i = 0;
    for (const L of m.layers || []) {
      const node = this._layer(L, i++);
      if (!node) continue;
      node.name = String(L.name || L.kind);
      node.userData.phase = String(L.phase || "");
      node.userData.layer = L;
      applyTransform(node, L.transform);
      this.layerRoot.add(node);
      const sub = L.sub;
      if (node.isParticleLayer && sub && sub.layer) {
        const sl = { ...sub.layer, kind: "particles", name: String(sub.name || "Sub") };
        if (String(sub.mode || "at_end") === "constant") {   // emulated in the game: a sibling that starts after its parent
          const sn = new ParticleLayer({ ...sl, loop: true }, this.block, i++);
          sn.name = `${node.name}__${sl.name}`;
          applyTransform(sn, sl.transform);
          if (!(sl.transform || {}).pos) sn.position.copy(node.position);
          sn.userData.subParent = node.name;
          sn.userData.subDelay = Number(L.lifetime ?? 1) * 0.9;
          sn.userData.layer = sl;
          this.layerRoot.add(sn);
        } else {   // the engine's AT_END sub-emitter: amount_at_end particles where each parent particle dies
          const sn = new ParticleLayer({ ...sl, loop: false }, this.block, i++);
          sn.name = sl.name;
          sn.subAmount = Math.max(1, Number(sub.amount_at_end ?? sub.amount ?? 3));
          sn.keepVelocity = !!sub.keep_velocity;
          sn.triggers = [];
          sn.local = false;
          sn.mesh.matrixWorldAutoUpdate = false;
          sn.mesh.count = 0;
          const cap = Number(L.amount ?? 32) * sn.subAmount;
          if (cap > sn.mesh.instanceMatrix.count) {
            const grown = new THREE.InstancedMesh(sn.mesh.geometry, sn.mat, cap);
            grown.frustumCulled = false;
            grown.matrixWorldAutoUpdate = false;
            sn.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
            sn.aFrame = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
            grown.geometry = sn.mesh.geometry.clone();
            grown.geometry.setAttribute("aAlpha", sn.aAlpha);
            grown.geometry.setAttribute("aFrame", sn.aFrame);
            grown.setColorAt(0, _col.set(1, 1, 1));
            grown.onBeforeRender = (_r, _sc, cam) => sn._draw(cam);
            sn.remove(sn.mesh);
            sn.mesh = grown;
            sn.add(grown);
          }
          node.sub = { layer: sn };
          node.add(sn);
        }
      }
    }
  }

  _layer(L, i) {
    const b = this.block;
    if (L.kind === "particles") return new ParticleLayer(L, b, i);
    if (L.kind === "trail") return new TrailLayer(L);
    if (L.kind === "light") {
      const c = color(L.color, [1, 1, 1, 1]);
      const l = new THREE.PointLight(new THREE.Color(c[0], c[1], c[2]), 0, Number(L.range ?? 5), 2);
      l.userData.energy = Number(L.energy ?? 2);
      return l;
    }
    if (L.kind === "mesh") {
      const geo = meshNamed(b.meshes, String(L.mesh || "ring")) || new THREE.PlaneGeometry(1, 1);
      let mat;
      if (L.shader && b.shaders[L.shader]) {
        const params = { ...(L.params || {}) };
        if (L.color) params.ring_color = L.color;
        mat = GD.material(b.shaders[L.shader], params);
      } else {
        mat = new THREE.MeshBasicMaterial({ map: L.texture ? b.textures[L.texture] : null, transparent: true, blending: THREE.AdditiveBlending,
          depthWrite: false, side: THREE.DoubleSide });
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      if (mat.uniforms) {
        mesh.onBeforeRender = (r, sc, cam) => { mat.uniforms.uTime.value = performance.now() / 1000; if (mat.uniforms.uViewport) { r.getDrawingBufferSize(mat.uniforms.uViewport.value); mat.uniforms.uProj.value.copy(cam.projectionMatrix); } };
        if ("fade" in (L.params || {})) mesh.userData.fade0 = Number(L.params.fade);   // play() fades only a fade that is set
      }
      return mesh;
    }
    if (L.kind === "decal") {   // a projected decal becomes a mark on the floor under it (when its box reaches the floor)
      const size = v3(L.size, [1, 0.5, 1]);
      const tex = L.texture ? b.textures[L.texture] : null;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[2]), mat);
      mesh.rotation.x = -Math.PI / 2;
      const g = new THREE.Group();
      g.add(mesh);
      g.userData.decal = { mesh, depth: size[1] };
      return g;
    }
    return null;
  }

  // seconds after it fires when a layer starts (its phase; an emulated sub-emitter after its parent)
  startOf(node) {
    const m = this.manifest;
    const ph = m.loop ? {} : m.phases || {};
    const a = Number(ph.anticipation || 0), imp = Number(ph.impact || 0);
    const delay = (n) => {
      if (!n) return 0;
      const p = n.userData.phase;
      return p === "anticipation" ? 0 : p === "cooldown" ? a + imp * 0.5 : a;
    };
    if (node.userData.subParent) return delay(this.layerRoot.getObjectByName(node.userData.subParent)) + node.userData.subDelay;
    return delay(node);
  }

  _scale() { return new THREE.Vector3().setFromMatrixScale(this.matrixWorld).x; }

  // the effect as it is t seconds after it fires, held there
  seek(t, seedBase = 1) {
    this.time = t;
    this.updateWorldMatrix(true, true);
    let n = 0;
    for (const node of this.layerRoot.children) {
      const lt = t - this.startOf(node);
      if (node.isTrailLayer) { node.seekTo(t, this.startOf(node), this.trailSampler || null, this._scale()); continue; }
      if (node.isParticleLayer) {
        n++;
        node.seek(lt, seedBase * 1000 + n, this.trailSampler || null, this.startOf(node));
        if (node.sub) node.sub.layer.seek(lt, seedBase * 1000 + n + 17);
      } else this._poseAt(node, lt);
    }
  }

  // on by dt (once per frame): particles born now are born where the emitter is now
  step(dt, seedBase = 1) {
    const t0 = this.time;
    const t1 = t0 + Math.max(0, dt);
    this.time = t1;
    this.updateWorldMatrix(true, true);
    let n = 0;
    for (const node of this.layerRoot.children) {
      const start = this.startOf(node);
      if (node.isTrailLayer) { node.record(t1, start, this._scale()); continue; }
      if (node.isParticleLayer) {
        n++;
        if (t1 < start) continue;
        if (t0 < start) node.seek(t1 - start, seedBase * 1000 + n);
        else node.step(t1 - start);
        if (node.sub) node.sub.layer.step(t1 - start);
      } else this._poseAt(node, t1 - start);
    }
  }

  // a follow whose time is up: no new particles, the ones out live on
  release() {
    for (const node of this.layerRoot.children) {
      if (node.isParticleLayer && node.loop) node.stopAt = Math.min(node.stopAt, Math.max(0, node.lt));
      if (node.isTrailLayer) node.released = true;   // the head stops; the path drawn ages out
    }
  }

  _poseAt(node, lt) {
    const L = node.userData.layer || {};
    if (node.isPointLight) {
      if (lt < 0) { node.intensity = 0; return; }
      const fade = Number(L.fade || 0);
      let e = node.userData.energy * (fade > 0 ? 1 - clamp01(lt / fade) : 1);
      if (L.flicker && L.flicker.enabled) e *= 1 + Number(L.flicker.amount ?? 0.3) * Math.sin(this.time * Number(L.flicker.speed ?? 8));
      node.intensity = e * 2.5;
    } else if (node.isMesh) {
      const an = L.animate || {};
      if (!Object.keys(an).length) return;
      const life = Math.max(0.001, Number(an.life ?? 0.6));
      const u = clamp01((lt - Number(an.delay || 0)) / life);
      const tr = L.transform || {};
      const s0 = v3(an.scale_from, scaleOf(tr));
      const s1 = v3(an.scale_to, s0);
      node.scale.set(lerp(s0[0], s1[0], u), lerp(s0[1], s1[1], u), lerp(s0[2], s1[2], u));
      if (an.pos_from || an.pos_to) {
        const p0 = v3(an.pos_from, v3(tr.pos));
        const p1 = v3(an.pos_to, p0);
        node.position.set(lerp(p0[0], p1[0], u), lerp(p0[1], p1[1], u), lerp(p0[2], p1[2], u));
      }
      if (an.rot_from || an.rot_to) {
        const r0 = v3(an.rot_from, v3(tr.rot));
        const r1 = v3(an.rot_to, r0);
        node.rotation.set(...[0, 1, 2].map((k) => THREE.MathUtils.degToRad(lerp(r0[k], r1[k], u))), "YXZ");
      }
      const mat = node.material;
      if (an.fade !== false && mat.uniforms && mat.uniforms.fade && node.userData.fade0 !== undefined) mat.uniforms.fade.value = lerp(node.userData.fade0, 0, u);
      node.visible = !(mat.uniforms && mat.uniforms.fade && node.userData.fade0 !== undefined && mat.uniforms.fade.value < 0.005 && u >= 1);
    } else if (node.userData.decal) {
      const d = node.userData.decal;
      const fade = Number(L.fade ?? 1);
      const k = lt < 0 ? 0 : fade > 0 ? 1 - clamp01(lt / fade) : 1;
      d.mesh.material.opacity = k * Number(L.albedo_mix ?? 1);
      node.updateWorldMatrix(true, false);
      const wp = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
      const ws = new THREE.Vector3().setFromMatrixScale(node.matrixWorld).y;
      const reaches = wp.y - (d.depth * ws) / 2 <= 0.02;
      d.mesh.visible = k > 0.01 && reaches;
      if (reaches) d.mesh.position.y = (0.004 - wp.y) / Math.max(ws, 1e-6);
    }
  }

  // every layer's world box now (particles from their simulation, meshes and decals from their shapes, lights as a point)
  boxes() {
    const out = [];
    this.updateWorldMatrix(true, true);
    for (const node of this.layerRoot.children) {
      let b = null;
      if (node.isTrailLayer) b = node.box();
      else if (node.isParticleLayer) {
        b = node.box();
        if (node.sub) { const sb = node.sub.layer.box(); if (sb) b = b ? b.union(sb) : sb; }
      } else if (node.isMesh && node.visible) b = new THREE.Box3().setFromObject(node);
      else if (node.userData.decal && node.userData.decal.mesh.visible) b = new THREE.Box3().setFromObject(node.userData.decal.mesh);
      else if (node.isPointLight && node.intensity > 0.01) { const p = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld); b = new THREE.Box3(p, p.clone()); }
      if (b && !b.isEmpty()) out.push({ name: node.name, kind: node.isTrailLayer ? "trail" : node.isParticleLayer ? "particles" : node.isPointLight ? "light" : node.userData.decal ? "decal" : "mesh", box: b,
        energy: node.isPointLight ? node.intensity / 2.5 : undefined });
    }
    return out;
  }

  dispose() {
    this.traverse((o) => {
      if (o.isInstancedMesh) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
  }
}

function scaleOf(tr) {
  const s = (tr || {}).scale;
  if (Array.isArray(s)) return v3(s, [1, 1, 1]);
  if (typeof s === "number") return [s, s, s];
  return [1, 1, 1];
}

function applyTransform(node, tr) {
  if (!tr) return;
  const p = v3(tr.pos);
  node.position.set(p[0], p[1], p[2]);
  const r = v3(tr.rot).map(THREE.MathUtils.degToRad);
  node.rotation.set(r[0], r[1], r[2], "YXZ");   // Godot's rotation_degrees order
  const s = scaleOf(tr);
  node.scale.set(s[0], s[1], s[2]);
}
