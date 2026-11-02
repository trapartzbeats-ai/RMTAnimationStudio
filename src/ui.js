// Small DOM helpers so every panel is built the same way.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const button = (text, fn, title = "", cls = "") => h("button", { class: cls, title, onclick: fn }, text);
export const heading = (t) => h("div", { class: "heading" }, t.toUpperCase());
export const hint = (t) => h("div", { class: "hint" }, t);
export const row = (...kids) => h("div", { class: "row" }, ...kids);
export const label = (t, cls = "lbl") => h("span", { class: cls }, t);

export function select(options, value, fn, title = "") {
  const s = h("select", { title, onchange: () => fn(s.value) });
  for (const o of options) s.add(new Option(Array.isArray(o) ? o[1] : o, Array.isArray(o) ? o[0] : o));
  s.value = value;
  return s;
}

export function check(text, on, fn, title = "") {
  const i = h("input", { type: "checkbox", checked: !!on, onchange: () => fn(i.checked) });
  return h("label", { class: "check", title }, i, text);
}

export function num(value, fn, { min = -1e9, max = 1e9, step = 1, width = 70, title = "" } = {}) {
  const i = h("input", { type: "number", value, min, max, step, title, style: `width:${width}px`, onchange: () => fn(Number(i.value)) });
  return i;
}

// label + range + number; returns {el, set(v)}; fn(v) on user change only
export function slider(text, min, max, step, value, fn, { color = "", title = "" } = {}) {
  const r = h("input", { type: "range", min, max, step, value, title });
  const n = h("input", { type: "number", min, max, step, value, style: "width:74px" });
  let quiet = false;
  r.oninput = () => { if (quiet) return; n.value = r.value; fn(Number(r.value)); };
  n.onchange = () => { if (quiet) return; r.value = n.value; fn(Number(n.value)); };
  const el = h("div", { class: "slider" }, h("span", { class: "lbl", style: color ? `color:${color}` : "", title }, text), r, n);
  return { el, r, n, set(v) { quiet = true; r.value = v; n.value = Math.round(v * 1000) / 1000; quiet = false; }, disable(d) { r.disabled = d; n.disabled = d; } };
}

export function list(onPick, onActivate) {
  const el = h("div", { class: "list", tabIndex: 0 });
  let items = [];
  let sel = -1;
  const api = {
    el,
    set(texts, selected = -1, colors = []) {
      items = texts;
      el.innerHTML = "";
      texts.forEach((t, i) => {
        const it = h("div", { class: "item" + (i === selected ? " sel" : ""), style: colors[i] ? `color:${colors[i]}` : "" }, t);
        it.onclick = () => { sel = i; [...el.children].forEach((c, j) => c.classList.toggle("sel", j === i)); onPick && onPick(i, t); };
        it.ondblclick = () => onActivate && onActivate(i, t);
        el.append(it);
      });
      sel = selected;
    },
    selected: () => sel,
    text: () => items[sel],
  };
  return api;
}

export const AX = ["#ff4d5e", "#6be36b", "#4d8dff"];
