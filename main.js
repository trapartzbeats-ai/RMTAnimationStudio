// RMT Animation Studio (from Fight Studio Desktop) - main process.
// Opens the app window (HD, maximized), gives the page safe file access to the game's clip folders, lets panels pop out into
// their own windows, and serves the agent API on http://127.0.0.1:47680 (the same methods as the Godot Animator on :47650,
// so one MCP server, game/packs/city_breaker/animator/mcp/fight_studio_mcp.py, drives either app).
const { app, BrowserWindow, ipcMain, shell, screen, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

const ARGS = process.argv.slice(1);
const arg = (name, dflt) => {
  const a = ARGS.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const flag = (name) => ARGS.includes(`--${name}`);

// settings kept between runs (the game project folder you picked), in the app's own user folder
const SETTINGS = path.join(app.getPath("userData"), "settings.json");
const settings = (() => { try { return JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch { return {}; } })();
const saveSettings = () => { fs.mkdirSync(path.dirname(SETTINGS), { recursive: true }); fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); };
// the game project: --project=, FIGHT_STUDIO_PROJECT, the folder picked last time, or the author's; asked for on first run when
// none of those is a project with the City Breaker pack in it
const isProject = (p) => !!p && fs.existsSync(path.join(p, "game/packs/city_breaker/data/clips"));
let PROJECT = [arg("project", ""), process.env.FIGHT_STUDIO_PROJECT, settings.project, "D:/Games/BSP-Universe"].find(isProject) || "";
// trash, backups and renders: D:/Cache on the author's machine, Documents/Fight Studio anywhere else
const WORK = fs.existsSync("D:/Cache") ? "D:/Cache" : path.join(app.getPath("documents"), "Fight Studio");
const DIRS = {};
function setProject(p) {
  PROJECT = p;
  const pack = path.join(p, "game/packs/city_breaker");
  Object.assign(DIRS, { clips: path.join(pack, "data/clips"), poses: path.join(pack, "data/poses"), chars: path.join(pack, "assets/chars"), data: path.join(pack, "data"),
    trash: path.join(WORK, "fight_studio_trash"), backups: path.join(WORK, "fight_studio_backups"), renders: path.join(WORK, "fight_studio_renders"),
    mcp: path.join(pack, "animator/mcp/fight_studio_mcp.py") });
}
setProject(PROJECT || ".");

// the Godot editor build the game is made with: FIGHT_STUDIO_GODOT, the path in the settings, or the author's
const godotExe = () => [process.env.FIGHT_STUDIO_GODOT, settings.godot, "D:/Downloads/Godot_v4.7-stable_win64.exe/Godot_v4.7-stable_win64.exe"].find((p) => p && fs.existsSync(p)) || "";
let bakeBusy = "";
// a child process to its end: what it printed (the end of it), rejected on a non-zero exit or after ms
function runProcess(exe, args, ms) {
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(exe, args, { windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)); }, ms);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out.slice(-400)}`)); });
  });
}

// ask for the game project folder until it is one (or the dialog is cancelled: "")
async function pickProject(parent) {
  for (;;) {
    const r = await dialog.showOpenDialog(parent, { title: "Fight Studio: pick the game project folder (the one with game/packs/city_breaker in it)",
      properties: ["openDirectory"] });
    if (r.canceled || !r.filePaths.length) return "";
    if (isProject(r.filePaths[0])) return r.filePaths[0];
    await dialog.showMessageBox(parent, { type: "warning", title: "Fight Studio",
      message: "That folder has no game/packs/city_breaker/data/clips in it. Pick the Godot project folder (the one with project.godot)." });
  }
}
const API_PORT = Number(arg("api-port", 47680));
const ANIMATO_PY = "D:/Projects/Animato/.venv/Scripts/python.exe";
const ANIMATO_BAKE = "D:/Projects/Animato/bake_studio_clips.py";

let win = null;
// the log: out/desktop.log next to the code when run from source, the user folder when installed (the code is read-only there)
const LOG = app.isPackaged ? path.join(app.getPath("userData"), "desktop.log") : path.join(__dirname, "out", "desktop.log");
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, "");
// Electron is a GUI app on Windows: its console often goes nowhere, so the log also goes to out/desktop.log
function log(...a) {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  try { fs.appendFileSync(LOG, line + "\n"); } catch {}
  console.log(line);
}
let apiServer = null;
let lastImportDir = "";
const pending = new Map();
let rpcSeq = 1;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function safeName(n) {
  return typeof n === "string" && /^[A-Za-z0-9_\-]+$/.test(n);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

// REAL MOTION for Fill's library: the Motion Library's clips (Mixamo motion capture converted onto rig v4), named real/<clip>.
// The folder: the one set in the app (settings), else FIGHT_STUDIO_MOTION_LIBRARY, else the library's own place on the author's
// machine if it is there (the Godot Animator: core/fill.gd real_folder, the same order without the setting)
const REAL_DEFAULT = "D:/Projects/MotionLibrary/clips";
function realFolder() {
  if (typeof settings.motion_library === "string") return settings.motion_library;
  if (process.env.FIGHT_STUDIO_MOTION_LIBRARY) return process.env.FIGHT_STUDIO_MOTION_LIBRARY;
  return fs.existsSync(REAL_DEFAULT) ? REAL_DEFAULT : "";
}
// the real-motion clip files: {"real/<name>": path}, one folder down (the library keeps clips/<category>/mx_*.json)
function realFiles() {
  const root = realFolder();
  const out = {};
  if (!root || !fs.existsSync(root)) return out;
  const dirs = [root, ...fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name))];
  for (const d of dirs) for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".json"))) out["real/" + f.slice(0, -5)] = path.join(d, f);
  return out;
}

// ------------------------------------------------------------------ file access for the page (only these folders)
const backedUp = new Set();
const clipIndexCache = new Map();
// where the Godot Effect Studio keeps its overrides (user://rmt_effects)
function fxUserDir() {
  const name = ((fs.existsSync(path.join(PROJECT, "project.godot")) ? fs.readFileSync(path.join(PROJECT, "project.godot"), "utf8") : "").match(/config\/name="([^"]*)"/) || [])[1];
  return name && process.env.APPDATA ? path.join(process.env.APPDATA, "Godot", "app_userdata", name, "rmt_effects") : "";
}
const handlers = {
  info: () => ({ project: PROJECT, dirs: DIRS, args: ARGS, apiPort: API_PORT, version: app.getVersion() }),
  listClips: () => (fs.existsSync(DIRS.clips) ? fs.readdirSync(DIRS.clips).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : []),
  // the Library's clip index: name -> {frames, fps, loop, keys, note}; re-read only the clips whose file time changed
  clipIndex: () => {
    if (!fs.existsSync(DIRS.clips)) return {};
    const out = {};
    for (const f of fs.readdirSync(DIRS.clips).filter((x) => x.endsWith(".json"))) {
      const p = path.join(DIRS.clips, f);
      const m = fs.statSync(p).mtimeMs;
      const name = f.slice(0, -5);
      let e = clipIndexCache.get(name);
      if (!e || e.m !== m) {
        const d = readJson(p) || {};
        e = { m, frames: Number(d.frames || 0), fps: Number(d.fps || 30), loop: !!d.loop, keys: Array.isArray(d.keys) ? d.keys.length : 0, note: String(d.note || "").slice(0, 160) };
        clipIndexCache.set(name, e);
      }
      out[name] = e;
    }
    return out;
  },
  loadClip: (name) => (safeName(name) ? readJson(path.join(DIRS.clips, name + ".json")) : null),
  // every clip for Fill's library (core/fill.js): a signature of the names + file times, and the clips when it changed
  clipLibrary: (have) => {
    if (!fs.existsSync(DIRS.clips)) return { sig: "", clips: {} };
    const files = fs.readdirSync(DIRS.clips).filter((f) => f.endsWith(".json")).sort();
    const reals = realFiles();
    const stamp = files.map((f) => f + ":" + fs.statSync(path.join(DIRS.clips, f)).mtimeMs).join(",") + "|" +
      Object.keys(reals).map((n) => n + ":" + fs.statSync(reals[n]).mtimeMs).join(",");
    const sig = crypto.createHash("md5").update(stamp).digest("hex");
    if (have && have === sig) return { sig };
    const clips = {};
    for (const f of files) {
      const c = readJson(path.join(DIRS.clips, f));
      if (c) clips[f.slice(0, -5)] = c;
    }
    for (const n of Object.keys(reals)) {
      const c = readJson(reals[n]);
      if (c) clips[n] = c;
    }
    return { sig, clips };
  },
  // the real-motion folder (see REAL_DEFAULT): a string sets it ("" = off) and is kept in the settings; returns the folder
  realFolder: (folder) => {
    if (typeof folder === "string") { settings.motion_library = folder; saveSettings(); }
    return realFolder();
  },
  clipExists: (name) => safeName(name) && fs.existsSync(path.join(DIRS.clips, name + ".json")),
  saveClip: (clip) => {
    if (!clip || !safeName(clip.name)) return { ok: false, error: "bad clip name" };
    const p = path.join(DIRS.clips, clip.name + ".json");
    if (fs.existsSync(p) && !backedUp.has(clip.name)) {
      fs.mkdirSync(DIRS.backups, { recursive: true });
      fs.copyFileSync(p, path.join(DIRS.backups, `${clip.name}_${stamp()}.json`));
      backedUp.add(clip.name);
    }
    writeJson(p, clip);
    return { ok: true, path: p };
  },
  trashClip: (name) => {
    if (!safeName(name)) return false;
    const p = path.join(DIRS.clips, name + ".json");
    if (!fs.existsSync(p)) return false;
    fs.mkdirSync(DIRS.trash, { recursive: true });
    fs.copyFileSync(p, path.join(DIRS.trash, `${name}_${stamp()}.json`));
    fs.unlinkSync(p);
    return true;
  },
  listPoses: () => (fs.existsSync(DIRS.poses) ? fs.readdirSync(DIRS.poses).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : []),
  loadPose: (name) => (safeName(name) ? readJson(path.join(DIRS.poses, name + ".json")) : null),
  savePose: (pose) => {
    if (!pose || !safeName(pose.name)) return false;
    writeJson(path.join(DIRS.poses, pose.name + ".json"), pose);
    return true;
  },
  loadData: (file) => (/^[a-z0-9_]+\.json$/.test(file) ? readJson(path.join(DIRS.data, file)) : null),
  // a fighter's Collision Wrap (data/wraps/<key>.collide.json), the wrap rules and its match height (moves/<key>.json height_m)
  wrapData: (key) => {
    if (!safeName(key)) return null;
    const moves = readJson(path.join(DIRS.data, "moves", key + ".json")) || {};
    return { wrap: readJson(path.join(DIRS.data, "wraps", key + ".collide.json")), rules: readJson(path.join(DIRS.data, "wraps", "wrap_rules.json")) || {},
      height_m: Number(moves.height_m ?? 2.0) };
  },
  saveData: (file, obj) => {
    if (!/^(animator_rig|sockets|clip_fx)\.json$/.test(file)) return false;
    writeJson(path.join(DIRS.data, file), obj);
    return true;
  },
  // the RMT effect library (addons/rmt_effects/assets/<id>/<id>.json) as the game sees it: the Godot Effect Studio's user
  // overrides (its user:// folder) win over the shipped blocks, like Library.scan; dir = the block's folder as a file URL
  fxLibrary: () => {
    const root = path.join(PROJECT, "addons/rmt_effects/assets");
    const out = new Map();
    if (fs.existsSync(root)) {
      for (const d of fs.readdirSync(root)) {
        const m = readJson(path.join(root, d, d + ".json"));
        if (m && m.format === "RMT_EFFECT_BLOCKS" && Array.isArray(m.layers)) out.set(String(m.id || d), { id: String(m.id || d), category: String(m.category || "other"), manifest: m, dir: pathToFileURL(path.join(root, d)).href + "/" });
      }
    }
    const userDir = fxUserDir();
    if (userDir && fs.existsSync(userDir)) {
      for (const f of fs.readdirSync(userDir).filter((x) => x.endsWith(".json"))) {
        const m = readJson(path.join(userDir, f));
        const id = f.slice(0, -5);
        if (m && Array.isArray(m.layers) && out.has(id)) out.set(id, { ...out.get(id), manifest: m, override: true });
      }
    }
    return { blocks: [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), resRoot: pathToFileURL(PROJECT).href + "/" };
  },
  // the Effect Studio's lists: every shader of the add-on, every texture of the kit (name + file url)
  fxShaders: () => {
    const d = path.join(PROJECT, "addons/rmt_effects/shaders");
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".gdshader")).map((f) => f.slice(0, -9)).sort() : [];
  },
  fxTextures: () => {
    const d = path.join(PROJECT, "addons/rmt_effects/textures");
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".png")).map((f) => ({ name: f.slice(0, -4), url: pathToFileURL(path.join(d, f)).href })).sort((a, b) => (a.name < b.name ? -1 : 1)) : [];
  },
  // an edited block is saved as the Godot Effect Studio saves it: a user override next to the shipped one (never over it)
  fxSaveOverride: (id, manifest) => {
    const dir = fxUserDir();
    if (!dir || !safeName(id) || !manifest || manifest.format !== "RMT_EFFECT_BLOCKS" || !Array.isArray(manifest.layers) || String(manifest.id) !== String(id)) return false;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(manifest, null, 2));
    return true;
  },
  fxRevertOverride: (id) => {
    const dir = fxUserDir();
    const p = dir && safeName(id) ? path.join(dir, id + ".json") : "";
    if (!p || !fs.existsSync(p)) return false;
    fs.mkdirSync(DIRS.trash, { recursive: true });
    // to the trash folder, like clips: never deleted. The Godot user dir (C:) and the trash (D:) are often different drives,
    // where a rename fails (EXDEV), so copy first and only then remove the override
    fs.copyFileSync(p, path.join(DIRS.trash, `fx_${id}_${stamp()}.json`));
    fs.unlinkSync(p);
    return true;
  },
  fxShader: (name) => {
    if (!safeName(name)) return "";
    const p = path.join(PROJECT, "addons/rmt_effects/shaders", name + ".gdshader");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  },
  // the RMT Effect Studio (Godot) on this fighter, clip and time, for making or changing a block
  openEffectStudio: (fighter, clip, t, effect) => {
    const exe = process.env.FIGHT_STUDIO_GODOT || settings.godot || "D:/Downloads/Godot_v4.7-stable_win64.exe/Godot_v4.7-stable_win64.exe";
    if (!fs.existsSync(exe) || !safeName(fighter) || !safeName(clip) || (effect && !safeName(effect))) return false;
    const args = ["--path", PROJECT, "res://addons/rmt_effects/studio/studio.tscn", "--", `--unit=${fighter}`, `--clip=${clip}`, `--t=${Number(t) || 0}`];
    if (effect) args.push(`--effect=${effect}`);
    const child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  },
  fighters: () => (fs.existsSync(DIRS.chars) ? fs.readdirSync(DIRS.chars).filter((f) => f.endsWith("_fight.glb")).map((f) => f.slice(0, -10)).sort() : []),
  modelUrl: (key) => {
    if (!safeName(key)) return null;
    const p = path.join(DIRS.chars, key + "_fight.glb");
    return fs.existsSync(p) ? pathToFileURL(p).href : null;
  },
  writePng: (file, base64) => {
    const p = file && file.length ? file : path.join(DIRS.renders, `desktop_${stamp()}.png`);
    if (!/\.png$/i.test(p)) return null;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(base64, "base64"));
    return p;
  },
  // motion to import (Mixamo FBX, GLB, glTF): the file you pick, or the path an agent names; only those file types, read-only
  pickMotion: async () => {
    const r = await dialog.showOpenDialog(win, { title: "Import motion (Mixamo FBX, GLB, glTF)", defaultPath: lastImportDir || app.getPath("downloads"),
      properties: ["openFile"], filters: [{ name: "Mixamo / FBX", extensions: ["fbx"] }, { name: "glTF", extensions: ["glb", "gltf"] }] });
    if (r.canceled || !r.filePaths.length) return "";
    lastImportDir = path.dirname(r.filePaths[0]);
    return r.filePaths[0];
  },
  motionUrl: (file) => (typeof file === "string" && /\.(fbx|glb|gltf)$/i.test(file) && fs.existsSync(file) ? pathToFileURL(path.resolve(file)).href : null),
  openPath: (p) => shell.openPath(p),
  captureWindow: async (file) => {
    if (!win) return null;
    const img = await win.webContents.capturePage();
    const p = file && /\.png$/i.test(file) ? file : path.join(DIRS.renders, `desktop_window_${stamp()}.png`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, img.toPNG());
    return p;
  },
  bakeAnimato: (fighter) => {
    if (!safeName(fighter) || !fs.existsSync(ANIMATO_PY) || !fs.existsSync(ANIMATO_BAKE)) return { ok: false, error: "Animato not found" };
    const child = spawn(ANIMATO_PY, [ANIMATO_BAKE, fighter], { cwd: path.dirname(ANIMATO_BAKE), detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, pid: child.pid };
  },
  openGodotAnimator: (fighter, clip) => {
    const exe = process.env.FIGHT_STUDIO_GODOT || settings.godot || "D:/Downloads/Godot_v4.7-stable_win64.exe/Godot_v4.7-stable_win64.exe";
    if (!fs.existsSync(exe)) return false;
    const child = spawn(exe, ["--path", PROJECT, "res://game/packs/city_breaker/animator/animator.tscn", "--", `--fighter=${fighter}`, `--clip=${clip}`], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  },
  confirm: async (text) => {
    const r = await dialog.showMessageBox(win, { type: "question", buttons: ["Yes", "Cancel"], defaultId: 0, cancelId: 1, message: text, title: "Fight Studio" });
    return r.response === 0;
  },
  // what the Setup mode needs to know about a fighter's files: when its model, Collision Wrap and baked soles were written
  setupInfo: (fighter) => {
    if (!safeName(fighter)) return null;
    const at = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
    return { godot: !!godotExe(), model: at(path.join(DIRS.chars, fighter + "_fight.glb")), wrap: at(path.join(DIRS.data, "wraps", fighter + ".collide.json")),
      soles: at(path.join(DIRS.data, "feet_soles.json")), baking: bakeBusy };
  },
  // the game's own bake tools, run headless in Godot: wrap = one fighter's Collision Wrap (data/wraps/<key>.collide.json),
  // soles = every fighter's baked soles (data/feet_soles.json). dry: only say what would run.
  bake: async (kind, fighter, dry) => {
    const tool = { wrap: "wrap_bake.gd", soles: "feet_bake.gd" }[kind];
    if (!tool) return { ok: false, error: "unknown bake " + kind };
    if (kind === "wrap" && !safeName(fighter)) return { ok: false, error: "bad fighter name" };
    const exe = godotExe();
    if (!exe) return { ok: false, error: "Godot was not found (set FIGHT_STUDIO_GODOT)" };
    if (!fs.existsSync(path.join(PROJECT, "game/packs/city_breaker/tools", tool))) return { ok: false, error: `${tool} is not in this project's tools folder` };
    const args = ["--headless", "--path", PROJECT, "--script", "res://game/packs/city_breaker/tools/" + tool, ...(kind === "wrap" ? ["--", "--who=" + fighter] : [])];
    if (dry) return { ok: true, dry: true, exe, args };
    if (bakeBusy) return { ok: false, error: `already baking ${bakeBusy}` };
    const out = kind === "wrap" ? path.join(DIRS.data, "wraps", fighter + ".collide.json") : path.join(DIRS.data, "feet_soles.json");
    const before = (() => { try { return fs.statSync(out).mtimeMs; } catch { return 0; } })();
    bakeBusy = kind === "wrap" ? "the wrap of " + fighter : "the soles";
    try {
      const log = await runProcess(exe, args, 300000);
      const after = (() => { try { return fs.statSync(out).mtimeMs; } catch { return 0; } })();
      return { ok: after > before, file: out, log: log.slice(-1200), error: after > before ? "" : "Godot ran but wrote nothing" };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      bakeBusy = "";
    }
  },
  setTitle: (t) => win && win.setTitle(t),
  // another game project folder: remembered, then the app starts again on it
  changeProject: async () => {
    const p = await pickProject(win);
    if (!p) return false;
    settings.project = p;
    saveSettings();
    app.relaunch({ args: process.argv.slice(1).filter((a) => !a.startsWith("--project=")) });
    app.exit(0);
    return true;
  },
  quit: (code) => {
    app.exit(code || 0);
  },
  log: (...a) => log(...a),
};

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle("fs:" + name, (_e, ...a) => fn(...a));
}

