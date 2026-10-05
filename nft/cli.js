#!/usr/bin/env node
// NFT Collection Generator CLI — works alongside SpriteForge's existing functionality.
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const NFT = __dirname;
const defaults = () => JSON.parse(fs.readFileSync(path.join(NFT, "config.json"), "utf8"));
const traitsPath = () => path.join(NFT, "traits.json");
const outputDir = () => path.join(ROOT, defaults().outputDir || "nft/output");
const combosPath = () => path.join(outputDir(), "combos.json");
const imagesDir = () => path.join(outputDir(), "images");

const [,, cmd, ...rest] = process.argv;
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? (rest[i + 1] || true) : null; };

const dur = (s) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);

async function main() {
  switch (cmd) {
    case "analyze": return cmdAnalyze();
    case "combos": return cmdCombos();
    case "preview": return cmdGenerate(true);
    case "generate": return cmdGenerate(false);
    case "reject": return cmdReject();
    case "metadata": return cmdMetadata();
    case "set-cid": return cmdSetCid();
    case "finalize": return cmdFinalize();
    case "rarity": return cmdRarity();
    case "describe": return cmdDescribe();
    default:
      console.log(`NFT Collection Generator

Commands:
  analyze    Auto-generate traits from a character description (Ollama)
  combos     Generate trait combinations
  preview    Generate first 10 images to check quality
  generate   Generate all images (resumable)
  reject     Mark images as rejected and regenerate
  metadata   Generate OpenSea-compatible metadata
  set-cid    Update metadata with the real IPFS CID
  finalize   Renumber IDs to be continuous
  rarity     Generate rarity report
  describe   Add AI descriptions via Ollama (optional)

Options:
  --desc "..." Character description (for analyze)
  --count N    Number of combinations (default: 100)
  --seed N     Master seed for reproducibility (default: 42)
  --base PATH  Path to base character image
  --ids 1,2,3  Comma-separated IDs (for reject)
  --cid QmX... IPFS CID (for set-cid)`);
  }
}

async function cmdAnalyze() {
  const desc = flag("desc");
  if (!desc) return console.error('Error: --desc "describe your character" is required.');
  const { generateTraitsFromDescription, saveTraits } = require("./analyze");
  console.log("Generating traits with Ollama (this may take 30-60s)…");
  const result = await generateTraitsFromDescription(desc);
  await saveTraits(result.traits, traitsPath());
  console.log(`\nGenerated ${Object.keys(result.traits).length} trait categories → ${traitsPath()}`);
  for (const [cat, vals] of Object.entries(result.traits)) {
    console.log(`\n${cat}:`);
    for (const v of vals) console.log(`  ${v.value.padEnd(22)} w=${String(v.weight).padStart(2)}  ${v.prompt || "(keep original)"}`);
  }
}

async function cmdCombos() {
  const { generateCombos, maxCombos } = require("./combos");
  const count = +(flag("count") || 100);
  const seed = +(flag("seed") || 42);
  const max = maxCombos(traitsPath());
  console.log(`Max possible unique combinations: ${max}`);
  const combos = generateCombos({ count, seed, traitsPath: traitsPath(), outputPath: combosPath() });
  console.log(`Generated ${combos.length} unique combinations → ${combosPath()}`);
}

async function cmdGenerate(preview) {
  const base = flag("base");
  if (!base) return console.error("Error: --base <path-to-character.png> is required.");
  if (!fs.existsSync(base)) return console.error(`Error: ${base} not found.`);
  if (!fs.existsSync(combosPath())) return console.error("Error: Run 'combos' first to generate combinations.");

  const { generateImages, generatePreview } = require("./generate");
  const config = defaults();
  const fn = preview ? generatePreview : generateImages;
  console.log(`${preview ? "Preview (10)" : "Full"} generation starting…`);
  const result = await fn({
    basePath: path.resolve(base), combosPath: combosPath(), outputDir: imagesDir(), config,
    onProgress: (p) => {
      const bar = "█".repeat(Math.floor(p.current / p.total * 30)).padEnd(30, "░");
      const eta = p.eta ? ` · ETA ${dur(p.eta)}` : "";
      process.stdout.write(`\r  ${bar} ${p.current}/${p.total} · #${p.id} ${p.status}${eta}   `);
    },
    onError: (id, e) => console.error(`\n  ✗ #${id}: ${e.message}`),
  });
  console.log(`\nDone: ${result.completed} generated, ${result.skipped} skipped, ${result.failed} failed.`);
}

