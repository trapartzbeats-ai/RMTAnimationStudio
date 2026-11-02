// The 3D world: the review-sheet look (plum sky, lavender floor with an orange 0.5 m grid, warm horizon), the fighter loaded
// straight from the game's GLB, a probe body (math only), onion-skin ghosts, props on sockets, and a second scene for the strip.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { Body } from "./core/body.js";
import { v3 } from "./core/clip.js";
import * as G from "./core/grip.js";
import { fingerMapOf } from "./core/fingers.js";

export const SKY = 0x2a2430;

export function makeFloorMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWp;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWp;")
      .replace("#include <color_fragment>", `#include <color_fragment>
      {
        vec2 g = abs(fract(vWp.xz * 2.0 + 0.5) - 0.5) / fwidth(vWp.xz * 2.0);
        float line = 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
        vec2 g1 = abs(fract(vWp.xz * 0.5 + 0.5) - 0.5) / fwidth(vWp.xz * 0.5);
        float major = 1.0 - clamp(min(g1.x, g1.y), 0.0, 1.0);
        diffuseColor.rgb = mix(vec3(0.33, 0.31, 0.38), vec3(0.95, 0.6, 0.25), max(line * 0.6, major));
      }`);
  };
  return m;
}

export function dressScene(scene) {
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(0xf2c58e, 16, 95);
  const hemi = new THREE.HemisphereLight(0xd9d6e6, 0x6b5f78, 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
  sun.position.set(-3.5, 6.5, 4.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 25 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), makeFloorMaterial());
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  return { sun, floor };
}

const loader = new GLTFLoader();

export class Stage {
  constructor() {
    this.scene = new THREE.Scene();
    dressScene(this.scene);
    this.stripScene = new THREE.Scene();
    dressScene(this.stripScene);
    this.ghosts = [];
    this.props = new THREE.Group();
    this.scene.add(this.props);
    this.height = 1.8;
  }

