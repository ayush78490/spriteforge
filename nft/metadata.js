const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

async function generateMetadata({ combosPath, outputDir, config }) {
  const combos = JSON.parse(await fsp.readFile(combosPath, "utf8"));
  const metaDir = path.join(outputDir, "metadata");
  await fsp.mkdir(metaDir, { recursive: true });

  const cid = config.imagesCid || "PLACEHOLDER_CID";

  for (const combo of combos) {
    const meta = {
      name: `${config.collectionName} #${combo.id}`,
      description: combo.description || config.collectionDescription,
      image: `ipfs://${cid}/${combo.id}.png`,
      external_url: config.externalUrl || "",
      attributes: Object.entries(combo.traits).map(([k, v]) => ({ trait_type: k, value: v })),
    };
    await fsp.writeFile(path.join(metaDir, String(combo.id)), JSON.stringify(meta, null, 2));
    await fsp.writeFile(path.join(metaDir, `${combo.id}.json`), JSON.stringify(meta, null, 2));
  }

  const collection = {
    name: config.collectionName,
    description: config.collectionDescription,
    image: `ipfs://${cid}/collection.png`,
    external_link: config.externalUrl || "",
    seller_fee_basis_points: config.sellerFeeBasisPoints || 500,
    fee_recipient: config.feeRecipient || "0x0000000000000000000000000000000000000000",
  };
  await fsp.writeFile(path.join(outputDir, "collection.json"), JSON.stringify(collection, null, 2));

  return { count: combos.length, metaDir };
}

async function setCid({ combosPath, outputDir, cid }) {
  const combos = JSON.parse(await fsp.readFile(combosPath, "utf8"));
  const metaDir = path.join(outputDir, "metadata");

  for (const combo of combos) {
    for (const name of [String(combo.id), `${combo.id}.json`]) {
      const p = path.join(metaDir, name);
      if (!fs.existsSync(p)) continue;
      const meta = JSON.parse(await fsp.readFile(p, "utf8"));
      meta.image = `ipfs://${cid}/${combo.id}.png`;
      await fsp.writeFile(p, JSON.stringify(meta, null, 2));
    }
  }

  const colPath = path.join(outputDir, "collection.json");
  if (fs.existsSync(colPath)) {
    const col = JSON.parse(await fsp.readFile(colPath, "utf8"));
    col.image = `ipfs://${cid}/collection.png`;
    await fsp.writeFile(colPath, JSON.stringify(col, null, 2));
  }

  return { count: combos.length, cid };
}

function generateRarity({ combosPath, outputDir }) {
  const combos = JSON.parse(fs.readFileSync(combosPath, "utf8"));
  const total = combos.length;
  const counts = {};

  for (const combo of combos) {
    for (const [cat, val] of Object.entries(combo.traits)) {
      if (!counts[cat]) counts[cat] = {};
      counts[cat][val] = (counts[cat][val] || 0) + 1;
    }
  }

  const report = {};
  for (const [cat, vals] of Object.entries(counts)) {
    report[cat] = Object.entries(vals)
      .map(([value, count]) => ({ value, count, percent: +((count / total) * 100).toFixed(2) }))
      .sort((a, b) => b.count - a.count);
  }

  const outPath = path.join(outputDir, "rarity.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return report;
}

module.exports = { generateMetadata, setCid, generateRarity };