// ------------------------------------------------------------------ agent API
ipcMain.on("rpc:result", (_e, id, out) => {
  const p = pending.get(id);
  if (p) {
    pending.delete(id);
    p(out);
  }
});

function callPage(method, params) {
  return new Promise((resolve) => {
    if (!win) return resolve({ ok: false, error: "no window" });
    const id = rpcSeq++;
    pending.set(id, resolve);
    win.webContents.send("rpc:call", id, method, params || {});
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, error: "timed out" });
      }
    }, 180000);
  });
}

function startApi() {
  apiServer = http.createServer((req, res) => {
    const send = (obj) => {
      const body = Buffer.from(JSON.stringify(obj));
      res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
      res.end(body);
    };
    const url = (req.url || "").split("?")[0];
    if (req.method === "GET" && url === "/health") {
      callPage("__health", {}).then((h) => send({ ok: true, app: "fight-studio-desktop", version: app.getVersion(), ...(h.result || {}) }));
      return;
    }
    if (req.method === "GET" && url === "/methods") {
      callPage("__methods", {}).then(send);
      return;
    }
    if (req.method === "POST" && url === "/rpc") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          return send({ ok: false, error: 'body must be JSON: {"method": ..., "params": {...}}' });
        }
        callPage(String(msg.method || ""), msg.params || {}).then(send);
      });
      return;
    }
    send({ ok: false, error: "use POST /rpc, GET /methods or GET /health" });
  });
  apiServer.on("error", (e) => log("agent API could not start:", e.message));
  apiServer.listen(API_PORT, "127.0.0.1");
}

