// Godot spatial shaders (the game's addons/rmt_effects/shaders/*.gdshader) as three.js ShaderMaterials, translated when they
// load, so the RMT effect blocks' meshes look here the way they do in the game. It covers what those shaders use:
// render_mode (blend_add / blend_mix, cull_disabled / cull_back, depth_draw_never, unshaded), uniforms with defaults
// (source_color is sRGB, turned linear like Godot does), helper functions and varyings, vertex() and fragment() with TIME, UV,
// VERTEX, NORMAL, VIEW, COLOR, ALBEDO, ALPHA, EMISSION and the matrices. Unshaded output is ALBEDO with ALPHA, as in Godot.
import * as THREE from "three";

const _cache = new Map();   // shader text -> parsed

// the parts of a shader: {modes, uniforms: [{type, name, color, def}], decls, vertex, fragment}
export function parse(src) {
  if (_cache.has(src)) return _cache.get(src);
  let s = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const modes = new Set();
  s = s.replace(/shader_type\s+\w+\s*;/, "").replace(/render_mode\s+([^;]*);/, (_m, list) => {
    for (const x of list.split(",")) modes.add(x.trim());
    return "";
  });
  const uniforms = [];
  const descs = {};
  for (const m of src.matchAll(/uniform\s+\w+\s+(\w+)[^;\n]*;[ \t]*\/\/\s*([^\n]*)/g)) descs[m[1]] = m[2].trim();
  s = s.replace(/uniform\s+(\w+)\s+(\w+)\s*(?::\s*([^=;]+))?(?:=\s*([^;]+))?;/g, (_m, type, name, hints, def) => {
    const rg = /hint_range\(\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*(?:,\s*(-?[\d.eE+-]+))?\s*\)/.exec(hints || "");
    uniforms.push({ type, name, color: /source_color/.test(hints || ""), def: def ? def.trim() : null, desc: descs[name] || "",
      range: rg ? [Number(rg[1]), Number(rg[2]), rg[3] !== undefined ? Number(rg[3]) : 0] : null, tex: type === "sampler2D" });
    return "";
  });
  const vertex = body(s, "vertex");
  const fragment = body(s, "fragment");
  let decls = s;
  for (const b of [vertex, fragment]) if (b) decls = decls.replace(b.whole, "");
  const out = { modes, uniforms, decls: decls.trim(), vertex: vertex ? vertex.inner : "", fragment: fragment ? fragment.inner : "" };
  _cache.set(src, out);
  return out;
}

function body(s, name) {
  const m = new RegExp("void\\s+" + name + "\\s*\\(\\s*\\)\\s*\\{").exec(s);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return { whole: s.slice(m.index, i + 1), inner: s.slice(m.index + m[0].length, i) };
  }
  return null;
}

// a GLSL value from a Godot default ("vec4(1.0, 0.5, 0.2, 1.0)", "0.3", "vec3(1.0)") as a three.js uniform value
function value(type, def, color) {
  const nums = def ? (def.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number) : [];
  const n = { float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4 }[type] || 1;
  const v = Array.from({ length: n }, (_, i) => (nums.length === 1 ? nums[0] : nums[i] ?? (n === 4 && i === 3 ? 1 : 0)));
  if (type === "bool") return /true/.test(def || "");
  if (n === 1) return v[0];
  if (color && n >= 3) {
    const c = new THREE.Color().setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);   // source_color: sRGB in, linear on the GPU
    return n === 4 ? new THREE.Vector4(c.r, c.g, c.b, v[3]) : new THREE.Vector3(c.r, c.g, c.b);
  }
  return n === 2 ? new THREE.Vector2(v[0], v[1]) : n === 3 ? new THREE.Vector3(v[0], v[1], v[2]) : new THREE.Vector4(v[0], v[1], v[2], v[3]);
}

// a manifest value onto a uniform: "#rrggbb[aa]" / "rrggbb" hex (sRGB), arrays, numbers
export function uniformValue(u, v) {
  if (typeof v === "string") {
    const hex = v.replace("#", "");
    const c = new THREE.Color().setRGB(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, THREE.SRGBColorSpace);
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return u.type === "vec3" ? new THREE.Vector3(c.r, c.g, c.b) : new THREE.Vector4(c.r, c.g, c.b, a);
  }
  if (Array.isArray(v)) return v.length === 2 ? new THREE.Vector2(...v) : v.length === 3 ? new THREE.Vector3(...v) : new THREE.Vector4(v[0], v[1], v[2], v[3] ?? 1);
  return v;
}

function swap(code, map) {
  return code.replace(/\b[A-Z_][A-Z0-9_]*\b/g, (w) => (w in map ? map[w] : w));
}

