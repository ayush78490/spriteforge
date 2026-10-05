const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

async function finalize({ combosPath, outputDir }) {
  const combos = JSON.parse(await fsp.readFile(combosPath, "utf8"));
  const imagesDir = path.join(outputDir, "images");
  const metaDir = path.join(outputDir, "metadata");

  // Filter to only combos that have a generated image
  const valid = combos.filter(c => fs.existsSync(path.join(imagesDir, `${c.id}.png`)));

  // Renumber continuously from 1
  const remap = new Map();
  for (let i = 0; i < valid.length; i++) {
    const oldId = valid[i].id;
    const newId = i + 1;
    remap.set(oldId, newId);
    valid[i].id = newId;
  }

  // Rename image files (use temp names to avoid collisions)
  for (const [oldId, newId] of remap) {
    if (oldId !== newId) {
      const src = path.join(imagesDir, `${oldId}.png`);
      const tmp = path.join(imagesDir, `_tmp_${newId}.png`);
      if (fs.existsSync(src)) await fsp.rename(src, tmp);
    }
  }
  for (const [oldId, newId] of remap) {
    if (oldId !== newId) {
      const tmp = path.join(imagesDir, `_tmp_${newId}.png`);
      const dst = path.join(imagesDir, `${newId}.png`);
      if (fs.existsSync(tmp)) await fsp.rename(tmp, dst);
    }
  }

  // Clean up any leftover images not in the valid set
  const validIds = new Set(valid.map(c => c.id));
  if (fs.existsSync(imagesDir)) {
    for (const f of await fsp.readdir(imagesDir)) {
      const m = f.match(/^(\d+)\.png$/);
      if (m && !validIds.has(+m[1])) await fsp.rm(path.join(imagesDir, f), { force: true });
    }
  }

  // Clean up old metadata
  if (fs.existsSync(metaDir)) {
    for (const f of await fsp.readdir(metaDir)) await fsp.rm(path.join(metaDir, f), { force: true });
  }

  // Save updated combos
  await fsp.writeFile(combosPath, JSON.stringify(valid, null, 2));
  return { total: valid.length, remap: Object.fromEntries(remap) };
}

module.exports = { finalize };
