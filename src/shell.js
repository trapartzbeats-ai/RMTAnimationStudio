// The window: menu bar, tool bar, canvas, transport, docks (tabs you drag between docks; right-click a tab to float it in its
// own window, close that window to dock it back), splitters, status bar, prompt dialogs, and extra canvas windows.
import { h, button, select, num, check } from "./ui.js";
import { suggestName } from "./core/motion_import.js";
import * as R from "./core/rig.js";
import { EASES } from "./core/doc.js";
import { ViewHost, LAYOUTS, renderPicture } from "./views.js";

const LAYOUT_KEY = "fs_desktop_layout_v1";
const MODE_KEY = "rmt_studio_mode_v1";

// The modes: one job each. A mode is a canvas layout, the panels that job needs (the rest are tucked away; Window > Show panel
// brings any of them back) and which tab each dock opens on. `library` is the Library tab the mode opens on.
export const MODES = {
  POSE: { tip: "Pose and key the body: keys, IK, Fill, Merge, Layers. (Alt+1)", layout: "4", library: "Animations",
    show: ["Library", "Clips", "Poses", "Sockets", "Properties", "Controls", "Rig v5", "Adjust", "Fill", "Layers", "Constraints", "Outliner", "Checks", "Dope Sheet", "Graph", "Blend Lab", "Merge", "Feet", "Agents", "History", "Render"],
    active: { left: "Library", right_top: "Properties", right_bottom: "Outliner", bottom: "Dope Sheet" } },
  FX: { tip: "Pick, edit, play and fire effects on the move. (Alt+2)", layout: "2", library: "Effects", size: { rtFrac: 0.8, rightW: 460 },
    show: ["Library", "Sockets", "FX Studio", "Effects", "Layers", "Outliner", "Dope Sheet", "Graph", "Render"],
    active: { left: "Library", right_top: "FX Studio", right_bottom: "Outliner", bottom: "Dope Sheet" } },
  COMPOSE: { tip: "Pose and effects together on one timeline. (Alt+3)", layout: "4", library: "Animations", size: { rtFrac: 0.8, rightW: 440 },
    show: ["Library", "Clips", "Sockets", "Properties", "Compose", "Effects", "Fill", "Layers", "Merge", "Outliner", "Dope Sheet", "Graph", "Render"],
    active: { left: "Library", right_top: "Compose", right_bottom: "Outliner", bottom: "Dope Sheet" } },
  REVIEW: { tip: "Look at the move from every angle and run the checks. (Alt+4)", layout: "4+strip", library: "Animations", size: { rtFrac: 0.8, rightW: 440 },
    show: ["Library", "Clips", "Review", "Properties", "Checks", "Outliner", "Dope Sheet", "Feet", "Render", "History"],
    active: { left: "Clips", right_top: "Review", right_bottom: "Checks", bottom: "Dope Sheet" } },
  SETUP: { tip: "Get a new fighter or move game-ready, step by step. (Alt+5)", layout: "2", library: "Models",
    show: ["Setup", "Library", "Sockets", "Rig v5", "Properties", "Checks", "Outliner", "Feet", "Dope Sheet"],
    active: { left: "Setup", right_top: "Rig v5", right_bottom: "Checks", bottom: "Feet" } },
};

export class Shell {
  constructor(app) {
    this.app = app;
    this.panels = new Map();   // title -> {el, dock, home, win}
    this.docks = new Map();    // name -> {el, tabs, content}
    this.windows = [];
    app.ui = this;
  }

  build(root) {
    const app = this.app;
    this.menubar = h("div", { class: "menubar" });
    this.toolbar = h("div", { class: "toolbar" });
    this.canvasWrap = h("div", { class: "canvas" });
    this.transport = h("div", { class: "toolbar transport" });
    this.status = h("div", { class: "status" });
    const left = this._dock("left"), rt = this._dock("right_top"), rb = this._dock("right_bottom"), bottom = this._dock("bottom");
    this.center = h("div", { class: "center" }, this.canvasWrap, this._splitter("v", this.canvasWrap, "canvasH"), this.transport, bottom.el);
    this.right = h("div", { class: "right" }, rt.el, this._splitter("v", rt.el, "rtH"), rb.el);
    left.el.classList.add("left");
    this.main = h("div", { class: "main" }, left.el, this._splitter("h", left.el, "leftW"), this.center, this._splitter("h", this.right, "rightW", true), this.right);
    root.append(this.menubar, this.toolbar, this.main, this.status);
    this.modal = h("div", { class: "modal hidden" });
    root.append(this.modal);
    this.ctxMenu = h("div", { class: "ctxmenu hidden" });
    root.append(this.ctxMenu);
    document.addEventListener("pointerdown", (e) => { if (!this.ctxMenu.contains(e.target)) this.ctxMenu.classList.add("hidden"); if (!this.menubar.contains(e.target)) this._closeMenus(); });
    this._restoreSizes();
  }

