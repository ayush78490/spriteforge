const fs = require("fs");
const path = require("path");

function mulberry32(seed) {
  let s = seed | 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function weightedPick(items, rng) {
  const total = items.reduce((s, t) => s + t.weight, 0);
  let r = rng() * total;
  for (const t of items) { r -= t.weight; if (r <= 0) return t; }
  return items[items.length - 1];
}

function loadTraits(traitsPath) {
  return JSON.parse(fs.readFileSync(traitsPath, "utf8"));
}

function maxCombos(traitsPath) {
  const traits = loadTraits(traitsPath);
  return Object.values(traits).reduce((n, arr) => n * arr.length, 1);
}

function comboKey(traits) {
  return Object.values(traits).join("|");
}

function buildPrompt(traits, traitDefs) {
  const parts = ["Edit this image. Keep the same character identity, face shape, and art style."];
  for (const cat of Object.keys(traitDefs)) {
    const val = traits[cat];
    if (!val || val === "None") continue;
    const def = traitDefs[cat].find(t => t.value === val);
    if (def && def.prompt) {
      parts.push(cap(def.prompt) + ".");
    } else {
      parts.push(`${cat}: ${val}.`);
    }
  }
  return parts.join(" ");
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function generateCombos({ count = 100, seed = 42, traitsPath, outputPath }) {
  const traitDefs = loadTraits(traitsPath);
  const categories = Object.keys(traitDefs);
  const max = maxCombos(traitsPath);
  if (count > max) throw new Error(`Requested ${count} combos but only ${max} unique combinations are possible.`);

  const rng = mulberry32(seed);
  const seen = new Set();
  const combos = [];
  let attempts = 0;

  while (combos.length < count) {
    if (++attempts > count * 100) throw new Error("Too many collisions generating unique combos.");
    const traits = {};
    for (const cat of categories) traits[cat] = weightedPick(traitDefs[cat], rng).value;
    const key = comboKey(traits);
    if (seen.has(key)) continue;
    seen.add(key);
    const id = combos.length + 1;
    const imageSeed = Math.floor(rng() * 2147483647);
    combos.push({ id, traits, prompt: buildPrompt(traits, traitDefs), seed: imageSeed });
  }

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(combos, null, 2));
  }
  return combos;
}

function loadCombos(outputPath) {
  return JSON.parse(fs.readFileSync(outputPath, "utf8"));
}

function rejectCombo(combos, id, newSeed) {
  const c = combos.find(x => x.id === id);
  if (!c) throw new Error(`Combo #${id} not found.`);
  c.seed = newSeed != null ? newSeed : Math.floor(Math.random() * 2147483647);
  c.rejected = true;
  return c;
}

module.exports = { generateCombos, loadCombos, maxCombos, rejectCombo, buildPrompt, loadTraits };
