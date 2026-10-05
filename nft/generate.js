const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const sharp = require("sharp");
const { ComfyClient } = require("../lib/comfy");
const { buildKontextWorkflow } = require("../lib/imagegen");

async function prepareBase(basePath, comfy, width, height) {
  const raw = await fsp.readFile(basePath);
  const buf = await sharp(raw)
    .resize(width, height, { fit: "cover" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
  const filename = `nft_base_${Date.now()}.png`;
  const uploaded = await comfy.uploadImage(buf, filename);
  return uploaded;
}

async function generateOne(comfy, uploaded, combo, config, outputPath, onProgress) {
  const { workflow, outputNodeIds } = buildKontextWorkflow({
    image: uploaded,
    prompt: combo.prompt,
    width: config.imageWidth || 768,
    height: config.imageHeight || 768,
    steps: config.steps || 20,
    guidance: config.guidance || 2.5,
    seed: combo.seed,
    prefix: `nft/${combo.id}`,
  });

  const promptId = await comfy.queue(workflow);
  const history = await comfy.wait(promptId, (e) => {
    if (e.max != null && onProgress) onProgress({ step: e.value, steps: e.max });
  });
  const [img] = await comfy.outputImages(history, outputNodeIds);
  if (!img) throw new Error("ComfyUI returned no image");
  await fsp.writeFile(outputPath, img);
}

async function generateImages({ basePath, combosPath, outputDir, config, onProgress, onError, signal, limit }) {
  const combos = JSON.parse(await fsp.readFile(combosPath, "utf8"));
  const subset = limit ? combos.slice(0, limit) : combos;
  const total = subset.length;
  await fsp.mkdir(outputDir, { recursive: true });

  const comfy = new ComfyClient(config.comfyUrl || "http://127.0.0.1:8188");
  await comfy.ping();

  const uploaded = await prepareBase(basePath, comfy, config.imageWidth || 768, config.imageHeight || 768);

  const logPath = path.join(path.dirname(outputDir), "errors.log");
  const log = (msg) => fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);

  let completed = 0, skipped = 0, failed = 0;
  const startTime = Date.now();

  for (const combo of subset) {
    if (signal && signal.aborted) break;
    const outPath = path.join(outputDir, `${combo.id}.png`);
    if (fs.existsSync(outPath)) {
      skipped++;
      if (onProgress) onProgress({ current: completed + skipped + failed, total, id: combo.id, status: "skipped", elapsed: (Date.now() - startTime) / 1000 });
      continue;
    }

    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await generateOne(comfy, uploaded, combo, config, outPath, null);
        completed++;
        success = true;
        if (combo.rejected) delete combo.rejected;
        const elapsed = (Date.now() - startTime) / 1000;
        const done = completed + skipped + failed;
        const rate = elapsed / (completed || 1);
        const eta = rate * (total - done);
        if (onProgress) onProgress({ current: done, total, id: combo.id, status: "done", elapsed, eta });
        break;
      } catch (e) {
        if (attempt < 2) {
          log(`Combo #${combo.id} attempt ${attempt + 1} failed: ${e.message}. Retrying...`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          log(`Combo #${combo.id} FAILED after 3 attempts: ${e.message}`);
          if (onError) onError(combo.id, e);
          failed++;
          const elapsed = (Date.now() - startTime) / 1000;
          if (onProgress) onProgress({ current: completed + skipped + failed, total, id: combo.id, status: "error", elapsed });
        }
      }
    }
  }

  if (completed > 0) await fsp.writeFile(combosPath, JSON.stringify(combos, null, 2));
  return { completed, skipped, failed, total };
}

async function generatePreview(opts) {
  return generateImages({ ...opts, limit: 10 });
}

async function regenerateOne({ id, basePath, combosPath, outputDir, config, onProgress }) {
  const combos = JSON.parse(await fsp.readFile(combosPath, "utf8"));
  const combo = combos.find(c => c.id === id);
  if (!combo) throw new Error(`Combo #${id} not found`);

  const outPath = path.join(outputDir, `${id}.png`);
  await fsp.rm(outPath, { force: true });

  const comfy = new ComfyClient(config.comfyUrl || "http://127.0.0.1:8188");
  await comfy.ping();
  const uploaded = await prepareBase(basePath, comfy, config.imageWidth || 768, config.imageHeight || 768);
  await generateOne(comfy, uploaded, combo, config, outPath, onProgress);
  return combo;
}

module.exports = { generateImages, generatePreview, regenerateOne };