async function cmdReject() {
  const idsStr = flag("ids");
  if (!idsStr) return console.error("Error: --ids 1,2,3 is required.");
  const ids = idsStr.split(",").map(Number).filter(Boolean);
  if (!fs.existsSync(combosPath())) return console.error("Error: combos.json not found.");

  const { loadCombos, rejectCombo } = require("./combos");
  const { regenerateOne } = require("./generate");
  const combos = loadCombos(combosPath());
  const config = defaults();
  const base = flag("base");

  for (const id of ids) {
    rejectCombo(combos, id);
    console.log(`  Rejected #${id}, new seed: ${combos.find(c => c.id === id).seed}`);
    // Remove the old image
    const img = path.join(imagesDir(), `${id}.png`);
    if (fs.existsSync(img)) fs.unlinkSync(img);
  }
  fs.writeFileSync(combosPath(), JSON.stringify(combos, null, 2));

  if (base && fs.existsSync(base)) {
    console.log("Regenerating rejected images…");
    for (const id of ids) {
      try {
        await regenerateOne({ id, basePath: path.resolve(base), combosPath: combosPath(), outputDir: imagesDir(), config });
        console.log(`  ✓ #${id} regenerated`);
      } catch (e) { console.error(`  ✗ #${id}: ${e.message}`); }
    }
  } else {
    console.log("Run 'generate --base ...' to regenerate the rejected images.");
  }
}

async function cmdMetadata() {
  if (!fs.existsSync(combosPath())) return console.error("Error: combos.json not found. Run 'combos' first.");
  const { generateMetadata, generateRarity } = require("./metadata");
  const config = defaults();
  const result = await generateMetadata({ combosPath: combosPath(), outputDir: outputDir(), config });
  console.log(`Metadata generated for ${result.count} NFTs → ${result.metaDir}`);
  const rarity = generateRarity({ combosPath: combosPath(), outputDir: outputDir() });
  console.log(`Rarity report → ${path.join(outputDir(), "rarity.json")}`);
}

async function cmdSetCid() {
  const cid = flag("cid");
  if (!cid) return console.error("Error: --cid <CID> is required.");
  const { setCid } = require("./metadata");
  const result = await setCid({ combosPath: combosPath(), outputDir: outputDir(), cid });
  console.log(`Updated ${result.count} metadata files with CID: ${result.cid}`);
}

async function cmdFinalize() {
  if (!fs.existsSync(combosPath())) return console.error("Error: combos.json not found.");
  const { finalize } = require("./finalize");
  const { generateMetadata, generateRarity } = require("./metadata");
  const result = await finalize({ combosPath: combosPath(), outputDir: outputDir() });
  console.log(`Finalized: ${result.total} NFTs with continuous IDs.`);
  const config = defaults();
  await generateMetadata({ combosPath: combosPath(), outputDir: outputDir(), config });
  generateRarity({ combosPath: combosPath(), outputDir: outputDir() });
  console.log("Metadata and rarity report regenerated.");
}

async function cmdRarity() {
  if (!fs.existsSync(combosPath())) return console.error("Error: combos.json not found.");
  const { generateRarity } = require("./metadata");
  const rarity = generateRarity({ combosPath: combosPath(), outputDir: outputDir() });
  for (const [cat, vals] of Object.entries(rarity)) {
    console.log(`\n${cat}:`);
    for (const v of vals) console.log(`  ${v.value.padEnd(20)} ${String(v.count).padStart(4)} (${v.percent}%)`);
  }
}

async function cmdDescribe() {
  if (!fs.existsSync(combosPath())) return console.error("Error: combos.json not found.");
  const { addDescriptions } = require("./ollama");
  try {
    const result = await addDescriptions({
      combosPath: combosPath(),
      onProgress: (p) => process.stdout.write(`\r  ${p.current}/${p.total} · #${p.id}${p.error ? " (failed)" : ""}   `),
    });
    console.log(`\nDescriptions: ${result.described}/${result.total} written.`);
  } catch (e) { console.error(`Error: ${e.message}`); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