  // ---------------------------------------------------------------- docks
  _dock(name) {
    const tabs = h("div", { class: "tabs" });
    const content = h("div", { class: "content" });
    const el = h("div", { class: "dock", "data-dock": name }, tabs, content);
    tabs.addEventListener("dragover", (e) => e.preventDefault());
    tabs.addEventListener("drop", (e) => { e.preventDefault(); const t = e.dataTransfer.getData("text/panel"); if (t) this.movePanel(t, name); });
    const d = { el, tabs, content, name };
    this.docks.set(name, d);
    return d;
  }

  addPanel(title, el, dockName) {
    el.classList.add("panel");
    this.panels.set(title, { el, dock: dockName, home: dockName, win: null, hidden: false });
    this._place(title, dockName);
  }

  _place(title, dockName) {
    const p = this.panels.get(title);
    const d = this.docks.get(dockName);
    p.dock = dockName;
    if (p.el.ownerDocument !== document) document.adoptNode(p.el);
    d.content.append(p.el);
    this._renderTabs();
    this.activate(title);
  }

  _renderTabs() {
    for (const d of this.docks.values()) {
      d.tabs.innerHTML = "";
      for (const [t, p] of this.panels) {
        if (p.dock !== d.name || p.win || p.hidden) continue;
        const tab = h("div", { class: "tab" + (p.el.classList.contains("active") ? " active" : ""), draggable: true }, t);
        tab.onclick = () => this.activate(t);
        tab.oncontextmenu = (e) => { e.preventDefault(); this.tabMenu(t, e.clientX, e.clientY); };
        tab.ondragstart = (e) => e.dataTransfer.setData("text/panel", t);
        d.tabs.append(tab);
      }
    }
  }

  activate(title) {
    const p = this.panels.get(title);
    if (!p) return;
    if (p.win) { p.win.focus(); return; }
    p.hidden = false;
    for (const [, q] of this.panels) if (q.dock === p.dock && !q.win) q.el.classList.toggle("active", q === p);
    this._renderTabs();
    p.el.__resize && requestAnimationFrame(() => p.el.__resize());
  }

  showPanel(title) { this.activate(title); }

  // switch the whole window to one job (see MODES)
  setMode(name, save = true) {
    const m = MODES[name];
    if (!m) return false;
    this.mode = name;
    this.app.mode = name;
    const shown = new Set(m.show);
    for (const [t, p] of this.panels) {
      if (p.win) continue;
      p.hidden = !shown.has(t);
      if (p.hidden) p.el.classList.remove("active");
    }
    for (const d of this.docks.values()) {
      for (const [, p] of this.panels) if (p.dock === d.name && !p.win) p.el.classList.remove("active");
      const want = m.active[d.name];
      const pick = this.panels.get(want) && !this.panels.get(want).hidden && this.panels.get(want).dock === d.name ? want
        : [...this.panels].find(([, p]) => p.dock === d.name && !p.hidden && !p.win)?.[0];
      if (pick) this.activate(pick);
    }
    this._renderTabs();
    this.app.libraryTab = m.library;
    this._modeSizes(m.size);
    if (this.app.views && this.app.views.main && this.app.views.main.layout !== m.layout) this.app.views.main.setLayout(m.layout);
    if (save) { try { localStorage.setItem(MODE_KEY, name); } catch { /* the mode is just not remembered */ } }
    this.app.emit("libtab");
    this.app.emit("mode");
    this.app.emit("tool");
    return true;
  }

  // a mode that wants room (the FX Studio's editor): the right dock wider and its top half taller; the other modes go back to the sizes you set
  _modeSizes(size) {
    const rt = this.docks.get("right_top").el, right = this.right;
    if (size) {
      if (size.rtFrac) rt.style.flex = `0 0 ${Math.round(this.right.getBoundingClientRect().height * size.rtFrac)}px`;
      if (size.rightW) right.style.flex = `0 0 ${size.rightW}px`;
    } else {
      rt.style.flex = "";
      right.style.flex = "";
      this._restoreSizes();
    }
    this.app.views && this.app.views.resizeAll();
  }