const VERT_MAP = { VERTEX: "VERTEX_", NORMAL: "NORMAL_", COLOR: "COLOR_", UV: "UV_", TIME: "uTime", MODELVIEW_MATRIX: "MODELVIEW_", MODELVIEW_NORMAL_MATRIX: "MVNORMAL_", POSITION: "POSITION_",
  MODEL_MATRIX: "MODEL_", VIEW_MATRIX: "viewMatrix", PROJECTION_MATRIX: "projectionMatrix", INV_VIEW_MATRIX: "inverse(viewMatrix)",
  INSTANCE_CUSTOM: "INSTANCE_CUSTOM_", CAMERA_POSITION_WORLD: "cameraPosition" };
const FRAG_MAP = { ALBEDO: "ALBEDO_", ALPHA: "ALPHA_", EMISSION: "EMISSION_", NORMAL: "NORMAL_", VIEW: "VIEW_", UV: "vUv", COLOR: "vColor", FRONT_FACING: "gl_FrontFacing", VERTEX: "VERTEX_", SCREEN_UV: "(gl_FragCoord.xy / uViewport)", INV_PROJECTION_MATRIX: "inverse(uProj)",
  TIME: "uTime", VIEW_MATRIX: "viewMatrix", PROJECTION_MATRIX: "uProj", INV_VIEW_MATRIX: "inverse(viewMatrix)",
  CAMERA_POSITION_WORLD: "cameraPosition" };

// a ShaderMaterial from Godot shader text; params = the layer's values by uniform name. material.uniforms.uTime runs the clock.
export function material(src, params = {}) {
  const p = parse(src);
  const uniforms = { uTime: { value: 0 }, uViewport: { value: new THREE.Vector2(1, 1) }, uProj: { value: new THREE.Matrix4() } };
  const decl = [];
  for (const u of p.uniforms) {
    const glslType = u.type === "int" ? "int" : u.type === "bool" ? "bool" : u.type;
    decl.push(`uniform ${glslType} ${u.name};`);
    uniforms[u.name] = { value: u.name in params ? uniformValue(u, params[u.name]) : value(u.type, u.def, u.color) };
  }
  const shared = `uniform float uTime;\nuniform vec2 uViewport;\nuniform mat4 uProj;\n${decl.join("\n")}\n${p.decls}\n`;
  const vertexShader = `varying vec2 vUv;
varying vec3 vNormalV;
varying vec3 vViewV;
varying vec4 vColor;
#ifdef USE_INSTANCING
attribute float aAlpha;
#endif
${shared}
void main() {
  vec3 VERTEX_ = position;
  vec3 NORMAL_ = normal;
  vec2 UV_ = uv;
  vec4 COLOR_ = vec4(1.0);
  mat4 MODELVIEW_ = modelViewMatrix;   // Godot lets a vertex shader write these (a billboard)
  mat4 MODEL_ = modelMatrix;
  mat3 MVNORMAL_ = normalMatrix;
  vec4 POSITION_ = vec4(0.0);
  vec4 INSTANCE_CUSTOM_ = vec4(0.0);   // the particle layers draw with their own material; a mesh layer has no custom data
#ifdef USE_INSTANCING_COLOR
  COLOR_ = vec4(instanceColor, aAlpha);
#endif
  ${swap(p.vertex, VERT_MAP)}
  vUv = UV_;
  vColor = COLOR_;
  vec4 local = vec4(VERTEX_, 1.0);
  vec3 n = NORMAL_;
#ifdef USE_INSTANCING
  local = instanceMatrix * local;
  n = mat3(instanceMatrix) * n;
#endif
  vec4 mv = MODELVIEW_ * local;
  vNormalV = normalize(MVNORMAL_ * n);
  vViewV = -mv.xyz;
  gl_Position = ${/POSITION/.test(p.vertex) ? "POSITION_" : "projectionMatrix * mv"};
}`;
  const fragmentShader = `varying vec2 vUv;
varying vec3 vNormalV;
varying vec3 vViewV;
varying vec4 vColor;
${shared}
void main() {
  vec3 ALBEDO_ = vec3(1.0);
  float ALPHA_ = 1.0;
  vec3 EMISSION_ = vec3(0.0);
  vec3 NORMAL_ = normalize(vNormalV) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 VIEW_ = normalize(vViewV);
  vec3 VERTEX_ = -vViewV;
  ${swap(p.fragment, FRAG_MAP)}
  gl_FragColor = vec4(ALBEDO_, clamp(ALPHA_, 0.0, 1.0));
  #include <colorspace_fragment>
}`;
  const add = p.modes.has("blend_add");
  const m = new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader, transparent: true,
    blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: !(p.modes.has("depth_draw_never") || add),
    side: p.modes.has("cull_back") ? THREE.FrontSide : p.modes.has("cull_front") ? THREE.BackSide : THREE.DoubleSide,
  });
  m.userData.gdUniforms = p.uniforms;
  return m;
}

export function hasUniform(mat, name) {
  return !!(mat && mat.uniforms && name in mat.uniforms);
}
