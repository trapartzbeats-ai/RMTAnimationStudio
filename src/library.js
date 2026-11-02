// The Library: one place to pick a model (fighter), an animation (clip) or an effect (block). Cards with search, filter chips,
// favourites (kept in this browser profile), and the pick actions each kind needs. Models get a portrait rendered once from the
// GLB; effects show the thumb.png the Effect Forge made; animations show their length and what kind of move they are.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { h, button, row, hint } from "./ui.js";

const FAV_KEY = "rmt.library.favs";
const loadFavs = () => { try { return JSON.parse(localStorage.getItem(FAV_KEY) || "{}"); } catch { return {}; } };
const saveFavs = (f) => { try { localStorage.setItem(FAV_KEY, JSON.stringify(f)); } catch { /* private window: favourites last for this session */ } };

// what kind of move a clip is, from its name (a_<fighter>_<move>, w_<name>, or one of yours)
const KINDS = [
  ["Throws", /(grab|throw|captured|pummel|carry)/],
  ["Attacks", /(jab|tilt|smash|bair|fair|nair|dair|uair|dash_attack|special|getup_attack|ledge_attack|ult|attack|punch|kick)/],
  ["Reactions", /(damage|down|ko$|knockdown|hit|getup|stun|dizzy|fly|launch)/],
  ["Guard & style", /(guard|taunt|victory|win|lose|pose|emote|idle_alt)/],
  ["Movement", /(idle|walk|run|dash|jump|fall|land|kneebend|crouch|dodge|escape|tech|cliff|ledge|turn|stand)/],
];
export function kindOf(name) {
  if (name.startsWith("w_")) return "World";
  const m = name.replace(/^a_[a-z0-9]+_/, "");
  if (!name.startsWith("a_") && !/_ult_/.test(name)) { for (const [k, re] of KINDS) if (re.test(m)) return k; return "Mine"; }
  for (const [k, re] of KINDS) if (re.test(m)) return k;
  return "Other";
}
const fighterOf = (name) => (/^a_([a-z0-9]+)_/.exec(name) || /^([a-z0-9]+)_ult_/.exec(name) || [])[1] || "";

// ------------------------------------------------------------------ model portraits
let thumbRenderer = null;
const thumbCache = new Map();
async function portrait(app, key) {
  if (thumbCache.has(key)) return thumbCache.get(key);
  const url = await window.host.modelUrl(key);
  if (!url) return "";
  const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
  const W = 168, H = 224;
  if (!thumbRenderer) {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    thumbRenderer = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setSize(W, H, false);
    thumbRenderer.setClearColor(0x000000, 0);
  }
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff2e0, 0x3a2f48, 1.6));
  const key1 = new THREE.DirectionalLight(0xffffff, 2.2);
  key1.position.set(1.5, 2.5, 3);
  scene.add(key1);
  scene.add(gltf.scene);
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
  const cam = new THREE.PerspectiveCamera(24, W / H, 0.05, 100);
  const dist = (Math.max(size.y, size.x / (W / H)) * 0.62) / Math.tan((cam.fov * Math.PI) / 360);
  cam.position.set(mid.x + dist * 0.28, mid.y + size.y * 0.04, mid.z + dist);
  cam.lookAt(mid);
  thumbRenderer.render(scene, cam);
  const data = thumbRenderer.domElement.toDataURL("image/png");
  scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  thumbCache.set(key, data);
  return data;
}

