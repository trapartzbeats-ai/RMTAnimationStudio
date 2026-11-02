// The page's only door to the computer: the game's clip / pose / data folders, models, renders, and the agent API bridge.
const { contextBridge, ipcRenderer } = require("electron");

const names = ["info", "listClips", "clipIndex", "loadClip", "clipLibrary", "realFolder", "clipExists", "saveClip", "trashClip", "listPoses", "loadPose", "savePose", "loadData", "wrapData",
  "saveData", "fighters", "modelUrl", "pickMotion", "motionUrl", "writePng", "openPath", "captureWindow", "bakeAnimato", "openGodotAnimator", "fxLibrary", "fxShaders", "fxTextures", "fxSaveOverride", "fxRevertOverride", "fxShader", "openEffectStudio", "confirm", "setupInfo", "bake", "setTitle", "changeProject", "quit", "log"];
const host = {};
for (const n of names) host[n] = (...a) => ipcRenderer.invoke("fs:" + n, ...a);

host.onRpc = (fn) => {
  ipcRenderer.on("rpc:call", async (_e, id, method, params) => {
    let out;
    try {
      out = await fn(method, params);
    } catch (err) {
      out = { ok: false, error: String((err && err.message) || err) };
    }
    ipcRenderer.send("rpc:result", id, out);
  });
};

contextBridge.exposeInMainWorld("host", host);
