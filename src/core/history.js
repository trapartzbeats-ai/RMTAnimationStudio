// Undo / redo by snapshots of the whole document; a run of the same edit (a slider dragged with auto key) is one step.
export class History {
  constructor() { this.undoStack = []; this.redoStack = []; this.savedAt = 0; }

  commit(label, before, after, who = "you") {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && !this.redoStack.length && last.label === label && last.who === who && performance.now() - last.time < 900 && this.savedAt !== this.undoStack.length) {
      last.after = after;
      last.time = performance.now();
      return;
    }
    this.undoStack.push({ label, who, before, after, time: performance.now() });
    if (this.undoStack.length > 300) { this.undoStack.shift(); this.savedAt--; }
    this.redoStack = [];
  }

  undo() { const e = this.undoStack.pop(); if (e) this.redoStack.push(e); return e || null; }
  redo() { const e = this.redoStack.pop(); if (e) this.undoStack.push(e); return e || null; }
  clear() { this.undoStack = []; this.redoStack = []; this.savedAt = 0; }
  markSaved() { this.savedAt = this.undoStack.length; }
  dirty() { return this.savedAt !== this.undoStack.length; }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  labels(n = 40) { return this.undoStack.slice(-n).reverse().map((e) => (e.who !== "you" ? "[agent] " : "") + e.label); }
}
