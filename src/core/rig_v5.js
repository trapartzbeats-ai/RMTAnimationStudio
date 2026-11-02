// Rig v5: one canonical bone/control schema over both deform skeletons.
//
// The schema (data/rig_v5.json) learns the detail Mixamo has (clavicles, Spine1, toes and four-joint
// fingers) and the expression rig v4 has (tail, ears, simple hand controls). Each model maps the canonical
// names to its own bones; a missing bone is skipped, never invented. The Simple/Advanced tier filters the
// picker, while the full schema remains available to the agent API.

const normal = (name) => String(name || "").replace(/^mixamorig\d*[:_]?/, "");

export function build(data, actualBones) {
  const bones = Array.isArray(actualBones) ? actualBones : [];
  const style = bones.some((b) => /^mixamorig/i.test(b)) ? "mixamo"
    : bones.includes("hips") ? "rigv4" : "none";
  const byPlain = new Map();
  for (const b of bones) if (!byPlain.has(normal(b))) byPlain.set(normal(b), b);
  const mapping = {};
  const reverse = {};
  const missing = [];
  for (const [canonical, info] of Object.entries(data.bones || {})) {
    const alias = info.aliases ? info.aliases[style] || "" : "";
    let actual = "";
    if (alias) {
      actual = style === "rigv4" ? (bones.includes(alias) ? alias : "") : (byPlain.get(normal(alias)) || "");
    }
    // a rig-v4 skeleton upgraded in place carries the v5-only joints under their canonical names
    if (!actual && style === "rigv4" && bones.includes(canonical)) actual = canonical;
    if (actual) {
      mapping[canonical] = actual;
      reverse[actual] = canonical;
    } else {
      missing.push(canonical);
    }
  }
  const ordered = [];
  for (const canonical of Object.keys(data.bones || {})) {
    const actual = mapping[canonical];
    if (actual && !ordered.includes(actual)) ordered.push(actual);
  }
  for (const actual of bones) if (!ordered.includes(actual)) ordered.push(actual);
  const extras = bones.filter((b) => !reverse[b]);

  const simple = ordered.filter((b) => {
    const c = reverse[b];
    return !!(c && data.bones[c] && data.bones[c].tier === "simple");
  });
  const advanced = [...ordered];
  const controls = (data.controls || []).map((c) => {
    const drives = [];
    for (const d of c.drives || []) {
      if (d[0] === "hips" && d[1] === "dy") { drives.push(d); continue; }
      const actual = mapping[d[0]];
      if (actual) drives.push([actual, d[1], d[2], d[0]]);
    }
    return { ...c, drives };
  });
  const tierControls = (tier) => controls.filter((c) => c.drives.length > 0 && (c.tier === "simple" || tier === "advanced"));
  const list = (tier) => tier === "advanced" ? advanced : simple;
  const groupOf = (actual) => {
    const canonical = reverse[actual];
    return canonical && data.bones[canonical] ? data.bones[canonical].group : "Extras";
  };
  const order = ["Body", "Arm L", "Arm R", "Hand L", "Hand R", "Leg L", "Leg R", "Tail", "Ears", "Extras"];
  const grouped = (listBones) => {
    const by = {};
    for (const b of listBones) (by[groupOf(b)] ||= []).push(b);
    return order.filter((g) => by[g]).map((g) => [g, by[g]]);
  };
  const maskGroup = (group, listBones) => listBones.filter((b) => groupOf(b) === group);
  return {
    groupOf, grouped, maskGroup,
    version: data.version || 5,
    name: data.name || "RIG v5",
    style,
    tier: data.default_tier || "simple",
    mapping, reverse, missing, extras,
    counts: { simple: simple.length, advanced: advanced.length, canonical: Object.keys(mapping).length },
    bones: list,
    controls: tierControls,
    allControls: controls,
    info(tier = "simple") {
      const names = list(tier);
      return {
        version: this.version, name: this.name, style: this.style, tier,
        counts: this.counts,
        available: names,
        hidden: tier === "simple" ? advanced.filter((b) => !names.includes(b)) : [],
        missing: this.missing,
        extras: this.extras,
        mapping: this.mapping,
        controls: tierControls(tier),
        chains: data.chains || {},
        semantics: data.semantics || {},
      };
    },
  };
}