  async loadFighter(url, key, onModel = null) {
    const gltf = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
    for (const old of [this.model, this.stripModel]) if (old) old.parent.remove(old);
    for (const g of this.ghosts) this.scene.remove(g.root);
    this.ghosts = [];
    this.source = gltf.scene;
    if (typeof onModel === "function") onModel(gltf.scene);
    this.key = key;
    this.model = gltf.scene;
    this.model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
      }
    });
    this.scene.add(this.model);
    const fmap = fingerMapOf(key);   // finger turns in clips are on the shared hand: each body turns them onto this fighter's
    this.body = new Body(this.model, fmap);
    this.probe = new Body(SkeletonUtils.clone(this.source), fmap);
    this.stripModel = SkeletonUtils.clone(this.source);
    this.stripScene.add(this.stripModel);
    this.stripBody = new Body(this.stripModel, fmap);
    this.wrapBody = new Body(SkeletonUtils.clone(this.source), fmap);   // hidden: plays the clip through the Body Solve (app.wrapCarry)
    this.body.apply({});
    this.probe.apply({});
    this.wrapBody.apply({});
    this.scene.remove(this.wrapCaps);
    this.wrapCaps = null;
    this.restFeet = {};
    for (const n of ["footL", "footR"]) if (this.probe.has(n)) this.restFeet[n] = this.probe.worldQuat(n);
    // skinned meshes report their bind-space box, so measure the body by its head bone
    this.height = this.body.has("head") ? Math.max(1, this.body.worldPos("head").y * 1.25) : Math.max(1, new THREE.Box3().setFromObject(this.model).max.y);
    this.cloneCount = 0;
  }

  // the game's plant: raise / lower so the lower foot stands on the floor, feet flat like CBAnim.flat_feet
  plant(ankle) {
    const b = this.body;
    if (!b.has("footL") || !b.has("footR")) return;
    const lo = Math.min(b.worldPos("footL").y, b.worldPos("footR").y);
    this.model.position.y = ankle - lo;
    b.update();
    const ys = { footL: b.worldPos("footL").y, footR: b.worldPos("footR").y };
    const low = Math.min(ys.footL, ys.footR);
    for (const n of ["footL", "footR"]) {
      const k = Math.min(1, Math.max(0, 1 - (ys[n] - low) / 0.12));
      if (k > 0 && this.restFeet[n]) b.setWorldQuat(n, this.restFeet[n], k);
    }
  }

  // the Collision Wrap's capsules on the body as it stands (View > Wrap capsules): red = a part still in the body or the floor
  // after the Body Solve (clash: piece indices), blue = clear
  drawWrap(wrapBody, clash, on) {
    if (!on || !wrapBody) { if (this.wrapCaps) this.wrapCaps.visible = false; return; }
    if (!this.wrapCaps) {
      this.wrapCaps = new THREE.Group();
      const caps = wrapBody.capsules();
      for (const c of caps) {
        const mat = new THREE.MeshBasicMaterial({ color: 0x5ab4ff, wireframe: true, transparent: true, opacity: 0.45, depthTest: false });
        const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(c[2], c[0].distanceTo(c[1]), 3, 10), mat);
        mesh.renderOrder = 5;
        this.wrapCaps.add(mesh);
      }
      this.scene.add(this.wrapCaps);
    }
    this.wrapCaps.visible = true;
    const y = new THREE.Vector3(0, 1, 0);
    wrapBody.capsules().forEach((c, i) => {
      const mesh = this.wrapCaps.children[i];
      const d = c[1].clone().sub(c[0]);
      mesh.position.copy(c[0]).add(c[1]).multiplyScalar(0.5);
      if (d.length() > 1e-6) mesh.quaternion.setFromUnitVectors(y, d.normalize());
      mesh.material.color.set(clash.has(i) ? 0xff4d4d : 0x5ab4ff);
      mesh.material.opacity = clash.has(i) ? 0.8 : 0.4;
    });
  }

  // onion skin: ghosts of the frames before (blue) and after (orange)
  updateOnion(app) {
    const o = app.onion;
    const want = o.on ? o.before + o.after : 0;
    while (this.ghosts.length < want) {
      const root = SkeletonUtils.clone(this.source);
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0.3, color: 0x66aaff });
      root.traverse((x) => { if (x.isMesh) { x.material = mat; x.castShadow = false; x.receiveShadow = false; x.frustumCulled = false; } });
      this.scene.add(root);
      this.ghosts.push({ root, body: new Body(root, fingerMapOf(this.key)), mat });
    }
    while (this.ghosts.length > want) this.scene.remove(this.ghosts.pop().root);
    if (!want) return;
    const fs = [];
    if (o.keys) {
      let f = app.frame;
      for (let i = 0; i < o.before; i++) { const k = app.doc.prevKey(f); fs.push(k); f = k < 0 ? -1 : k; }
      f = app.frame;
      for (let i = 0; i < o.after; i++) { const k = app.doc.nextKey(f); fs.push(k); f = k < 0 ? 1e9 : k; }
    } else {
      for (let i = 0; i < o.before; i++) fs.push(app.frame - o.step * (i + 1));
      for (let i = 0; i < o.after; i++) fs.push(app.frame + o.step * (i + 1));
    }
    this.ghosts.forEach((g, i) => {
      const f = fs[i];
      g.root.visible = f >= 0 && f <= app.doc.frames;
      if (!g.root.visible) return;
      app.finalPoseOn(g.body, f);
      if (app.show.wrap) app.matchFinish(g.body, app.wrapCarry(f));   // as the match shows that frame
      const before = i < o.before;
      const depth = (before ? i : i - o.before) + 1;
      g.mat.color.set(before ? 0x5aa6ff : 0xff8c33);
      g.mat.opacity = 0.34 / depth;
    });
  }

  placeProps(app) {
    const list = app.doc.props;
    const sig = list.map((p) => `${p.shape}|${p.color}|${JSON.stringify(p.size || "")}`).join(";");
    if (sig !== this._propSig) {
      this._propSig = sig;
      this.props.clear();
      for (const p of list) {
        const geo = G.PROXY_SIZES[p.shape] ? G.proxyGeometry(p.shape, v3(p.size || G.PROXY_SIZES[p.shape])) : propGeometry(p.shape);
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: p.color || "#c8c0d0", roughness: 0.6 }));
        mesh.castShadow = true;
        this.props.add(mesh);
      }
    }
    list.forEach((p, i) => {
      const mesh = this.props.children[i];
      if (mesh && p.grip) {   // in the hand by grip kind: cylinder_R, sphere_L, block_R ... (grip.js, the frame the game uses)
        const [kind, side] = String(p.grip).split("_");
        const size = v3(p.size || G.PROXY_SIZES[p.shape] || [0.1, 0.1, 0.1]);
        const r = v3(p.rot).map((x) => (x * Math.PI) / 180);
        const local = new THREE.Matrix4().compose(new THREE.Vector3(...v3(p.offset)), new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], "YXZ")), new THREE.Vector3(1, 1, 1));
        const at = G.frame(app.stage.body, side || "R", kind, size).multiply(local);
        at.decompose(mesh.position, mesh.quaternion, mesh.scale);
        mesh.scale.multiplyScalar(Number(p.scale ?? 1));
        mesh.visible = p.visible !== false;
        if (p.wrap !== false) G.wrapHand(app.stage.body, side || "R", kind, size, at);   // the fingers close round it till their skin meets it
        return;
      }
      const sp = app.sockSpecs[p.socket] || { bone: p.bone || "handR" };
      if (!mesh || !app.stage.body.has(sp.bone)) { if (mesh) mesh.visible = false; return; }
      mesh.visible = p.visible !== false;
      const q = app.stage.body.worldQuat(sp.bone);
      mesh.position.copy(app.socketWorld(p.socket)).add(new THREE.Vector3(...v3(p.offset)).applyQuaternion(q));
      const r = v3(p.rot).map((x) => (x * Math.PI) / 180);
      mesh.quaternion.copy(q).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], "YXZ")));   // Godot's Basis.from_euler order
      mesh.scale.setScalar(Number(p.scale ?? 1));
    });
  }
}

// grey proxies with a size (size: [x, y, z] m) are for placement work; grip: "cylinder_R" etc. puts a prop in the hand by the
// game's grip frame instead of on a socket
export const PROP_SHAPES = ["box", "bat", "blade", "ball", "can", "phone", "block", "cylinder", "sphere"];

function propGeometry(shape) {
  switch (shape) {
    case "bat": return new THREE.CylinderGeometry(0.035, 0.018, 0.85, 16);
    case "blade": return new THREE.BoxGeometry(0.05, 0.9, 0.01);
    case "ball": return new THREE.SphereGeometry(0.11, 24, 16);
    case "can": return new THREE.CylinderGeometry(0.033, 0.033, 0.12, 20);
    case "phone": return new THREE.BoxGeometry(0.075, 0.15, 0.01);
  }
  return new THREE.BoxGeometry(0.2, 0.2, 0.2);
}