  savedMode() { try { const m = localStorage.getItem(MODE_KEY); return MODES[m] ? m : "POSE"; } catch { return "POSE"; } }

  movePanel(title, dockName) {
    const p = this.panels.get(title);
    if (!p) return;
    if (p.win) { const w = p.win; p.win = null; w.__docking = true; w.close(); }
    p.home = dockName;
    p.hidden = false;
    this._place(title, dockName);
    this.saveLayout();
  }

  hidePanel(title) {
    const p = this.panels.get(title);
    if (!p) return;
    if (p.win) this.movePanel(title, p.home);
    p.hidden = true;
    p.el.classList.remove("active");
    const next = [...this.panels].find(([, q]) => q.dock === p.dock && !q.hidden && !q.win);
    if (next) this.activate(next[0]);
    this._renderTabs();
  }

  // a panel in its own OS window: the same live element, moved into the window's document
  floatPanel(title, rect = null) {
    const p = this.panels.get(title);
    if (!p || p.win) return;
    const w = this._openWindow("Fight Studio - " + title, rect || { w: 560, h: 640 });
    if (!w) return;
    p.win = w;
    p.el.classList.add("active");
    w.document.body.append(w.document.adoptNode(p.el));
    w.addEventListener("resize", () => p.el.__resize && p.el.__resize());
    w.addEventListener("beforeunload", () => {
      if (w.__docking) return;
      p.win = null;
      this._place(title, p.home);
    });
    setTimeout(() => p.el.__resize && p.el.__resize(), 50);
    this._renderTabs();
    const next = [...this.panels].find(([, q]) => q.dock === p.dock && !q.hidden && !q.win);
    if (next) this.activate(next[0]);
    this.saveLayout();
  }

  _openWindow(title, rect) {
    const w = window.open("", "_blank", `width=${rect.w},height=${rect.h}${rect.x !== undefined ? `,left=${rect.x},top=${rect.y}` : ""}`);
    if (!w) return null;
    w.document.title = title;
    const css = new URL("style.css", document.baseURI).href;
    w.document.head.innerHTML = `<meta charset="utf-8"><link rel="stylesheet" href="${css}">`;
    w.document.body.className = "popout";
    w.addEventListener("keydown", (e) => this.app.ui.key(e));
    this.windows.push(w);
    return w;
  }

  // a second canvas (a second monitor: the strip there, the quad here)
  newCanvasWindow(layout = "strip") {
    const w = this._openWindow("Fight Studio - canvas", { w: 1280, h: 720 });
    if (!w) return;
    const box = w.document.createElement("div");
    box.className = "canvas full";
    w.document.body.append(box);
    setTimeout(() => {
      const host = new ViewHost(this.app, box, layout, w);
      this.app.views.add(host);
      w.addEventListener("beforeunload", () => this.app.views.remove(host));
    }, 30);
  }

  tabMenu(title, x, y) {
    const items = [["Float \"" + title + "\" in its own window", () => this.floatPanel(title)], null];
    for (const d of this.docks.keys()) items.push(["Move to " + d.replace("_", " "), () => this.movePanel(title, d)]);
    items.push(null, ["Hide (Window menu brings it back)", () => this.hidePanel(title)]);
    this.contextMenu(x, y, items);
  }

  contextMenu(x, y, items) {
    const m = this.ctxMenu;
    m.innerHTML = "";
    for (const it of items) {
      if (!it) { m.append(h("div", { class: "sep" })); continue; }
      if (Array.isArray(it[1])) {
        const sub = h("div", { class: "sub" });
        for (const s of it[1]) sub.append(h("div", { class: "mi", onclick: () => { m.classList.add("hidden"); s[1](); } }, s[0]));
        m.append(h("div", { class: "mi has" }, it[0] + "  >", sub));
        continue;
      }
      m.append(h("div", { class: "mi", onclick: () => { m.classList.add("hidden"); it[1](); } }, it[0]));
    }
    m.classList.remove("hidden");
    m.style.left = Math.min(x, innerWidth - 300) + "px";
    m.style.top = Math.min(y, innerHeight - m.offsetHeight - 10) + "px";
  }