// ------------------------------------------------------------------ the panel
export function Library(app) {
  const el = h("div", { class: "pbody lib" });
  const tabs = ["Models", "Animations", "Effects"];
  const want = (app.info.args || []).find((a) => a.startsWith("--lib="));
  let tab = want && tabs.includes(want.slice(6)) ? want.slice(6) : "Models";
  const state = { q: "", chips: { Models: "All", Animations: "All", Effects: "All" }, sel: { Models: "", Animations: "", Effects: "" }, fighterOnly: false, favsOnly: false };
  const favs = loadFavs();
  let clipIdx = null;

  const tabBar = h("div", { class: "libtabs" });
  const search = h("input", { type: "text", placeholder: "search", oninput: () => { state.q = search.value.trim().toLowerCase(); render(); } });
  const chipBar = h("div", { class: "libchips" });
  const toggles = h("div", { class: "libchips" });
  const grid = h("div", { class: "libgrid" });
  const actions = h("div", { class: "libactions" });
  const info = h("div", { class: "hint libinfo" });
  el.append(tabBar, search, chipBar, toggles, grid, info, actions);

  const isFav = (k) => !!favs[k];
  const toggleFav = (k) => { if (favs[k]) delete favs[k]; else favs[k] = 1; saveFavs(favs); render(); };

  function chips(names) {
    chipBar.replaceChildren(...names.map((n) => h("button", { class: "chip" + (state.chips[tab] === n ? " on" : ""), onclick: () => { state.chips[tab] = n; render(); } }, n)));
  }
  function toggle(text, on, fn, title) {
    return h("button", { class: "chip" + (on ? " on" : ""), title, onclick: fn }, text);
  }

  // ---------------------------------------------------------------- models
  function models() {
    const all = app.fighters.map((k) => ({ key: k, clips: clipIdx ? Object.keys(clipIdx).filter((n) => fighterOf(n) === k).length : 0 }));
    chips(["All", "Favourites"]);
    const list = all.filter((m) => (!state.q || m.key.includes(state.q)) && (state.chips.Models !== "Favourites" || isFav("m:" + m.key)));
    grid.replaceChildren(...list.map((m) => {
      const img = h("img", { class: "libimg", alt: m.key, draggable: false });
      portrait(app, m.key).then((u) => { if (u) img.src = u; }).catch((e) => window.host.log("library portrait " + m.key + ": " + (e && e.message)));
      const card = h("div", { class: "libcard" + (app.fighter === m.key ? " current" : "") + (state.sel.Models === m.key ? " sel" : ""),
        onclick: () => { state.sel.Models = m.key; render(); }, ondblclick: () => app.setFighter(m.key) },
        h("div", { class: "libthumb tall" }, img, favBtn("m:" + m.key)),
        h("div", { class: "libname" }, m.key), h("div", { class: "libsub" }, `${m.clips} clips` + (app.fighter === m.key ? "  -  on the stage" : "")));
      return card;
    }));
    const k = state.sel.Models;
    info.textContent = k ? `${k}: double-click or LOAD to put this body on the stage. Every fighter shares the rig, so every clip plays on every model.` : "Pick a model.";
    actions.replaceChildren(
      button("LOAD ON STAGE", () => state.sel.Models && app.setFighter(state.sel.Models), "Put this body on the stage (the open clip stays)"),
      button("SHOW ITS MOVES", () => { if (!state.sel.Models) return; tab = "Animations"; state.fighterOnly = false; state.chips.Animations = "All"; search.value = `a_${state.sel.Models}_`; state.q = search.value; render(); }, "Jump to this fighter's clips"));
  }

  const favBtn = (k) => h("button", { class: "libstar" + (isFav(k) ? " on" : ""), title: "Favourite", onclick: (e) => { e.stopPropagation(); toggleFav(k); } }, isFav(k) ? "★" : "☆");

  // ---------------------------------------------------------------- animations
  function animations() {
    grid.classList.add("wide");
    if (!clipIdx) { grid.replaceChildren(h("div", { class: "hint" }, "reading the clips...")); return; }
    const kinds = ["All", "Favourites", "Attacks", "Throws", "Reactions", "Movement", "Guard & style", "World", "Mine", "Other"];
    chips(kinds);
    toggles.replaceChildren(
      toggle("this fighter's", state.fighterOnly, () => { state.fighterOnly = !state.fighterOnly; render(); }, `Only a_${app.fighter}_ clips`),
      toggle("ultimates", state.chips.__ult === 1, () => { state.chips.__ult = state.chips.__ult === 1 ? 0 : 1; render(); }, "Only the ultimate clips"));
    const names = Object.keys(clipIdx).filter((n) => {
      const c = state.chips.Animations;
      if (state.q && !n.toLowerCase().includes(state.q)) return false;
      if (state.fighterOnly && fighterOf(n) !== app.fighter) return false;
      if (state.chips.__ult === 1 && !/ult/.test(n)) return false;
      if (c === "Favourites") return isFav("a:" + n);
      return c === "All" || kindOf(n) === c;
    }).sort((a, b) => (isFav("a:" + b) - isFav("a:" + a)) || (a < b ? -1 : 1));
    const shown = names.slice(0, 240);
    grid.replaceChildren(...shown.map((n) => {
      const e = clipIdx[n];
      const secs = e.fps ? (e.frames / e.fps).toFixed(2) : "?";
      return h("div", { class: "libcard clip" + (app.doc.name === n ? " current" : "") + (state.sel.Animations === n ? " sel" : ""),
        onclick: () => { state.sel.Animations = n; render(); }, ondblclick: () => app.openClip(n) },
        h("div", { class: "libclipbar" }, h("span", { class: "libkind k-" + kindOf(n).split(" ")[0].toLowerCase() }, kindOf(n)), favBtn("a:" + n)),
        h("div", { class: "libname" }, n.replace(/^a_/, "")),
        h("div", { class: "libsub" }, `${e.frames}f  ${secs}s${e.loop ? "  loop" : ""}  ${e.keys} keys`));
    }));
    if (names.length > shown.length) grid.append(h("div", { class: "hint", style: "grid-column:1/-1" }, `${names.length - shown.length} more - narrow the search.`));
    const k = state.sel.Animations;
    info.textContent = k ? (clipIdx[k].note || k) : `${names.length} clips. Double-click to open.`;
    actions.replaceChildren(
      button("OPEN", () => k && app.openClip(k), "Open this clip in the dope sheet"),
      button("AS LAYER", () => { if (k) { app.addLayer({ name: k, source: "clip", clip: k, mode: "override", mask: ["torso", "chest", "neck", "head", "armL", "elbowL", "handL", "armR", "elbowR", "handR"] }); app.ui.showPanel("Layers"); } }, "Blend it on top of the open clip as an upper-body layer"),
      button("NEW FROM THIS", () => { if (k) app.ui.prompt(`Save a copy of ${k} as:`, k + "_v2", async (n) => { if (await app.openClip(k, true)) app.saveAs(n); }); }, "Duplicate it under a new name"));
  }

  // ---------------------------------------------------------------- effects
  function effects() {
    const blocks = app.fx ? [...app.fx.library.values()] : [];
    const cats = ["All", "Favourites", ...[...new Set(blocks.map((b) => b.category))].sort()];
    chips(cats);
    const list = blocks.filter((b) => {
      const m = b.manifest || {};
      const tags = (m.tags || []).join(" ");
      if (state.q && !(b.id.toLowerCase().includes(state.q) || tags.toLowerCase().includes(state.q) || b.category.toLowerCase().includes(state.q))) return false;
      const c = state.chips.Effects;
      return c === "All" || (c === "Favourites" ? isFav("e:" + b.id) : b.category === c);
    });
    grid.replaceChildren(...list.map((b) => {
      const m = b.manifest || {};
      const img = h("img", { class: "libimg", src: b.dir + "thumb.png", alt: b.id, draggable: false, onerror: () => img.classList.add("gone") });
      return h("div", { class: "libcard" + (state.sel.Effects === b.id ? " sel" : "") + (app.fxs && app.fxs.id === b.id ? " current" : ""), onclick: () => { state.sel.Effects = b.id; if (app.mode === "FX") app.fxs.open(b.id); render(); }, ondblclick: () => addEffect(b.id) },
        h("div", { class: "libthumb" }, img, favBtn("e:" + b.id)),
        h("div", { class: "libname" }, b.id), h("div", { class: "libsub" }, `${b.category}  -  ${(m.duration ?? 1).toFixed ? Number(m.duration ?? 1).toFixed(2) : m.duration}s${m.loop ? "  -  loop" : ""}${b.override ? "  -  override" : ""}`));
    }));
    const k = state.sel.Effects;
    const m = k && app.fx.library.get(k);
    info.textContent = m ? `${(m.manifest.layers || []).map((l) => l.name + ":" + l.kind).join("  ")}${(m.manifest.tags || []).length ? "   #" + m.manifest.tags.join(" #") : ""}` : `${list.length} effects. Double-click to fire one at the playhead.`;
    actions.replaceChildren(
      button("+ AT PLAYHEAD", () => k && addEffect(k), "Fire it at the origin at this frame (move it to a socket in the Effects panel)"),
      button("TUNE IN FX STUDIO", () => { if (!k) return; if (app.mode !== "FX") app.ui.setMode("FX"); app.fxs.open(k); }, "Open it in the FX Studio: edit every setting, play it beside the fighter"),
      button("OPEN IN GODOT", async () => { const ok = await app.fx.openStudio(k || ""); app.say(ok ? "The RMT Effect Studio opens on this fighter and clip." : "Godot was not found (set FIGHT_STUDIO_GODOT).", ok ? "ok" : "warn"); }, "Make or change a block in the Godot effect editor"));
  }
  async function addEffect(id) {
    const i = await app.fx.add({ id, socket: "origin", mode: "burst", dur: 0.5, scale: 1, offset: [0, 0, 0], rot: [0, 0, 0], frame: app.frame });
    if (i < 0) { app.say(`No block ${id} in the library.`, "warn"); return; }
    app.say(`${id} fires at frame ${Math.round(app.frame)}. Set its socket in the Effects panel.`, "ok");
    app.ui.showPanel("Effects");
  }

  function render() {
    tabBar.replaceChildren(...tabs.map((t) => h("button", { class: "libtab" + (t === tab ? " on" : ""), onclick: () => { tab = t; search.value = ""; state.q = ""; render(); } }, t.toUpperCase())));
    toggles.replaceChildren();
    grid.classList.remove("wide");
    search.placeholder = tab === "Models" ? "search models" : tab === "Animations" ? "search clips (name, fighter, move)" : "search effects (id, tag, category)";
    if (tab === "Models") models(); else if (tab === "Animations") animations(); else effects();
  }

  async function reload() { clipIdx = await window.host.clipIndex(); render(); }
  app.on((w) => { if (w === "libtab" && tabs.includes(app.libraryTab)) { tab = app.libraryTab; search.value = ""; state.q = ""; render(); } });
  app.on((w) => { if (["clips", "saved", "fighter", "clip"].includes(w)) { if (w === "clips" || w === "saved") reload(); else render(); } });
  render();
  reload();
  // the effects load after boot: show them when they are there
  const wait = setInterval(() => { if (app.fx && app.fx.library.size) { clearInterval(wait); render(); } }, 500);
  return el;
}
