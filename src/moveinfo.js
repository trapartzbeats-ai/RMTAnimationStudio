// What a move does, measured on the probe body (the keyed pose, no Body Solve): the strikers' speed and reach, the hit window from
// the clip's hit / clear marks, where a landing touches down and where each foot meets the floor. One pass over the clip, kept
// until the clip changes. SETUP uses it for the effect it suggests, REVIEW for the report, COMPOSE for its recipes and snaps.
// Read-only: it poses the probe body and puts nothing on the clip.
import * as THREE from "three";

export const STRIKERS = ["fist_R", "fist_L", "foot_R", "foot_L"];
const FEET = ["footL", "footR"];
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

let memo = { ctx: null, key: "", info: null };

// the frames the hitbox is live (the clip's marks), in this clip's frames; -1 = not marked
export function hitWindow(d) {
  const m = d.extra.marks || {};
  const hit = m.hit !== undefined ? Math.round(Number(m.hit)) : -1;
  const clear = m.clear !== undefined ? Math.round(Number(m.clear)) : -1;
  return { hit, clear };
}

// -> {fps, frames, hit, clear, socks: [{socket, pos[], speed[] (through the world, stage units / s), peak {v, f},
//     reach {m, f} (horizontal, from the hips), fwd {m, f} (ahead of the hips)}], hips[], lows[],
//     floor, landing (first frame the lowest foot is within 3 cm of the lowest it gets; -1 = never), contacts [{f, foot}]}
// or null before the app has a stage
export function moveInfo(app) {
  const d = app.doc, body = app.stage && app.stage.probe;
  if (!body || !app.fx) return null;
  const key = `${app.fighter}|${d.name}|${d.frames}|${d.fps}|${JSON.stringify(d.extra.marks || {})}`;
  if (memo.ctx === app.ctx && memo.key === key && memo.info) return memo.info;
  const fps = Math.max(1, d.fps), n = d.frames;
  const names = STRIKERS.filter((s) => app.sockSpecs[s] && body.has(app.sockSpecs[s].bone));
  const feet = FEET.filter((b) => body.has(b));
  const pos = Object.fromEntries(names.map((s) => [s, []]));
  const hips = [], lows = [];
  for (let f = 0; f <= n; f++) {
    app.finalPoseOn(body, f);
    body.update();
    for (const s of names) pos[s].push(app.fx.socketOn(body, s));
    hips.push(body.has("hips") ? body.worldPos("hips") : new THREE.Vector3());
    lows.push(feet.length ? Math.min(...feet.map((b) => body.worldPos(b).y)) : 0);
  }
  body.root.position.y = 0;
  body.update();
  const k = app.matchScale || 1;
  const socks = names.map((s) => {
    const p = pos[s];
    const speed = p.map((v, f) => (f ? v.distanceTo(p[f - 1]) * fps : 0));   // through the world, as the game shows it (a lunge carries every limb)
    let peak = { v: 0, f: 0 }, reach = { m: 0, f: 0 }, fwd = { m: 0, f: 0 };
    p.forEach((v, f) => {
      if (speed[f] > peak.v) peak = { v: speed[f], f };
      const dx = v.x - hips[f].x, dz = v.z - hips[f].z;
      const h = Math.hypot(dx, dz) * k;
      if (h > reach.m) reach = { m: h, f };
      if (dz * k > fwd.m) fwd = { m: dz * k, f };   // the fighter faces +Z here
    });
    return { socket: s, pos: p, speed, peak, reach, fwd };
  });
  const floor = lows.length ? Math.min(...lows) : 0;
  const contacts = [];
  const was = { footL: false, footR: false };
  for (let f = 0; f <= n; f++) {
    app.finalPoseOn(body, f);
    for (const b of feet) {
      const down = body.worldPos(b).y <= floor + 0.03;
      if (down && !was[b]) contacts.push({ f, foot: b });
      was[b] = down;
    }
  }
  body.root.position.y = 0;
  body.update();
  const landing = lows.findIndex((y) => y <= floor + 0.03);
  const hw = hitWindow(d);
  memo = { ctx: app.ctx, key, info: { fps, frames: n, hit: hw.hit, clear: hw.clear, socks, hips, lows, floor, landing, contacts, scale: k } };
  return memo.info;
}