// ------------------------------------------------------------------ windows
function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const hidden = flag("hidden");
  win = new BrowserWindow({
    width: Math.min(1920, Math.round(area.width * 0.96)),
    height: Math.min(1080, Math.round(area.height * 0.94)),
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: "#0d0b0f",
    title: "RMT Animation Studio",
    autoHideMenuBar: true,
    focusable: !flag("unfocusable"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  // panels and canvases pop out into real windows (same page, so they stay live)
  win.webContents.setWindowOpenHandler(({ features }) => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      backgroundColor: "#16131a",
      autoHideMenuBar: true,
      title: "Fight Studio",
      focusable: !flag("unfocusable"),
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    },
  }));
  win.webContents.on("console-message", (_e, level, message, line, source) => {
    if (level >= 2 || flag("verbose")) log(`[page ${level >= 3 ? "error" : "warn"}] ${message} (${path.basename(String(source))}:${line})`);
  });
  win.webContents.on("render-process-gone", (_e, d) => log("renderer gone:", d.reason));
  win.loadFile(path.join(__dirname, "src/index.html"));
  win.once("ready-to-show", () => {
    if (hidden) return;
    if (area.width >= 1600 && !flag("windowed")) win.maximize();
    win.show();
  });
  win.on("close", async (e) => {
    if (win.__closing) return;
    e.preventDefault();
    const r = await callPage("__can_close", {});
    if (r && r.result === true) {
      win.__closing = true;
      win.close();
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  if (!PROJECT) {
    const p = await pickProject(null);
    if (!p) {
      await dialog.showMessageBox({ type: "info", title: "Fight Studio",
        message: "Fight Studio needs the game project folder (the Godot project with game/packs/city_breaker in it). Start it again to pick one." });
      return app.exit(0);
    }
    settings.project = p;
    saveSettings();
    setProject(p);
  }
  createWindow();
  if (!flag("no-api")) startApi();
});

app.on("window-all-closed", () => app.quit());