  // ---------------------------------------------------------------- splitters + saved layout
  _splitter(dir, target, key, invert = false) {
    const s = h("div", { class: "split " + dir });
    s.addEventListener("pointerdown", (e) => {
      s.setPointerCapture(e.pointerId);
      const start = dir === "h" ? e.clientX : e.clientY;
      const size0 = dir === "h" ? target.getBoundingClientRect().width : target.getBoundingClientRect().height;
      const move = (ev) => {
        const d = (dir === "h" ? ev.clientX : ev.clientY) - start;
        const v = Math.max(120, size0 + (invert ? -d : d));
        target.style.flex = `0 0 ${v}px`;
        this.app.views.resizeAll();
      };
      const up = () => { s.removeEventListener("pointermove", move); s.removeEventListener("pointerup", up); this._saveSize(key, target); };
      s.addEventListener("pointermove", move);
      s.addEventListener("pointerup", up);
    });
    s.__target = target;
    s.__key = key;
    return s;
  }

  _saveSize(key, target) {
    const d = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    (d.sizes ||= {})[key] = target.style.flex;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(d));
  }

  _restoreSizes() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}"); } catch {}
    for (const s of this.main.querySelectorAll(".split")) if (d.sizes && d.sizes[s.__key]) s.__target.style.flex = d.sizes[s.__key];
  }

  saveLayout() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}"); } catch {}
    d.panels = {};
    for (const [t, p] of this.panels) d.panels[t] = { home: p.home, float: !!p.win, hidden: p.hidden };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(d));
  }

  restoreLayout() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}"); } catch {}
    for (const t in d.panels || {}) {
      const p = this.panels.get(t), s = d.panels[t];
      if (!p) continue;
      if (s.home && s.home !== p.dock && this.docks.has(s.home)) this.movePanel(t, s.home);
      if (s.hidden) this.hidePanel(t);
    }
  }

  // ---------------------------------------------------------------- dialogs
  prompt(text, value, fn) {
    const m = this.modal;
    const input = h("input", { value });
    const ok = () => { m.classList.add("hidden"); fn(input.value.trim()); };
    input.onkeydown = (e) => { if (e.key === "Enter") ok(); if (e.key === "Escape") m.classList.add("hidden"); e.stopPropagation(); };
    m.innerHTML = "";
    m.append(h("div", { class: "box" }, h("div", { class: "txt" }, text), input, h("div", { class: "row end" }, button("CANCEL", () => m.classList.add("hidden")), button("OK", ok, "", "on"))));
    m.classList.remove("hidden");
    input.focus();
    input.select();
  }

  // File > Import motion: pick a Mixamo FBX (or a GLB / glTF), then the few choices that matter, then it opens as a new clip
  async importMotion() {
    const path = await window.host.pickMotion();
    if (!path) return;
    const m = this.modal;
    const file = path.split(/[\\/]/).pop();
    const name = h("input", { value: suggestName(path), style: "width:320px" });
    const opt = (text) => { const c = check(text, true, () => {}); return { el: c, on: () => c.querySelector("input").checked }; };
    const inPlace = opt("In place (take the travel out; the game moves the fighter)");
    const limits = opt("Keep every joint inside the rig limits (knees never bend forward)");
    const fingers = opt("Bring the fingers too");
    const go = async () => {
      m.classList.add("hidden");
      const app = this.app;
      if (app.history.dirty() && !(await window.host.confirm(`"${app.doc.name}" has changes that are not saved. Import anyway (changes are lost)?`))) return;
      app.say(`Importing ${file}...`);
      await app.importMotion(path, { name: name.value.trim(), in_place: inPlace.on(), limits: limits.on(), fingers: fingers.on() });
    };
    name.onkeydown = (e) => { if (e.key === "Enter") go(); if (e.key === "Escape") m.classList.add("hidden"); e.stopPropagation(); };
    m.innerHTML = "";
    m.append(h("div", { class: "box wide" }, h("div", { class: "heading" }, "Import " + file), h("div", { class: "row" }, h("span", { class: "lbl" }, "Clip name"), name),
      inPlace.el, limits.el, fingers.el,
      h("div", { class: "hint" }, "Mixamo: download \"Without Skin\" (with skin works too), any frame rate. The clip opens unsaved: look at it, then Save."),
      h("div", { class: "row end" }, button("CANCEL", () => m.classList.add("hidden")), button("IMPORT", go, "", "on"))));
    m.classList.remove("hidden");
    name.focus();
    name.select();
  }

  info(title, text) {
    const m = this.modal;
    m.innerHTML = "";
    m.append(h("div", { class: "box wide" }, h("div", { class: "heading" }, title), h("pre", {}, text), h("div", { class: "row end" }, button("OK", () => m.classList.add("hidden"), "", "on"))));
    m.classList.remove("hidden");
  }

  async picture(kind, w, h2, cols = 8, path = "") {
    const b64 = await renderPicture(this.app, this.app.views.main, kind, w, h2, cols);
    const p = await window.host.writePng(path || `${this.app.info.dirs.renders}/${this.app.fighter}_${this.app.doc.name}_${kind}_${w}x${h2}_${Date.now()}.png`, b64);
    this.app.say(p ? "Rendered " + p : "Render failed", p ? "ok" : "error");
    return p || "";
  }

  _closeMenus() { this.menubar.querySelectorAll(".drop").forEach((d) => d.classList.add("hidden")); this._menuOpen = false; }

  // ---------------------------------------------------------------- menus
  buildMenus(menus) {
    const brand = h("div", { class: "brand" }, h("span", { class: "b1" }, "RMT ANIMATION"), h("span", { class: "b2" }, "STUDIO"));
    this.menubar.append(brand);
    for (const [title, items] of menus) {
      const drop = h("div", { class: "drop hidden" });
      const fill = () => {
        drop.innerHTML = "";
        for (const it of typeof items === "function" ? items() : items) {
          if (!it) { drop.append(h("div", { class: "sep" })); continue; }
          const [text, fn, keys] = it;
          if (Array.isArray(fn)) {
            const sub = h("div", { class: "sub" });
            for (const s of fn) sub.append(h("div", { class: "mi", onclick: (e) => { e.stopPropagation(); this._closeMenus(); s[1](); } }, s[0]));
            drop.append(h("div", { class: "mi has" }, h("span", {}, text), h("span", { class: "k" }, ">"), sub));
          } else drop.append(h("div", { class: "mi", onclick: () => { this._closeMenus(); fn(); } }, h("span", {}, text), h("span", { class: "k" }, keys || "")));
        }
      };
      const m = h("div", { class: "menu" }, h("span", { class: "mt" }, title), drop);
      m.querySelector(".mt").onclick = () => { const open = drop.classList.contains("hidden"); this._closeMenus(); if (open) { fill(); drop.classList.remove("hidden"); this._menuOpen = true; } };
      m.onmouseenter = () => { if (this._menuOpen && drop.classList.contains("hidden")) { this._closeMenus(); fill(); drop.classList.remove("hidden"); this._menuOpen = true; } };
      this.menubar.append(m);
    }
    this.menubar.append(h("i", { class: "grow" }));
    this.modebar = h("div", { class: "modebar" });
    for (const name of Object.keys(MODES)) this.modebar.append(h("button", { class: "mode", "data-mode": name, title: MODES[name].tip, onclick: () => this.setMode(name) }, name));
    this.menubar.append(this.modebar);
    this.app.on((w) => { if (w === "mode") for (const b of this.modebar.children) b.classList.toggle("on", b.dataset.mode === this.mode); });
  }

  // ---------------------------------------------------------------- tool bar, transport, status
  buildToolbar() {
    const app = this.app, tb = this.toolbar;
    const fsel = select(app.fighters, app.fighter, (v) => app.setFighter(v), "The body you animate on (every fighter shares the rig)");
    const tier = button("BONES SIMPLE", () => app.setBoneTier(app.boneTier === "simple" ? "advanced" : "simple"),
      "Rig v5 bone tier: SIMPLE = body/limbs/tail/ears, ADVANCED = clavicles, Spine1, toes and full fingers");
    const chip = h("span", { class: "chip" });
    const tools = {};
    for (const [t, id, tip] of [["SELECT", "select", "Q: pick joints only"], ["ROTATE", "rotate", "E: drag a joint to swing it, drag a ring to turn about one axis"], ["MOVE", "move", "W: slide the whole body; arrows move along one axis"], ["IK", "ik", "T: pull a hand / foot and the limb bends; any other joint bends its parents"]])
      tools[id] = button(t, () => app.setTool(id), tip);
    const space = button("LOCAL", () => { app.spaceGlobal = !app.spaceGlobal; app.views.dirty(); app.emit("tool"); }, "X: rings in the bone's own axes or the world's");
    const mir = button("X-MIRROR", () => { app.mirrorEdit = !app.mirrorEdit; app.emit("tool"); }, "M: edits on one side mirror to the other");
    const ak = button("AUTO KEY", () => { app.autokey = !app.autokey; app.emit("tool"); }, "N: every edit is keyed at once");
    const prop = select([["off", "SAME KEY off"], ["linked", "SAME KEY linked"], ["pose", "SAME KEY pose"], ["bone", "SAME KEY value"]], app.propagate, (v) => { app.propagate = v; app.say("Same-key updates: " + v); }, "When you update a key, the same key elsewhere takes the same change");
    const onion = button("ONION", () => { app.onion.on = !app.onion.on; app.applyNow(); app.emit("tool"); }, "O: ghosts of the frames before (blue) and after (orange)");
    const wrap = button("WRAP", () => { app.show.wrap = !app.show.wrap; app.applyNow(); app.views.stripDirty(); app.emit("tool"); },
      "Collision Wrap: show the pose after the match's Body Solve (parts pushed out of the body and the floor, as in the game)");
    const trail = button("TRAIL", () => { app.show.trail = !app.show.trail; app.views.dirty(); app.emit("tool"); }, "The path the selected joint travels");
    const lays = {};
    for (const [t, l] of [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["STRIP", "strip"], ["4+S", "4+strip"]]) lays[l] = button(t, () => { app.views.main.setLayout(l); app.emit("tool"); }, "Canvas layout (keys 1-6)");
    const undo = button("UNDO", () => app.undo(), "Ctrl+Z"), redo = button("REDO", () => app.redo(), "Ctrl+Shift+Z");
    const save = button("SAVE", () => app.save(), "Ctrl+S: writes data/clips/<name>.json, where the game reads it", "gold");
    tb.append(fsel, tier, chip, h("i", { class: "vs" }), ...Object.values(tools), space, h("i", { class: "vs" }), mir, ak, prop, h("i", { class: "vs" }), onion, trail, wrap, h("i", { class: "vs" }), ...Object.values(lays), h("i", { class: "grow" }), undo, redo, save);
    const refresh = () => {
      chip.textContent = `${app.doc.name}  [${app.isNew ? "NEW" : app.doc.needsBake() ? "BAKED LAYERS" : "CLIP"}]${app.history.dirty() ? "  *" : ""}`;
      chip.classList.toggle("dirty", app.history.dirty());
      tier.textContent = "BONES " + app.boneTier.toUpperCase();
      tier.classList.toggle("on", app.boneTier === "advanced");
      if (app.v5) tier.title = `${app.v5.style}: simple ${app.v5.counts.simple} / advanced ${app.v5.counts.advanced} bones. Click to toggle.`;
      for (const id in tools) tools[id].classList.toggle("on", app.tool === id);
      space.textContent = app.spaceGlobal ? "GLOBAL" : "LOCAL";
      mir.classList.toggle("on", app.mirrorEdit);
      ak.classList.toggle("rec", app.autokey);
      onion.classList.toggle("on", app.onion.on);
      trail.classList.toggle("on", app.show.trail);
      wrap.classList.toggle("on", app.show.wrap);
      prop.value = app.propagate;
      for (const l in lays) lays[l].classList.toggle("on", app.views.main && app.views.main.layout === l);
      if (fsel.value !== app.fighter) fsel.value = app.fighter;
      undo.disabled = !app.history.canUndo();
      redo.disabled = !app.history.canRedo();
    };
    app.on((w) => { if (w !== "frame") refresh(); });
    refresh();

    const tr = this.transport;
    const play = button("PLAY", () => app.togglePlay(), "Space");
    const fr = num(0, (v) => app.setFrame(v), { min: 0, width: 66, title: "Current frame" });
    const len = num(app.doc.frames, (v) => v !== app.doc.frames && app.setClipProp("frames", v | 0), { min: 1, width: 66, title: "Clip length in frames" });
    const fps = select(["24", "30", "60"], String(app.doc.fps), (v) => app.setClipProp("fps", Number(v)), "Frames per second");
    const loop = button("LOOP", () => app.setClipProp("loop", !app.doc.loop), "The clip loops in the game");
    const spd = select(["0.25", "0.5", "1", "2"], "1", (v) => (app.speed = Number(v)), "Playback speed");
    const layer = h("span", { class: "tag ok" });
    const info = h("span", { class: "tag muted clip" });
    const ease = select(EASES, "linear", (v) => app.setKeysField([Math.round(app.frame)], "ease", v), "How this key eases into the next one");
    const del = button("DEL KEY", () => app.deleteKeys([Math.round(app.frame)]), "Alt+K");
    const key = button("SET KEY", () => app.keyNow(), "K: store this pose as a key", "key");
    tr.append(button("|<", () => app.setFrame(0), "Home"), button("<K", () => app.gotoKey(-1), "Down: previous key"), button("<", () => app.step(-1), ", or Left"), play,
      button(">", () => app.step(1), ". or Right"), button("K>", () => app.gotoKey(1), "Up: next key"), button(">|", () => app.setFrame(app.doc.frames), "End"), fr, h("span", { class: "tag muted" }, "/"), len, fps, loop, spd,
      button("IN", () => { app.playRange[0] = Math.round(app.frame); app.emit("doc"); }, "Play range starts here"), button("OUT", () => { app.playRange[1] = Math.round(app.frame); app.emit("doc"); }, "Play range ends here"),
      button("ALL", () => { app.playRange = [0, -1]; app.emit("doc"); }, "Play the whole clip"), h("i", { class: "vs" }), layer, h("i", { class: "grow" }), info, ease, del, key);
    const tref = () => {
      play.textContent = app.playing ? "PAUSE" : "PLAY";
      if (document.activeElement !== fr) fr.value = Math.round(app.frame);
      if (document.activeElement !== len) len.value = app.doc.frames;
      fps.value = String(app.doc.fps);
      loop.classList.toggle("on", app.doc.loop);
      const f = Math.round(app.frame), k = app.doc.keyAt(f);
      ease.style.display = del.style.display = k ? "" : "none";
      if (k) ease.value = k.ease || app.doc.ease;
      key.textContent = (k ? "UPDATE KEY" : "SET KEY") + (app.pending ? " *" : "");
      key.classList.toggle("pend", !!app.pending);
      key.classList.toggle("onkey", !!k && !app.pending);
      const flags = [];
      if (k?.link) flags.push(`linked ${k.link} with f${app.doc.partners(f, app.bones, false).join(", f")}`);
      if (k?.lock) flags.push("LOCKED");
      if (k?.tag) flags.push(k.tag);
      info.textContent = flags.length ? `f${f}: ${flags.join(", ")}` : "";
      const l = app.doc.layerById(app.activeLayer);
      layer.textContent = "KEYS > " + (l ? "LAYER " + l.name.toUpperCase() : "BASE");
    };
    app.on(tref);
    tref();

    const msg = h("span", { class: "msg" }), sel = h("span", { class: "muted" }), api = h("span", { class: "api" });
    this.status.append(msg, sel, api);
    const sref = () => {
      msg.textContent = app.status;
      msg.style.color = { warn: "#ff7a1a", error: "#ff4d4d", ok: "#5ce08a", agent: "#a77bff" }[app.statusKind] || "#f4efe6";
      sel.textContent = `   ${app.selBones.length < 2 ? app.selBone : app.selBones.length + " bones"}  |  ${app.tool.toUpperCase()}  |  ${app.doc.keys.length} keys  |  f ${Math.round(app.frame)} / ${app.doc.frames}   `;
      api.textContent = `AGENT API :${app.info?.apiPort || 47680}  (${app.apiLog.length} calls)`;
    };
    app.on(sref);
    sref();
  }
}

// a set of ViewHosts (the main canvas + any canvas windows) that redraw together
export class Views {
  constructor() { this.hosts = []; this.main = null; }
  add(h2) { this.hosts.push(h2); if (!this.main) this.main = h2; }
  remove(h2) { this.hosts = this.hosts.filter((x) => x !== h2); }
  dirty() { this.hosts.forEach((x) => x.dirty()); }
  stripDirty() { this.hosts.forEach((x) => x.stripDirty()); }
  frameAll() { this.hosts.forEach((x) => x.frameAll()); }
  resizeAll() { this.hosts.forEach((x) => x.resize()); }
  render(force) { this.hosts.forEach((x) => x.render(force)); }
}

export { LAYOUTS, R };