// the striker and frame an impact belongs on: the hit mark with the limb that is fastest in the few frames before it, else the
// fastest limb stroke of the clip (a move with no mark needs at least 2.5 m/s). -> {socket, frame, v, marked, why} or null
export function strikePoint(app) {
  const mi = moveInfo(app);
  if (!mi || !mi.socks.length) return null;
  const { hit } = mi;
  const lo = hit >= 0 ? Math.max(1, hit - 5) : 1, hi = hit >= 0 ? Math.min(mi.frames, hit + 1) : mi.frames;
  let best = { v: 0, socket: "", f: -1 };
  for (const s of mi.socks) for (let f = lo; f <= hi; f++) if (s.speed[f] > best.v) best = { v: s.speed[f], socket: s.socket, f };
  if (best.f < 0 || (hit < 0 && best.v < 2.5)) return null;
  const frame = hit >= 0 ? hit : best.f;
  return { socket: best.socket, frame, v: best.v, marked: hit >= 0,
    why: hit >= 0 ? `the hit mark, ${best.socket} is fastest` : `${best.socket} is fastest here (${best.v.toFixed(1)} m/s)` };
}

// startup / active / recovery from the hit and clear marks, in this clip's frames and in game frames at 60 fps, plus ms
export function frameData(app) {
  const mi = moveInfo(app);
  const d = app.doc;
  if (!mi) return null;
  const to60 = (f) => Math.round(f * 60 / mi.fps);
  const ms = (f) => Math.round(f * 1000 / mi.fps);
  const out = { frames: mi.frames, fps: mi.fps, total_ms: ms(mi.frames), hit: mi.hit, clear: mi.clear, marked: mi.hit >= 0 };
  if (mi.hit >= 0) {
    out.startup = { f: mi.hit, f60: to60(mi.hit), ms: ms(mi.hit) };
    if (mi.clear >= mi.hit) {
      out.active = { f: mi.clear - mi.hit + 1, f60: to60(mi.clear - mi.hit + 1), ms: ms(mi.clear - mi.hit + 1) };
      const rec = Math.max(0, mi.frames - mi.clear);
      out.recovery = { f: rec, f60: to60(rec), ms: ms(rec) };
    }
  }
  out.name = d.name;
  return out;
}

// per striker: {socket, peak_ms (top speed through the world, m/s at match size), peak_f, reach_m (horizontal, from the hips), reach_f, fwd_m
// (ahead of the hips), fwd_f, at_hit_ms (the speed around the hit)}
export function strikerStats(app) {
  const mi = moveInfo(app);
  if (!mi) return [];
  const k = mi.scale;
  return mi.socks.map((s) => ({ socket: s.socket, peak_ms: r1(s.peak.v * k), peak_f: s.peak.f, reach_m: r2(s.reach.m), reach_f: s.reach.f, fwd_m: r2(s.fwd.m), fwd_f: s.fwd.f,
    at_hit_ms: mi.hit >= 0 ? r1(Math.max(...[mi.hit - 1, mi.hit, mi.hit + 1].filter((f) => f >= 1 && f <= mi.frames).map((f) => s.speed[f])) * k) : null }));
}

// the strongest striker (greatest peak speed), or null
export function mainStriker(app) {
  const st = strikerStats(app);
  if (!st.length) return null;
  return st.slice().sort((a, b) => b.peak_ms - a.peak_ms)[0];
}

// frames where the lowest foot comes down onto the floor after a real stretch in the air (15 cm up for a few frames: a landing, the step
// after a jump - not a foot that swings a little); two landings are at least 0.2 s apart
export function touchdowns(mi) {
  const need = Math.max(3, Math.round(4 * mi.fps / 60)), lift = mi.floor + 0.15, gap = Math.round(0.2 * mi.fps);
  const out = [];
  let air = 0;
  for (let f = 0; f < mi.lows.length; f++) {
    if (mi.lows[f] > lift) air++;
    else if (mi.lows[f] <= mi.floor + 0.03) {
      if (air >= need && (!out.length || f - out[out.length - 1] >= gap)) out.push(f);
      air = 0;
    }
  }
  return out;
}

export const mirrorSocket =(n) => (/_R$/.test(n) ? n.replace(/_R$/, "_L") : /_L$/.test(n) ? n.replace(/_L$/, "_R") : n);
