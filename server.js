// SpriteForge server: characters, action jobs (queued one at a time on the local GPU),
// live progress over SSE, re-processing without re-generating, and exports.
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { ComfyClient } = require("./lib/comfy");
const { patchWorkflow } = require("./lib/workflow");
const { ACTIONS, FIGHTER_ORDER, NEGATIVE, buildPrompt } = require("./lib/actions");
const P = require("./lib/pipeline");
const { startSampling } = require("./lib/sysstats");
const { buildKontextWorkflow, IMAGE_PRESETS } = require("./lib/imagegen");
const { listApps, closeApp } = require("./lib/apps");
const SC = require("./lib/scene");
const { SceneWorker } = require("./lib/sceneWorker");
const CLIP = require("./lib/clip");
const sharp = require("sharp");

const ROOT = __dirname;
const DATA = process.env.SPRITEFORGE_DATA || path.join(ROOT, "data");
const WF_DIR = path.join(ROOT, "workflows");
const PORT = +process.env.PORT || 8000;

const DEFAULTS = {
  comfyUrl: "http://127.0.0.1:8188",
  workflow: "wan22_14b_gguf_lightning_api.json",
  loopWorkflow: "",            // optional first-last-frame workflow for perfect loops
  videoWidth: 480, videoHeight: 832, videoLength: 49, // Wan needs length = 4k+1
  keyColor: "green",
  charHeightFrac: 0.56, feetFrac: 0.9, centerFrac: 0.5,
  cellWidth: 256, cellHeight: 320, baselineY: 312, charHeightPx: 230,
  key: { tolerance: 40, softness: 50, despill: 0.85, cleanup: 12 },
};

// ------------------------------------------------------------------ storage
const dirs = { chars: path.join(DATA, "characters"), jobs: path.join(DATA, "jobs"), scenes: path.join(DATA, "scenes") };
Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1));
const cfgPath = path.join(DATA, "config.json");
let config = { ...DEFAULTS, ...readJson(cfgPath, {}) };
config.key = { ...DEFAULTS.key, ...(config.key || {}) };
if (!fs.existsSync(path.join(WF_DIR, config.workflow))) config.workflow = DEFAULTS.workflow; // e.g. a removed workflow

const chars = new Map(), jobs = new Map();
for (const id of fs.readdirSync(dirs.chars)) { const c = readJson(path.join(dirs.chars, id, "meta.json")); if (c) chars.set(id, c); }
for (const id of fs.readdirSync(dirs.jobs)) {
  const j = readJson(path.join(dirs.jobs, id, "job.json"));
  if (!j) continue;
  if (["queued", "running"].includes(j.status)) { j.status = "queued"; j.progress = 0; } // resume after restart
  jobs.set(id, j);
}
const charDir = (id) => path.join(dirs.chars, id);
const jobDir = (id) => path.join(dirs.jobs, id);
const saveChar = (c) => writeJson(path.join(charDir(c.id), "meta.json"), c);
const saveJob = (j) => writeJson(path.join(jobDir(j.id), "job.json"), j);
const newId = () => crypto.randomBytes(5).toString("hex");

// ------------------------------------------------------------------ events (SSE)
const clients = new Set();
function emit(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
const publicJob = (j) => ({ ...j, workflowReport: undefined });

// System stats are sampled only while at least one browser is connected.
// ComfyUI's own RAM use comes from the spriteforge_ram_guard custom node (null if it isn't installed).
let lastStats = null, stopStats = null, comfyMem = null;
function syncStatsSampler() {
  if (clients.size && !stopStats) {
    const poll = setInterval(async () => {
      try { comfyMem = await (await fetch(`${config.comfyUrl}/spriteforge/memory`, { signal: AbortSignal.timeout(900) })).json(); }
      catch { comfyMem = null; }
    }, 1000);
    const stopSampling = startSampling((s) => { s.comfy = comfyMem; lastStats = s; emit("stats", s); });
    stopStats = () => { clearInterval(poll); stopSampling(); };
  } else if (!clients.size && stopStats) { stopStats(); stopStats = null; }
}

// ------------------------------------------------------------------ worker
let working = false;
async function pump() {
  if (working) return;
  const next = [...jobs.values()].filter((j) => j.status === "queued").sort((a, b) => a.created - b.created)[0];
  if (!next) return;
  working = true;
  try { await runJob(next); } catch (e) {
    next.status = "error"; next.error = String(e.message || e); saveJob(next); emit("job", publicJob(next));
  } finally {
    // Give the RAM back unless the next job reuses the same models right away (keeps the 22 GB budget free between jobs).
    const after = [...jobs.values()].filter((j) => j.status === "queued").sort((a, b) => a.created - b.created)[0];
    if (next.status === "error" || !after || (after.kind || "video") !== (next.kind || "video"))
      await new ComfyClient(config.comfyUrl).free().catch(() => {});
    working = false; setImmediate(pump);
  }
}

function update(j, patch) { Object.assign(j, patch); saveJob(j); emit("job", publicJob(j)); }

// Overall progress band of each phase, sized from a measured Wan 5B run (sampling ~72%, VAE decode ~18%).
const PHASE_BANDS = { prepare: [0, 0.01], load: [0.01, 0.05], sample: [0.05, 0.77], decode: [0.77, 0.94], frames: [0.94, 1] };
const PHASE_ORDER = Object.keys(PHASE_BANDS);
const band = (phase, f) => PHASE_BANDS[phase][0] + (PHASE_BANDS[phase][1] - PHASE_BANDS[phase][0]) * Math.min(Math.max(f, 0), 1);
const isSampler = (ct) => /KSampler(Advanced)?$|SamplerCustom|VideoSampler/i.test(ct);
function nodePhase(ct) {
  if (isSampler(ct)) return "sample";
  if (/VAEDecode/i.test(ct)) return "decode";
  if (/^(Save|Preview)|VideoCombine|CreateVideo/i.test(ct)) return "frames";
  return "load";
}
function nodeStage(ct, kind) {
  if (/MMAudioSampler/.test(ct)) return "making the sound";
  if (/Qwen3TTS/.test(ct)) return "speaking the line";
  if (/VHS_LoadVideo/.test(ct)) return "reading the video";
  if (/VideoCombine/.test(ct)) return "saving the MP4";
  if (/SaveAudio/.test(ct)) return "saving the audio";
  if (/Loader/i.test(ct)) return "loading models";
  if (/TextEncode/i.test(ct)) return "encoding prompt";
  if (isSampler(ct)) return "sampling · loading model to GPU";
  if (/VAEDecode/i.test(ct)) return kind === "image" ? "decoding image" : "decoding video";
  if (/^(Save|Preview)/i.test(ct)) return kind === "image" ? "saving image" : "saving frames";
  return "encoding image";
}

/** Average seconds per phase over the last few finished jobs that used the same workflow and video size. */
function phaseHistory(j) {
  if (j.kind === "clip") return null; // several ComfyUI runs per job: only the live step rate gives an ETA
  const sameSize = j.kind === "image"
    ? (x) => x.kind === "image" && x.sampleSteps === j.sampleSteps && (j.hasInput || (x.width === j.width && x.height === j.height))
    : (x) => (x.kind || "video") === "video" && x.settings.videoWidth === j.settings.videoWidth
      && x.settings.videoHeight === j.settings.videoHeight && x.settings.videoLength === j.settings.videoLength;
  const same = [...jobs.values()].filter((x) => x.timing && x.wfFile === j.wfFile && sameSize(x)).sort((a, b) => b.finished - a.finished).slice(0, 5);
  if (!same.length) return null;
  return Object.fromEntries(PHASE_ORDER.map((p) => [p, same.reduce((a, x) => a + (x.timing[p] || 0), 0) / same.length]));
}

/** Seconds left for the whole job; sampling uses the live step rate, other phases use history. null if unknown. */
function estimateEta(j, hist, now) {
  let eta = 0;
  for (let i = PHASE_ORDER.indexOf(j.phase); i < PHASE_ORDER.length; i++) {
    const p = PHASE_ORDER[i];
    if (p === "sample" && j.secPerStep && j.stepsLeft != null) { eta += j.stepsLeft * j.secPerStep; continue; }
    if (!hist) return null;
    eta += Math.max(hist[p] - (p === j.phase ? (now - j.phaseStarts[p]) / 1000 : 0), 0);
  }
  return Math.round(eta);
}

function phaseTiming(j, end) {
  const starts = PHASE_ORDER.filter((p) => j.phaseStarts[p]);
  return Object.fromEntries(starts.map((p, i) => [p, ((i + 1 < starts.length ? j.phaseStarts[starts[i + 1]] : end) - j.phaseStarts[p]) / 1000]));
}

const GiB = 1024 ** 3;
const RAM_MIN_START = 6 * GiB; // with less room than this under the PC limit, paging would make generation crawl
const RAM_NEED_DEFAULT = { video: 11 * GiB, image: 11 * GiB, clip: 11 * GiB }; // RAM for full speed (measured); refined from real runs below

/** RAM ComfyUI needs to run this kind of job at full speed, from the last run that recorded it. */
function ramNeed(j) {
  const kind = j.kind || "video";
  const last = [...jobs.values()].filter((x) => (x.kind || "video") === kind && x.ramPeak && x.status === "done").sort((a, b) => b.finished - a.finished)[0];
  return last ? last.ramPeak : RAM_NEED_DEFAULT[kind];
}

/**
 * Wait until the whole-PC RAM limit leaves enough room for ComfyUI. Below RAM_MIN_START the job waits
 * (the UI lists which apps to close); above it, the guard slows ComfyUI down if it has to, but never lets
 * the PC go over the limit.
 */
async function waitForRam(j, comfy) {
  for (let announced = false; ; announced = true) {
    const m = await comfy.memory();
    if (!m) { // no answer: ComfyUI may be restarting (wait for it), or it runs without the RAM guard (go ahead)
      try { await comfy.ping(); return; } catch {}
      update(j, { stage: "waiting for ComfyUI to come back", waitingRam: null });
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!m.systemLimit || m.others == null) return; // guard not installed: nothing to check
    const room = m.systemLimit - m.others;
    if (room >= RAM_MIN_START) {
      if (announced) update(j, { stage: "preparing", waitingRam: null });
      return;
    }
    const gb = (b) => (b / GiB).toFixed(1);
    update(j, { stage: `waiting for RAM · ${gb(room)} GB free under your ${gb(m.systemLimit)} GB limit`,
      waitingRam: { room, need: ramNeed(j), min: RAM_MIN_START, limit: m.systemLimit } });
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function beginJob(j) {
  const t0 = Date.now();
  update(j, { status: "running", progress: 0, stage: "preparing", error: null, started: t0, phase: "prepare", phaseStarts: { prepare: t0 },
    step: null, steps: null, stepsLeft: null, secPerStep: null, eta: null, etaAt: null, timing: null });
}
function finishJob(j) {
  const end = Date.now();
  update(j, { status: "done", progress: 1, stage: "done", finished: end, eta: 0, etaAt: end, timing: phaseTiming(j, end) });
}

/**
 * Queue a workflow on ComfyUI and track it on job j (phases, sampler steps, ETA).
 * Returns the history entry plus `refresh(patch, force)` for the steps that follow.
 */
async function runComfy(j, comfy, workflow, extra = {}) {
  const hist = phaseHistory(j);
  const nodeClass = (id) => (id != null && workflow[id] && workflow[id].class_type) || "";
  const nSamplers = Math.max(1, Object.values(workflow).filter((n) => isSampler(n.class_type)).length);
  const samplersSeen = [];
  let firstStepAt = null, firstStepValue = 0, lastEmit = 0;
  const enterPhase = (p) => {
    if (PHASE_ORDER.indexOf(p) <= PHASE_ORDER.indexOf(j.phase)) return;
    j.phase = p; j.phaseStarts[p] = Date.now();
  };
  const refresh = (patch, force) => {
    const now = Date.now();
    if (j.span && patch.progress != null) patch = { ...patch, progress: j.span[0] + patch.progress * (j.span[1] - j.span[0]) };
    if (j.stagePrefix && patch.stage) patch = { ...patch, stage: j.stagePrefix + patch.stage };
    Object.assign(j, patch);
    if (!force && now - lastEmit < 400) return;
    lastEmit = now;
    update(j, { eta: estimateEta(j, hist, now), etaAt: now });
  };

  // Record ComfyUI's peak physical RAM for this job, to estimate what the next one needs.
  j.ramPeak = 0;
  const ramPoll = setInterval(async () => { const m = await comfy.memory(); if (m && m.workingSet > j.ramPeak) j.ramPeak = m.workingSet; }, 2000);
  let history;
  try {
    const promptId = await comfy.queue(workflow);
    enterPhase("load");
    refresh({ stage: "loading models", progress: band("load", 0), ...extra }, true);
    history = await comfy.wait(promptId, (e) => {
      const ct = nodeClass(e.node);
      if (e.max == null) { // a node started executing
        const phase = nodePhase(ct);
        if (PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(j.phase)) return; // e.g. 14B's second ModelSamplingSD3 runs mid-sampling
        enterPhase(phase);
        if (phase === "sample" && !samplersSeen.includes(e.node)) { samplersSeen.push(e.node); firstStepAt = null; }
        return refresh({ stage: nodeStage(ct, j.kind), progress: band(j.phase, phase === "sample" ? (samplersSeen.length - 1) / nSamplers : 0) }, true);
      }
      const now = Date.now();
      if (e.node && !isSampler(ct)) return refresh({ stage: `${nodeStage(ct, j.kind)} · ${e.value}/${e.max}`, progress: band(j.phase, e.value / e.max) });
      // sampler step (older/mock servers omit the node id, so treat anonymous progress as sampling)
      enterPhase("sample");
      const idx = Math.max(0, samplersSeen.indexOf(e.node));
      if (firstStepAt == null || e.value <= firstStepValue) { firstStepAt = now; firstStepValue = e.value; }
      const secPerStep = e.value > firstStepValue ? (now - firstStepAt) / 1000 / (e.value - firstStepValue) : j.secPerStep;
      const step = idx * e.max + e.value, steps = nSamplers * e.max;
      refresh({ step, steps, stepsLeft: steps - step, secPerStep, stage: `sampling · step ${step}/${steps}`,
        progress: band("sample", (idx + e.value / e.max) / nSamplers) }, e.value === 1 || e.value === e.max);
    });
  } finally { clearInterval(ramPoll); }
  enterPhase("frames");
  return { history, refresh };
}

/** Latest finished job of `action` for character `cid` that still has its video frames. */
function sourceJob(cid, action) {
  return [...jobs.values()].filter((x) => x.characterId === cid && x.action === action && x.status === "done" && x.rawCount && !x.derivedFrom)
    .sort((a, b) => (b.finished || 0) - (a.finished || 0))[0];
}

/** Build a reversed animation (e.g. Walk_Backward) from another action's clip, with no generation. */
async function deriveJob(j, src) {
  beginJob(j);
  const rawDir = path.join(jobDir(j.id), "raw");
  await fsp.rm(rawDir, { recursive: true, force: true });
  await fsp.cp(path.join(jobDir(src.id), "raw"), rawDir, { recursive: true });
  await fsp.copyFile(path.join(jobDir(src.id), "input.png"), path.join(jobDir(j.id), "input.png")).catch(() => {});
  j.phaseStarts.frames = Date.now();
  // same key, frame count, speed and range as the source, so the pair always matches
  update(j, { layout: src.layout, rawCount: src.rawCount, wfFile: src.wfFile, seed: src.seed, derivedFrom: { id: src.id, action: src.action },
    key: { ...src.key }, frames: src.frames, fps: src.fps, range: src.range ? { ...src.range } : null,
    stage: `reversing ${src.action.replace(/_/g, " ")}`, progress: 0.5, phase: "frames" });
  await processJob(j);
  finishJob(j);
}

/** After `src` changes (new take or re-tuned), rebuild the animations made from it (e.g. Walk_Backward). */
async function refreshDerived(src) {
  for (const a of ACTIONS.filter((x) => x.reverseOf === src.action)) {
    const mine = [...jobs.values()].filter((x) => x.characterId === src.characterId && x.action === a.name);
    if (mine.some((x) => ["queued", "running"].includes(x.status))) continue; // it will pick up the new source itself
    const latest = mine.filter((x) => x.status === "done").sort((x, y) => (y.finished || 0) - (x.finished || 0))[0];
    if (latest && latest.derivedFrom) await deriveJob(latest, src).catch((e) => console.error("rebuild", a.name, e.message));
  }
}

async function runJob(j) {
  if (j.kind === "image") return runImageJob(j);
  if (j.kind === "clip") return runClipJob(j);
  const c = chars.get(j.characterId);
  if (!c) throw new Error("character was deleted");
  const a = ACTIONS.find((x) => x.name === j.action);
  j.reverse = !!(a && a.reverseOf);
  if (j.reverse) {
    const src = sourceJob(c.id, a.reverseOf);
    if (src) return deriveJob(j, src);
  }
  j.derivedFrom = null;
  const s = j.settings;
  beginJob(j);
  const comfy = new ComfyClient(config.comfyUrl);
  await comfy.ping();
  await waitForRam(j, comfy);

  const charPng = await fsp.readFile(path.join(charDir(c.id), "character.png"));
  const { png, layout } = await P.composeOnKey(charPng, s);
  await fsp.writeFile(path.join(jobDir(j.id), "input.png"), png);
  const uploaded = await comfy.uploadImage(png, `spriteforge_${j.id}.png`);

  let wfFile = j.loop && s.loopWorkflow ? s.loopWorkflow : s.workflow;
  if (!fs.existsSync(path.join(WF_DIR, wfFile))) wfFile = config.workflow; // job made with a workflow that was removed since
  const template = readJson(path.join(WF_DIR, wfFile));
  if (!template) throw new Error(`workflow ${wfFile} not found or not valid JSON`);
  const { workflow, report, outputNodeIds } = patchWorkflow(template, {
    image: uploaded, endImage: uploaded, positive: j.prompt, negative: j.negative,
    width: s.videoWidth, height: s.videoHeight, length: s.videoLength, seed: j.seed, prefix: `spriteforge/${j.id}`,
  });
  j.wfFile = wfFile;
  const { history, refresh } = await runComfy(j, comfy, workflow, { layout, workflowReport: report });

  refresh({ stage: "downloading frames", progress: band("frames", 0), stepsLeft: 0 }, true);
  const frames = await comfy.outputImages(history, outputNodeIds);
  const rawDir = path.join(jobDir(j.id), "raw");
  await fsp.mkdir(rawDir, { recursive: true });
  await Promise.all(frames.map((b, i) => fsp.writeFile(path.join(rawDir, `${String(i).padStart(3, "0")}.png`), b)));
  refresh({ rawCount: frames.length, stage: `keying & aligning ${frames.length} → ${j.frames} frames`, progress: band("frames", 0.5) }, true);
  await processJob(j);
  finishJob(j);
  await refreshDerived(j);
}

// FLUX Kontext: edits input.png (if the job has one) or generates from the prompt alone.
async function runImageJob(j) {
  beginJob(j);
  const comfy = new ComfyClient(config.comfyUrl);
  await comfy.ping();
  await waitForRam(j, comfy);
  const src = path.join(jobDir(j.id), "input.png");
  const uploaded = fs.existsSync(src) ? await comfy.uploadImage(await fsp.readFile(src), `spriteforge_img_${j.id}.png`) : null;
  j.wfFile = uploaded ? "kontext-edit" : "kontext-t2i";
  const { workflow, outputNodeIds } = buildKontextWorkflow({ image: uploaded, prompt: j.prompt, width: j.width, height: j.height,
    steps: j.sampleSteps, guidance: j.guidance, seed: j.seed, prefix: `spriteforge/img_${j.id}` });
  const { history, refresh } = await runComfy(j, comfy, workflow);
  refresh({ stage: "saving image", progress: band("frames", 0.5), stepsLeft: 0 }, true);
  const [img] = await comfy.outputImages(history, outputNodeIds);
  if (!img) throw new Error("ComfyUI returned no image");
  await fsp.writeFile(path.join(jobDir(j.id), "output.png"), img);
  const m = await sharp(img).metadata();
  j.outWidth = m.width; j.outHeight = m.height; j.version = (j.version || 0) + 1;
  if (j.part) await onPartImage(j, img); // Scene Kit: a completed sprite, a variation or a clean background
  if (j.attach) { // a view angle asked for on the Animate page joins the character's group
    const base = chars.get(j.attach.baseId);
    const c = await createCharacter(img, j.name, { view: j.attach.view, group: j.attach.group, description: base ? base.description : "" });
    j.attach.characterId = c.id;
  }
  finishJob(j);
}

// ---- video clip with sound (lib/clip.js): first frame -> speech -> video -> sound -> mux
const CLIP_SIZES = { landscape: [832, 480], portrait: [480, 832], square: [640, 640] }; // 480p, what Wan 2.2 A14B is tuned for
const CLIP_FLUX = { landscape: [1216, 704], portrait: [704, 1216], square: [1024, 1024] }; // first frame, same shape
const MMAUDIO_VRAM = 3.4 * GiB; // MMAudio's loader puts ~3.1 GB on the GPU; the staged sampler then peaks lower
const gbs = (b) => (b / GiB).toFixed(1);
const CLIP_WEIGHTS = { image: 3, speech: 1, video: 10, sound: 2, mux: 0.2 }; // rough share of the time (video per 49 frames), for the progress bar
const clipWeight = (j, name) => (name === "video" ? CLIP_WEIGHTS.video * (j.frames / 49) : name === "sound" ? CLIP_WEIGHTS.sound * CLIP.soundWindows(j.frames / CLIP.WAN_FPS).length : CLIP_WEIGHTS[name]);

async function runClipJob(j) {
  j.stagePrefix = ""; j.span = null;
  beginJob(j);
  const f = (name) => path.join(jobDir(j.id), name), has = (name) => fs.existsSync(f(name));
  const comfy = new ComfyClient(config.comfyUrl);
  await comfy.ping();
  await waitForRam(j, comfy);
  // stages whose output is already on disk are skipped (a job resumed after a restart picks up where it was)
  const plan = [!has("input.png") && "image", j.speech && !has("speech.flac") && "speech", !has("silent.mp4") && "video",
    j.sound && !has("sound.flac") && "sound", "mux"].filter(Boolean);
  const total = plan.reduce((a, st) => a + clipWeight(j, st), 0);
  let at = 0;
  const stage = async (name, label, fn) => {
    if (!plan.includes(name)) return;
    const t0 = Date.now();
    j.span = [at / total, Math.min(1, (at += clipWeight(j, name)) / total)];
    update(j, { stageName: name, stage: label, phase: "prepare", phaseStarts: { prepare: t0 }, progress: j.span[0], step: null, steps: null, stepsLeft: null, secPerStep: null });
    await fn();
    j.stageTimes = { ...(j.stageTimes || {}), [name]: Math.round((Date.now() - t0) / 1000) };
    if (name !== "mux") await comfy.free().catch(() => {}); // one model family on the GPU at a time
  };
  const fetchOne = async (history, nodeId, key) => {
    const item = ((history.outputs[nodeId] || {})[key] || [])[0];
    if (!item) throw new Error(`ComfyUI finished but saved no ${key === "gifs" ? "video" : key}.`);
    return comfy.view(item);
  };

  await stage("image", j.refs && j.refsMode === "combine" ? `combining ${j.refs} images into the first frame` : "drawing the first frame", async () => {
    const [w, h] = CLIP_FLUX[j.shape];
    const images = [];
    if (j.refs && j.refsMode === "combine")
      for (let i = 0; i < j.refs; i++) images.push(await comfy.uploadImage(await fsp.readFile(f(`ref_${i}.png`)), `spriteforge_clip_${j.id}_ref${i}.png`));
    const { workflow, outputNodeIds } = buildKontextWorkflow({ image: null, images, prompt: j.scene || j.prompt, width: w, height: h, steps: 20, guidance: 2.5, seed: j.seed, prefix: `spriteforge/clip_${j.id}` });
    const { history } = await runComfy(j, comfy, workflow);
    const [img] = await comfy.outputImages(history, outputNodeIds);
    await fsp.writeFile(f("input.png"), img);
  });

  await stage("speech", "speaking the line", async () => {
    const { workflow } = CLIP.speechGraph({ ...j.speech, seed: j.seed, prefix: `spriteforge/clip_${j.id}` });
    const { history } = await runComfy(j, comfy, workflow);
    await fsp.writeFile(f("speech.flac"), await fetchOne(history, "2", "audio"));
  });
  if (j.speech && has("speech.flac")) { // make the clip long enough for the line (up to MAX_SECONDS)
    const said = await CLIP.duration(f("speech.flac"));
    const need = j.speech.start + (said || 0) + 0.4;
    j.speechSeconds = said;
    if (j.fitSpeech && need > j.seconds && !has("silent.mp4")) j.frames = CLIP.framesFor(need);
    j.speechCut = said != null && need - 0.4 > j.frames / CLIP.WAN_FPS + 0.05;
    saveJob(j);
  }

  // Wan renders at most 5 s per pass: longer clips are chained, each part starting on the last frame of the one before.
  // Wan stays loaded between parts, and finished parts are kept, so a resumed job continues from the next part.
  await stage("video", `animating ${j.frames} frames`, async () => {
    const template = readJson(path.join(WF_DIR, config.workflow));
    if (!template) throw new Error(`workflow ${config.workflow} not found`);
    // keyframes: each stretch ends exactly on the next image; otherwise parts just continue from the last frame
    const keys = j.refs && j.refsMode === "keyframes" ? j.refs - 1 : 0;
    const [w, h] = CLIP_SIZES[j.shape], plan = CLIP.keyframePlan(j.frames, keys), parts = plan.map((x) => x.frames), [a, b] = j.span;
    j.wfFile = `clip-${config.workflow}`; j.parts = parts.length;
    for (const [i, frames] of parts.entries()) {
      const out = `part_${i}.mp4`;
      if (has(out)) continue;
      const start = i === 0 ? f("input.png") : await CLIP.frameAt(f(`part_${i - 1}.mp4`), parts[i - 1] - 1, f(`part_${i}_start.png`));
      const uploaded = await comfy.uploadImage(await fsp.readFile(start), `spriteforge_clip_${j.id}_${i}.png`);
      const endKey = plan[i].endKey, endImage = endKey ? await comfy.uploadImage(await fsp.readFile(f(`ref_${endKey}.png`)), `spriteforge_clip_${j.id}_key${endKey}.png`) : null;
      j.span = [a + ((b - a) * i) / parts.length, a + ((b - a) * (i + 1)) / parts.length];
      j.stagePrefix = parts.length > 1 ? `part ${i + 1}/${parts.length} · ` : "";
      update(j, { part: i + 1, phase: "prepare", phaseStarts: { prepare: Date.now() }, stage: `${j.stagePrefix}animating ${frames} frames${endKey ? ` to image ${endKey + 1}` : ""}` });
      const { workflow, outputNodeIds } = CLIP.videoGraph(template, { image: uploaded, endImage, prompt: j.prompt, negative: j.negative, width: w, height: h,
        frames, seed: j.seed + i, prefix: `spriteforge/clip_${j.id}_${i}`, tile: j.tile });
      const { history } = await runComfy(j, comfy, workflow);
      await fsp.writeFile(f(out), await fetchOne(history, outputNodeIds[0], "gifs"));
    }
    j.stagePrefix = ""; j.span = [a, b];
    update(j, { stage: parts.length > 1 ? `joining ${parts.length} parts` : "saving the video" });
    await CLIP.joinParts(parts.map((_, i) => f(`part_${i}.mp4`)), f("silent.mp4"));
    for (const [i] of parts.entries()) for (const x of [`part_${i}.mp4`, `part_${i}_start.png`]) await fsp.rm(f(x), { force: true });
  });

  // MMAudio is trained on 8 s: longer clips get their sound in overlapping windows, crossfaded into one track
  await stage("sound", "making the sound", async () => {
    // MMAudio puts ~5 GB on the GPU at once and is not managed by ComfyUI, so it can't make room itself:
    // wait (up to 10 min) while other apps (browsers, Unity) hold the GPU memory it needs
    for (let t = 0; t < 200; t++) {
      const d = ((await comfy.ping()).devices || [])[0];
      if (!d || d.vram_free == null || d.vram_free >= MMAUDIO_VRAM) break;
      update(j, { stage: `waiting for GPU memory · ${gbs(d.vram_free)} GB free, the sound model needs ${gbs(MMAUDIO_VRAM)} GB · close apps using the GPU (browsers, Unity)` });
      await new Promise((r) => setTimeout(r, 3000));
    }
    update(j, { stage: "making the sound" });
    const uploaded = await comfy.uploadImage(await fsp.readFile(f("silent.mp4")), `spriteforge_clip_${j.id}.mp4`);
    const windows = CLIP.soundWindows((await CLIP.duration(f("silent.mp4"))) || j.frames / CLIP.WAN_FPS);
    const lowVram = await fetch(`${config.comfyUrl}/object_info/SpriteForgeMMAudioSampler`).then((r) => r.json()).then((o) => !!o.SpriteForgeMMAudioSampler).catch(() => false);
    const { workflow, outputNodeIds } = CLIP.soundGraph({ video: uploaded, windows, lowVram, portrait: j.shape === "portrait", prompt: j.sound.prompt, negative: j.sound.negative,
      seed: j.seed, prefix: `spriteforge/clip_${j.id}` });
    let history;
    try { ({ history } = await runComfy(j, comfy, workflow)); }
    catch (e) {
      if (/out of memory/i.test(e.message)) throw new Error("The sound model ran out of GPU memory (it needs about 5 GB free on the card). Close apps that use the GPU, such as browsers or Unity, then press Retry: the finished video is kept.");
      throw e;
    }
    const pieces = [];
    for (const [i, id] of outputNodeIds.entries()) { pieces.push(f(`sound_${i}.flac`)); await fsp.writeFile(pieces[i], await fetchOne(history, id, "audio")); }
    await CLIP.joinSound(pieces, f("sound.flac")); // the windows are kept (small) so a clip can be remixed without making them again
  });

  await stage("mux", "mixing the audio into the MP4", async () => {
    const seconds = (await CLIP.duration(f("silent.mp4"))) || j.frames / CLIP.WAN_FPS;
    if (!j.sound && !j.speech) await fsp.copyFile(f("silent.mp4"), f("final.mp4"));
    else await CLIP.mux({ video: f("silent.mp4"), sound: j.sound && f("sound.flac"), speech: j.speech && f("speech.flac"), out: f("final.mp4"), seconds,
      soundVolume: j.sound ? j.sound.volume : 1, speechVolume: j.speech ? j.speech.volume : 1, speechStart: j.speech ? j.speech.start : 0 });
    j.seconds = +seconds.toFixed(2);
  });
  j.version = (j.version || 0) + 1; j.file = f("final.mp4"); j.span = null;
  finishJob(j);
}

async function loadRaw(j) {
  const rawDir = path.join(jobDir(j.id), "raw");
  const files = (await fsp.readdir(rawDir)).filter((f) => f.endsWith(".png")).sort();
  return Promise.all(files.map((f) => fsp.readFile(path.join(rawDir, f))));
}

async function processJob(j) {
  const raw = await loadRaw(j);
  const s = j.settings;
  const { cells, indices } = await P.processFrames(raw, j.layout, s, j.key, { count: j.frames, loop: j.loop, range: j.range, reverse: !!j.reverse });
  const outDir = path.join(jobDir(j.id), "frames");
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });
  await Promise.all(cells.map(async (c, i) => fsp.writeFile(path.join(outDir, `${String(i).padStart(3, "0")}.png`), await P.toPng(c))));
  j.frameCount = cells.length; j.indices = indices; j.version = (j.version || 0) + 1;
  saveJob(j);
}

async function loadCells(j) {
  const dir = path.join(jobDir(j.id), "frames");
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".png")).sort();
  return Promise.all(files.map(async (f) => P.toRaw(await fsp.readFile(path.join(dir, f)))));
}

// ------------------------------------------------------------------ app
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public"), { setHeaders: (res) => res.set("Cache-Control", "no-cache") })); // UI updates show up without a hard refresh
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: String(e.message || e) }));

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders(); res.write("retry: 2000\n\n");
  if (lastStats) res.write(`event: stats\ndata: ${JSON.stringify(lastStats)}\n\n`);
  clients.add(res); syncStatsSampler();
  req.on("close", () => { clients.delete(res); syncStatsSampler(); });
});

app.get("/api/config", (req, res) => res.json({ config, workflows: fs.readdirSync(WF_DIR).filter((f) => f.endsWith(".json")) }));
app.post("/api/config", wrap(async (req, res) => {
  const b = req.body || {};
  const num = (k) => (b[k] != null && b[k] !== "" ? +b[k] : config[k]);
  config = {
    ...config, comfyUrl: b.comfyUrl || config.comfyUrl, workflow: b.workflow || config.workflow,
    loopWorkflow: b.loopWorkflow != null ? b.loopWorkflow : config.loopWorkflow,
    videoWidth: num("videoWidth"), videoHeight: num("videoHeight"), keyColor: b.keyColor || config.keyColor,
    charHeightFrac: num("charHeightFrac"), feetFrac: num("feetFrac"), centerFrac: num("centerFrac"),
    cellWidth: num("cellWidth"), cellHeight: num("cellHeight"), baselineY: num("baselineY"), charHeightPx: num("charHeightPx"),
  };
  let L = num("videoLength"); L = Math.max(5, Math.round((L - 1) / 4) * 4 + 1); config.videoLength = L; // 4k+1
  if (b.key) config.key = { ...config.key, ...b.key };
  writeJson(cfgPath, config);
  res.json({ config });
}));
app.post("/api/workflows", upload.single("file"), wrap(async (req, res) => {
  const wf = JSON.parse(req.file.buffer.toString("utf8"));
  if (wf.nodes && wf.links) throw new Error("That is the UI format. In ComfyUI use Workflow > Export (API) and upload that file.");
  patchWorkflow(wf, { image: "x.png", positive: "p", negative: "n", width: 480, height: 832, length: 33, seed: 1, prefix: "t" }); // validates
  const name = path.basename(req.file.originalname).replace(/[^\w.-]/g, "_");
  await fsp.writeFile(path.join(WF_DIR, name), JSON.stringify(wf, null, 1));
  res.json({ name });
}));
app.get("/api/status", async (req, res) => {
  try { const s = await new ComfyClient(config.comfyUrl).ping(); res.json({ ok: true, devices: (s.devices || []).map((d) => d.name) }); }
  catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
});
app.get("/api/actions", (req, res) => res.json({ actions: ACTIONS, fighterOrder: FIGHTER_ORDER }));

// characters
app.get("/api/characters", (req, res) => res.json([...chars.values()].sort((a, b) => a.created - b.created)));
const cleanName = (s, fb = "Character") => String(s || "").replace(/[^\w-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || fb;
const VIEWS = ["side", "front", "back"];
const groupOf = (c) => c.group || c.id;
async function createCharacter(buffer, name, { flip = false, description = "", view = "side", group = null } = {}) {
  const id = newId();
  await fsp.mkdir(charDir(id), { recursive: true });
  await fsp.writeFile(path.join(charDir(id), "original.png"), buffer);
  await fsp.writeFile(path.join(charDir(id), "character.png"), await P.normalizeCharacter(buffer, flip));
  const c = { id, name: cleanName(name), description, flip, view: VIEWS.includes(view) ? view : "side", group: group || id, version: 1, created: Date.now() };
  chars.set(id, c); saveChar(c); emit("character", c);
  return c;
}
// Only the image is needed; the name defaults to the file name.
app.post("/api/characters", upload.single("image"), wrap(async (req, res) => {
  if (!req.file) throw new Error("image required");
  const name = req.body.name || path.parse(req.file.originalname || "").name;
  res.json(await createCharacter(req.file.buffer, name, { flip: req.body.flip === "true", description: req.body.description || "", view: req.body.view }));
}));
// Make another view angle of a character with FLUX Kontext; when it finishes it joins the character's group.
app.post("/api/characters/:id/views", wrap(async (req, res) => {
  const c = chars.get(req.params.id); if (!c) throw new Error("character not found");
  const view = String((req.body && req.body.view) || "");
  const preset = IMAGE_PRESETS.find((p) => p.id === view); if (!VIEWS.includes(view) || !preset) throw new Error("unknown view");
  const pending = [...jobs.values()].find((x) => x.kind === "image" && x.attach && x.attach.group === groupOf(c) && x.attach.view === view && ["queued", "running"].includes(x.status));
  if (pending) return res.json(publicJob(pending));
  const id = newId();
  await fsp.mkdir(jobDir(id), { recursive: true });
  const src = await fsp.readFile(path.join(charDir(c.id), "original.png"));
  await fsp.writeFile(path.join(jobDir(id), "input.png"),
    await sharp(src).resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).png().toBuffer());
  const base = c.name.replace(/_(side|front|back)$/i, "");
  const j = { id, kind: "image", name: cleanName(`${base}_${view}`), prompt: preset.prompt, hasInput: true, width: 832, height: 1216,
    sampleSteps: 20, guidance: 2.5, seed: Math.floor(Math.random() * 2 ** 31), attach: { baseId: c.id, group: groupOf(c), view },
    status: "queued", progress: 0, stage: "queued", created: Date.now() };
  jobs.set(id, j); saveJob(j); emit("job", publicJob(j)); pump(); res.json(publicJob(j));
}));
app.patch("/api/characters/:id", wrap(async (req, res) => {
  const c = chars.get(req.params.id); if (!c) throw new Error("not found");
  if (req.body.name) c.name = cleanName(req.body.name);
  if (req.body.description != null) c.description = req.body.description;
  if (VIEWS.includes(req.body.view)) c.view = req.body.view;
  if (req.body.flip != null && !!req.body.flip !== !!c.flip) { // re-cut the character from the original upload
    c.flip = !!req.body.flip;
    const png = await P.normalizeCharacter(await fsp.readFile(path.join(charDir(c.id), "original.png")), c.flip);
    await fsp.writeFile(path.join(charDir(c.id), "character.png"), png);
    c.version = (c.version || 1) + 1;
  }
  saveChar(c); emit("character", c); res.json(c);
}));
app.delete("/api/characters/:id", wrap(async (req, res) => {
  for (const j of [...jobs.values()]) if (j.characterId === req.params.id && j.status !== "running") { jobs.delete(j.id); await fsp.rm(jobDir(j.id), { recursive: true, force: true }); }
  chars.delete(req.params.id); await fsp.rm(charDir(req.params.id), { recursive: true, force: true });
  emit("reload", {}); res.json({ ok: true });
}));
app.get("/api/characters/:id/image", (req, res) => res.sendFile(path.join(charDir(req.params.id), "character.png")));

// jobs
app.get("/api/jobs", (req, res) => res.json([...jobs.values()].filter((j) => !req.query.characterId || j.characterId === req.query.characterId).sort((a, b) => a.created - b.created).map(publicJob)));
app.post("/api/jobs", wrap(async (req, res) => {
  const { characterId, actions = [], frames, seed, extraPrompt, fps } = req.body;
  const c = chars.get(characterId); if (!c) throw new Error("character not found");
  const created = [];
  // In catalogue order, so Walk_Forward is made before Walk_Backward (which reuses its clip).
  for (const a of ACTIONS.filter((x) => actions.includes(x.name))) {
    const id = newId();
    await fsp.mkdir(jobDir(id), { recursive: true });
    const j = {
      id, characterId, action: a.name, set: a.set, loop: a.loop, fps: +fps || a.fps, frames: +frames || a.frames,
      seed: seed != null && seed !== "" ? +seed : Math.floor(Math.random() * 2 ** 31),
      prompt: buildPrompt(c, a, config.keyColor, extraPrompt), negative: NEGATIVE,
      settings: { ...config, key: undefined }, key: { ...config.key }, range: null,
      status: "queued", progress: 0, stage: "queued", created: Date.now() + created.length,
    };
    jobs.set(id, j); saveJob(j); emit("job", publicJob(j)); created.push(publicJob(j));
  }
  pump(); res.json(created);
}));
app.post("/api/jobs/:id/retry", wrap(async (req, res) => {
  const j = jobs.get(req.params.id); if (!j) throw new Error("not found");
  if (j.status === "running") throw new Error("job is running");
  if (j.kind === "clip") {
    // a failed clip carries on from the step that failed (finished steps are kept); a finished one is made fresh
    const fresh = j.status === "done" && !req.body.keepSeed;
    const again = fresh ? ["speech.flac", "silent.mp4", "sound.flac", "final.mp4", ...(j.ownImage ? [] : ["input.png"])] : [];
    if (fresh) again.push(...(await fsp.readdir(jobDir(j.id))).filter((x) => /^(part_|sound_)/.test(x)));
    for (const name of again) await fsp.rm(path.join(jobDir(j.id), name), { force: true });
    Object.assign(j, { status: "queued", progress: 0, stage: "queued", error: null, phase: null, eta: null, created: Date.now(), span: null,
      ...(fresh ? { frames: CLIP.framesFor(j.seconds0 || j.seconds), seed: Math.floor(Math.random() * 2 ** 31) } : {}) });
    saveJob(j); emit("job", publicJob(j)); pump(); return res.json(publicJob(j));
  }
  if (j.kind === "image") {
    Object.assign(j, { status: "queued", progress: 0, stage: "queued", error: null, phase: null, eta: null, created: Date.now(),
      seed: req.body.keepSeed ? j.seed : Math.floor(Math.random() * 2 ** 31), prompt: req.body.prompt || j.prompt });
    saveJob(j); emit("job", publicJob(j)); pump(); return res.json(publicJob(j));
  }
  const c = chars.get(j.characterId);
  const a = ACTIONS.find((x) => x.name === j.action);
  Object.assign(j, { status: "queued", progress: 0, stage: "queued", error: null, phase: null, eta: null, seed: req.body.keepSeed ? j.seed : Math.floor(Math.random() * 2 ** 31),
    prompt: req.body.prompt || buildPrompt(c, a, j.settings.keyColor, req.body.extraPrompt), created: Date.now(), range: null });
  await fsp.rm(path.join(jobDir(j.id), "raw"), { recursive: true, force: true });
  j.rawCount = 0;
  saveJob(j); emit("job", publicJob(j)); pump(); res.json(publicJob(j));
}));
app.delete("/api/jobs/:id", wrap(async (req, res) => {
  const j = jobs.get(req.params.id); if (!j) throw new Error("not found");
  if (j.status === "running") throw new Error("job is running; wait for it to finish");
  jobs.delete(j.id); await fsp.rm(jobDir(j.id), { recursive: true, force: true });
  emit("jobDeleted", { id: j.id }); res.json({ ok: true });
}));
// ---- RAM panel: which apps use RAM, and closing them to make room for ComfyUI
const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
app.get("/api/apps", wrap(async (req, res) => {
  const mem = await new ComfyClient(config.comfyUrl).memory();
  res.json({ apps: await listApps({ comfyPid: mem && mem.pid }), memory: mem });
}));
app.post("/api/apps/close", wrap(async (req, res) => {
  if (!isLocal(req)) throw new Error("Apps can only be closed from this PC.");
  const mem = await new ComfyClient(config.comfyUrl).memory();
  res.json(await closeApp(req.body && req.body.name, { force: !!(req.body && req.body.force), comfyPid: mem && mem.pid }));
}));

// ---- image studio (FLUX Kontext)
app.get("/api/image-presets", (req, res) => res.json(IMAGE_PRESETS));
// source: "none" (text to image) | "character" (characterId) | "image" (a previous result, imageJobId) | "upload" (file)
app.post("/api/images", upload.single("image"), wrap(async (req, res) => {
  const b = req.body || {};
  const prompt = String(b.prompt || "").trim(); if (!prompt) throw new Error("Write what you want to see.");
  let src = null, sourceLabel = "";
  if (b.source === "character") {
    const c = chars.get(b.characterId); if (!c) throw new Error("character not found");
    src = await fsp.readFile(path.join(charDir(c.id), "original.png")); sourceLabel = c.name;
  } else if (b.source === "image") {
    const ij = jobs.get(b.imageJobId); if (!ij || !ij.version) throw new Error("image not found");
    src = await fsp.readFile(path.join(jobDir(ij.id), "output.png")); sourceLabel = ij.name;
  } else if (b.source === "upload") {
    if (!req.file) throw new Error("choose an image to edit"); src = req.file.buffer; sourceLabel = path.parse(req.file.originalname || "").name;
  }
  const id = newId();
  await fsp.mkdir(jobDir(id), { recursive: true });
  // Kontext has no alpha channel: flatten transparent art onto white, cap the size
  if (src) await fsp.writeFile(path.join(jobDir(id), "input.png"),
    await sharp(src).resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).png().toBuffer());
  const snap = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v / 64) * 64));
  const j = {
    id, kind: "image", name: cleanName(b.name || (sourceLabel ? `${sourceLabel}_edit` : "Image"), "Image"), prompt, hasInput: !!src,
    width: snap(+b.width || 832, 512, 1536), height: snap(+b.height || 1216, 512, 1536),
    sampleSteps: Math.min(40, Math.max(4, +b.steps || 20)), guidance: +b.guidance || 2.5, // not "steps": that field is live progress
    seed: b.seed != null && b.seed !== "" ? +b.seed : Math.floor(Math.random() * 2 ** 31),
    status: "queued", progress: 0, stage: "queued", created: Date.now(),
  };
  jobs.set(id, j); saveJob(j); emit("job", publicJob(j)); pump(); res.json(publicJob(j));
}));
app.get("/api/jobs/:id/output", (req, res) => res.sendFile(path.join(jobDir(req.params.id), "output.png")));
app.get("/api/jobs/:id/input", (req, res) => res.sendFile(path.join(jobDir(req.params.id), "input.png")));
app.post("/api/jobs/:id/to-character", wrap(async (req, res) => {
  const j = jobs.get(req.params.id); if (!j || j.kind !== "image" || !j.version) throw new Error("image not ready");
  res.json(await createCharacter(await fsp.readFile(path.join(jobDir(j.id), "output.png")), (req.body && req.body.name) || j.name));
}));

// ---- video clips with sound. POST queues one; GET /api/clips/:id polls it (url + file when done).
// Body (JSON or multipart): prompt (the motion), scene (first frame when no image), image (file) | imageJobId |
// characterId, or several `images` with imagesMode combine (up to 3 references FLUX puts into the first frame) |
// keyframes (up to 7, the clip passes through them in order), seconds 1-30 (over 5 s: chained 5 s parts), shape landscape|portrait|square, sound {prompt, negative, volume} or soundPrompt,
// speech {text, speaker, language, instruct, start, volume, model} or speechText/speaker, fitSpeech, seed, tile, name.
const clipView = (j) => ({ ...publicJob(j), url: j.status === "done" ? `/api/clips/${j.id}/video?v=${j.version}` : null, file: j.status === "done" ? j.file : null,
  silentUrl: j.status === "done" ? `/api/clips/${j.id}/video?silent=1&v=${j.version}` : null });
const CLIP_REFS = { combine: 3, keyframes: 7 }; // Kontext keeps up to ~3 references apart; 7 keyframes = 6 stretches of 5 s in 30 s
app.post("/api/clips", upload.fields([{ name: "image", maxCount: 1 }, { name: "images", maxCount: 7 }]), wrap(async (req, res) => {
  const b = req.body || {};
  const obj = (v) => { if (!v) return null; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } };
  const prompt = String(b.prompt || "").trim(); if (!prompt) throw new Error("Describe what happens in the clip (prompt).");
  const file = req.files && req.files.image && req.files.image[0];
  // several images: "combine" = references FLUX Kontext puts into one first frame, "keyframes" = the clip passes through them in order
  let refs = (req.files && req.files.images) || [];
  const refsMode = b.imagesMode === "combine" ? "combine" : "keyframes";
  if (refs.length === 1 && !file) { req.files.image = refs; refs = []; } // one image is just the start frame
  if (refs.length > CLIP_REFS[refsMode]) throw new Error(refsMode === "combine" ? "Combine takes up to 3 images." : "Keyframes take up to 7 images.");
  let src = null, ownImage = false;
  if (refs.length && refsMode === "keyframes") { src = refs[0].buffer; ownImage = true; }
  else if (refs.length) ownImage = false; // combined first frame is drawn by FLUX
  else if (req.files && req.files.image && req.files.image[0]) { src = req.files.image[0].buffer; ownImage = true; }
  else if (b.imageJobId) { const ij = jobs.get(b.imageJobId); if (!ij || !ij.version) throw new Error("image not found"); src = await fsp.readFile(path.join(jobDir(ij.id), "output.png")); ownImage = true; }
  else if (b.characterId) { const c = chars.get(b.characterId); if (!c) throw new Error("character not found"); src = await fsp.readFile(path.join(charDir(c.id), "original.png")); ownImage = true; }
  const shape = CLIP_SIZES[b.shape] ? b.shape : "landscape";
  const keys = refs.length && refsMode === "keyframes" ? refs.length - 1 : 0;
  const seconds = Math.max(1, Math.min(CLIP.MAX_SECONDS, Math.max(+b.seconds || 3, keys * 1.5))); // at least 1.5 s from one keyframe to the next
  const soundIn = obj(b.sound) || (b.soundPrompt != null && b.soundPrompt !== "" ? { prompt: b.soundPrompt } : null);
  const speechIn = obj(b.speech) || (b.speechText ? { text: b.speechText, speaker: b.speaker, language: b.language, instruct: b.instruct } : null);
  const num = (v, d, lo, hi) => (v == null || v === "" || !Number.isFinite(+v) ? d : Math.max(lo, Math.min(hi, +v)));
  const sound = soundIn ? { prompt: String(soundIn.prompt || "").slice(0, 400), negative: String(soundIn.negative || "music, speech, voice").slice(0, 200), volume: num(soundIn.volume, 1, 0, 2) } : null;
  const speech = speechIn && String(speechIn.text || "").trim() ? { text: String(speechIn.text).trim().slice(0, 600), speaker: CLIP.SPEAKERS.includes(speechIn.speaker) ? speechIn.speaker : "Ryan",
    language: String(speechIn.language || "Auto"), instruct: String(speechIn.instruct || "").slice(0, 200), start: num(speechIn.start, 0.3, 0, 4), volume: num(speechIn.volume, 1, 0, 2),
    model: speechIn.model === "1.7B" ? "1.7B" : "0.6B" } : null;
  const id = newId();
  await fsp.mkdir(jobDir(id), { recursive: true });
  const frame = (buf) => { const [w, h] = CLIP_FLUX[shape]; return sharp(buf).rotate().resize(w, h, { fit: "cover" }).flatten({ background: "#ffffff" }).png().toBuffer(); };
  if (src) await fsp.writeFile(path.join(jobDir(id), "input.png"), await frame(src)); // Wan starts from this frame
  for (const [i, r] of refs.entries()) // keyframes are framed like the video; references keep their own shape
    await fsp.writeFile(path.join(jobDir(id), `ref_${i}.png`), refsMode === "keyframes" ? await frame(r.buffer)
      : await sharp(r.buffer).rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).png().toBuffer());
  const j = { id, kind: "clip", name: cleanName(b.name || prompt.split(/\s+/).slice(0, 4).join("_"), "Clip"), prompt, scene: String(b.scene || "").trim() || null,
    negative: String(b.negative || "blurry, distorted, low quality, jittery, flickering, static image"), shape, width: CLIP_SIZES[shape][0], height: CLIP_SIZES[shape][1],
    seconds, seconds0: seconds, frames: CLIP.framesFor(seconds), sound, speech, fitSpeech: b.fitSpeech !== false && b.fitSpeech !== "false", ownImage,
    refs: refs.length || 0, refsMode: refs.length ? refsMode : null,
    tile: num(b.tile, 128, 64, 512), seed: b.seed != null && b.seed !== "" ? +b.seed : Math.floor(Math.random() * 2 ** 31),
    status: "queued", progress: 0, stage: "queued", created: Date.now() };
  if (refs.length && refsMode === "combine" && !j.scene) // FLUX puts the references together into the first frame
    j.scene = `Combine the ${refs.length} reference images into one single picture: ${prompt}. Keep every person, creature and object exactly as it looks in its reference (same face, outfit, colors and art style), in one coherent scene with consistent lighting. Cinematic still frame, sharp focus.`;
  if (!src && !j.scene) j.scene = `${prompt}. Cinematic still frame, detailed, sharp focus.`; // text only: FLUX draws the first frame
  jobs.set(id, j); saveJob(j); emit("job", publicJob(j)); pump();
  res.json(clipView(j));
}));
app.get("/api/clips", (req, res) => res.json([...jobs.values()].filter((j) => j.kind === "clip").sort((a, b) => b.created - a.created).map(clipView)));
app.get("/api/clips/:id", (req, res) => { const j = jobs.get(req.params.id); if (!j || j.kind !== "clip") return res.status(404).json({ error: "clip not found" }); res.json(clipView(j)); });
app.get("/api/clips/:id/video", (req, res) => {
  const j = jobs.get(req.params.id); if (!j || j.kind !== "clip") return res.status(404).end();
  res.sendFile(path.join(jobDir(j.id), req.query.silent ? "silent.mp4" : "final.mp4"));
});
app.get("/api/clips/:id/frame", (req, res) => res.sendFile(path.join(jobDir(req.params.id), "input.png")));
app.get("/api/clips/:id/ref/:n", (req, res) => res.sendFile(path.join(jobDir(req.params.id), `ref_${Math.max(0, parseInt(req.params.n, 10) || 0)}.png`)));

app.get("/api/jobs/:id/raw/:n", (req, res) => res.sendFile(path.join(jobDir(req.params.id), "raw", `${String(+req.params.n).padStart(3, "0")}.png`)));
app.get("/api/jobs/:id/frame/:n", (req, res) => res.sendFile(path.join(jobDir(req.params.id), "frames", `${String(+req.params.n).padStart(3, "0")}.png`)));
app.post("/api/jobs/:id/process", wrap(async (req, res) => {
  const j = jobs.get(req.params.id); if (!j || !j.rawCount) throw new Error("no frames yet");
  const b = req.body || {};
  if (b.key) j.key = { ...j.key, ...b.key };
  if (b.frames) j.frames = Math.max(1, Math.min(64, +b.frames));
  if (b.fps) j.fps = Math.max(1, Math.min(60, +b.fps));
  j.range = b.range && (b.range.start != null || b.range.end != null) ? { start: b.range.start, end: b.range.end } : null;
  await processJob(j); saveJob(j); emit("job", publicJob(j)); res.json(publicJob(j));
  if (!j.derivedFrom) refreshDerived(j).catch(() => {});
}));
// Export background: transparent (default) or a solid colour.
const BACKGROUNDS = { transparent: null, dark: [24, 24, 32], white: [255, 255, 255], green: [0, 255, 0] };
const bgParam = (q) => (q.bg in BACKGROUNDS ? BACKGROUNDS[q.bg] : null);
const animMeta = (j, cells) => Buffer.from(JSON.stringify({ name: j.action, fps: j.fps, loop: j.loop, frames: cells.length, cell: [cells[0].w, cells[0].h],
  pivot: [0.5, (j.settings.cellHeight - j.settings.baselineY) / j.settings.cellHeight] }, null, 1));
const onBg = async (j, bg) => (await loadCells(j)).map((c) => P.onBackground(c, bg));

/** Files for one animation in `fmt` (png = frames, gif, sheet, all = everything) inside folder `dir`. */
async function animFiles(j, fmt, bg, dir) {
  const cells = await onBg(j, bg), files = [];
  if (fmt === "png" || fmt === "all") for (const [i, x] of cells.entries()) files.push({ name: `${dir}/frame_${String(i).padStart(3, "0")}.png`, data: await P.toPng(x) });
  if (fmt === "sheet" || fmt === "all") files.push({ name: `${dir}/sheet.png`, data: await P.sheetPng(cells, Math.min(8, cells.length)) });
  if (fmt === "gif" || fmt === "all") files.push({ name: `${dir}/preview.gif`, data: P.gifBuffer(cells, j.fps, bg) });
  files.push({ name: `${dir}/animation.json`, data: animMeta(j, cells) });
  return files;
}

app.get("/api/jobs/:id/export/:fmt", wrap(async (req, res) => {
  const j = jobs.get(req.params.id); if (!j || !j.frameCount) throw new Error("no frames yet");
  const c = chars.get(j.characterId) || { name: "character" };
  const bg = bgParam(req.query), base = `${c.name}-${j.action}`;
  if (req.params.fmt === "gif") return res.attachment(`${base}.gif`).send(P.gifBuffer(await onBg(j, bg), j.fps, bg));
  if (req.params.fmt === "sheet") return res.attachment(`${base}_sheet.png`).send(await P.sheetPng(await onBg(j, bg), Math.min(8, j.frameCount)));
  res.attachment(`${base}.zip`).send(await P.zipBuffer(await animFiles(j, req.params.fmt === "png" ? "png" : "all", bg, base)));
}));

/** Latest finished job per action for a character, in fighter order. `only` limits it to those action names. */
function finishedAnims(cid, only) {
  const latest = {};
  for (const j of [...jobs.values()].filter((x) => x.characterId === cid && x.status === "done" && x.frameCount).sort((a, b) => (a.finished || 0) - (b.finished || 0))) latest[j.action] = j;
  const order = [...FIGHTER_ORDER, ...ACTIONS.filter((a) => a.set !== "fighter").map((a) => a.name)];
  return order.filter((n) => latest[n] && (!only || only.includes(n))).map((n) => latest[n]);
}

// One click: every finished animation (or just ?actions=A,B) in one zip, a folder per animation.
app.get("/api/characters/:id/export/all", wrap(async (req, res) => {
  const c = chars.get(req.params.id); if (!c) throw new Error("not found");
  const only = req.query.actions ? String(req.query.actions).split(",").filter(Boolean) : null;
  const list = finishedAnims(c.id, only);
  if (!list.length) throw new Error("no finished animations to download yet");
  const bg = bgParam(req.query);
  if (req.query.format === "unity") {
    const anims = [];
    for (const j of list) anims.push({ name: j.action, fps: j.fps, loop: j.loop, cells: await onBg(j, bg) });
    return res.attachment(`${c.name}_Unity.zip`).send(await P.unityExport(c.name, anims, list[0].settings));
  }
  const fmt = ["png", "gif", "sheet", "all"].includes(req.query.format) ? req.query.format : "png";
  const files = [];
  for (const j of list) files.push(...(await animFiles(j, fmt, bg, `${c.name}-${j.action}`)));
  res.attachment(`${c.name}_${list.length}_animations.zip`).send(await P.zipBuffer(files));
}));
app.get("/api/characters/:id/export/unity", wrap(async (req, res) => {
  const c = chars.get(req.params.id); if (!c) throw new Error("not found");
  const done = [...jobs.values()].filter((j) => j.characterId === c.id && j.status === "done" && j.frameCount);
  const latest = {};
  for (const j of done.sort((a, b) => (a.finished || 0) - (b.finished || 0))) latest[j.action] = j;
  const order = [...FIGHTER_ORDER, ...ACTIONS.filter((a) => a.set !== "fighter").map((a) => a.name)];
  const anims = [];
  for (const name of order) if (latest[name]) { const j = latest[name]; anims.push({ name, fps: j.fps, loop: j.loop, cells: await loadCells(j) }); }
  if (!anims.length) throw new Error("no finished actions for this character yet");
  const s = anims.length ? latest[anims[0].name].settings : config;
  res.attachment(`${c.name}_Unity.zip`).send(await P.unityExport(c.name, anims, s));
}));

// ------------------------------------------------------------------ scene kit (landscape -> sprites)
// A scene is an uploaded picture split into sprites ("parts"). Finding and cutting out objects runs on
// the CPU here (lib/scene.js); completing or varying a sprite and cleaning the background are normal
// FLUX Kontext image jobs carrying `part: {sceneId, partId, variantId, mode}`.
const scenes = new Map();
for (const id of fs.readdirSync(dirs.scenes)) {
  const s = readJson(path.join(dirs.scenes, id, "meta.json"));
  if (!s) continue;
  if (["queued", "analyzing"].includes(s.status)) // interrupted by a restart
    Object.assign(s, { status: s.parts.length ? "ready" : "error", stage: null, error: s.parts.length ? null : "SpriteForge was restarted while finding objects. Press Find objects." });
  scenes.set(id, s);
}
const sceneDir = (id) => path.join(dirs.scenes, id);
const partFile = (s, pid, vid) => path.join(sceneDir(s.id), "parts", vid ? `${pid}_${vid}.png` : `${pid}.png`);
const saveScene = (s) => writeJson(path.join(sceneDir(s.id), "meta.json"), s);
let sceneEmitAt = 0;
function sceneUpdate(s, patch, force = true) {
  Object.assign(s, patch); saveScene(s);
  if (!force && Date.now() - sceneEmitAt < 250) return;
  sceneEmitAt = Date.now(); emit("scene", s);
}

/** The object finder and cut-out model stay under the whole-PC RAM limit too: wait for room like a job does. */
async function sceneRoom(bytes, stage) {
  const comfy = new ComfyClient(config.comfyUrl);
  for (;;) {
    const m = await comfy.memory();
    if (!m || !m.systemLimit || m.others == null) return; // no RAM guard: nothing to check
    const room = m.systemLimit - m.others; // ComfyUI shrinks to fit whatever this leaves
    if (room >= bytes + 0.3 * GiB) return;
    stage(`waiting for RAM · needs ${(bytes / GiB + 0.3).toFixed(1)} GB, ${Math.max(0, room / GiB).toFixed(1)} GB free under your ${(m.systemLimit / GiB).toFixed(0)} GB limit`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
const sceneWorker = new SceneWorker({ cacheDir: path.join(DATA, "models"), roomFor: sceneRoom }); // models run in a child process
let sceneChain = Promise.resolve();
/** Scene CPU work runs one task at a time (the models are shared); resolves with the task's result. */
function sceneTask(fn) { const p = sceneChain.then(fn); sceneChain = p.catch(() => {}); return p; }

const scenePicture = (s) => path.join(sceneDir(s.id), "original.png");

const catName = (label) => { const p = SC.plural(label); return p[0].toUpperCase() + p.slice(1); };
function partName(s, label) {
  const base = cleanName(label.replace(/\s+/g, "_"), "Object").replace(/^./, (c) => c.toUpperCase());
  for (let n = 1; ; n++) { const name = `${base}_${String(n).padStart(2, "0")}`; if (!s.parts.some((p) => p.name === name)) return name; }
}
/** Wide or huge pieces are background layers even when found as an "object" (a cliff found as "rock"). */
function partKind(label, r, s) {
  const big = r.w * r.h > s.w * s.h * 0.2 || r.w > s.w * 0.7;
  return SC.labelInfo(label).kind === "layer" || big ? "layer" : "prop";
}
const partDepth = (label, kind) => { const d = SC.labelInfo(label).depth; return kind === "layer" && d === 4 ? 2 : d; }; // an object-sized label on a huge piece sits with the mountains
const partPivot = (p) => (["cloud", "sky"].includes(SC.labelInfo(p.label).id) ? [0.5, 0.5] : [0.5, 0]); // Unity convention: 0,0 = bottom-left

async function storeParts(s, cut) {
  await fsp.mkdir(path.join(sceneDir(s.id), "parts"), { recursive: true });
  const added = [];
  for (const c of cut) {
    const id = newId(), kind = partKind(c.label, c, s);
    await fsp.writeFile(partFile(s, id), Buffer.from(c.png)); // from the worker it may arrive as a plain Uint8Array
    const p = { id, label: c.label, name: partName(s, c.label), kind, depth: partDepth(c.label, kind), score: +(c.score || 0).toFixed(2),
      source: c.source || "auto", x: c.x, y: c.y, w: c.w, h: c.h, hidden: c.hidden, cut: c.cut, inKit: true, version: 1, variants: [], created: Date.now() };
    s.parts.push(p); added.push(p);
  }
  return added;
}

/** Find `labels` in the picture and cut every object out. replace: start over; otherwise only new finds are added. */
async function analyzeScene(s, labels, { replace = false } = {}) {
  const stage = (text, f) => sceneUpdate(s, { status: "analyzing", stage: text, ...(f != null ? { progress: f } : {}) }, false);
  try {
    const skip = replace ? [] : s.parts.map((p) => [p.x, p.y, p.x + p.w, p.y + p.h]); // only new finds are added
    const cut = await sceneWorker.analyze(scenePicture(s), labels, { skip, stage });
    if (replace) await dropParts(s, [...s.parts]);
    const added = await storeParts(s, cut);
    sceneUpdate(s, { status: "ready", stage: null, progress: 1, error: null, labels: [...new Set([...(s.labels || []), ...labels])], analyzed: Date.now(),
      lastFind: { labels, added: added.length } });
    return added;
  } catch (e) {
    sceneUpdate(s, { status: s.parts.length ? "ready" : "error", stage: null, error: String(e.message || e) });
    throw e;
  }
}

/** Add an object by hand (a click = point, a drag = box). It is taken out of the sprites behind it. */
async function addPartByHand(s, prompt, label) {
  let r;
  try { r = await sceneWorker.add(scenePicture(s), prompt, label, (t) => sceneUpdate(s, { stage: t }, false)); }
  catch (e) { sceneUpdate(s, { stage: null }); throw e; }
  const { part: c, alpha } = r;
  if (!c) { sceneUpdate(s, { stage: null }); throw new Error("Nothing was found there. Try a box around the object."); }
  const kind = partKind(label, c, s), depth = partDepth(label, kind);
  for (const p of s.parts) {
    if (p.x >= c.x + c.w || c.x >= p.x + p.w || p.y >= c.y + c.h || c.y >= p.y + p.h) continue;
    if (!(p.depth < depth || (p.depth === depth && p.w * p.h > c.w * c.h * 1.5))) continue; // only what is behind it
    const left = await SC.carve({ png: await fsp.readFile(partFile(s, p.id)), x: p.x, y: p.y }, alpha, s.w);
    if (!left) continue;
    await fsp.writeFile(partFile(s, p.id), left.png);
    p.hidden = +(1 - (1 - p.hidden) * left.left).toFixed(3); p.version = (p.version || 1) + 1;
  }
  const [added] = await storeParts(s, [c]);
  sceneUpdate(s, { stage: null });
  return added;
}

/** Remove parts with their files; queued AI jobs for them go too (a running one just finds nothing to update). */
async function dropParts(s, list) {
  for (const p of list) {
    for (const v of p.variants) { await fsp.rm(partFile(s, p.id, v.id), { force: true }); await dropJob(v.jobId); }
    await fsp.rm(partFile(s, p.id), { force: true });
    s.parts = s.parts.filter((x) => x !== p);
  }
}
async function dropJob(id) {
  const j = id && jobs.get(id);
  if (!j || j.status === "running") return;
  jobs.delete(j.id); await fsp.rm(jobDir(j.id), { recursive: true, force: true }); emit("jobDeleted", { id: j.id });
}

/** Queue FLUX Kontext jobs that complete a sprite or draw `count` variations of it. */
async function queuePartAI(s, p, mode, hint, count) {
  // variations start from the completed sprite when there is one (it has no holes)
  const full = [...p.variants].reverse().find((v) => v.mode === "complete" && v.file);
  const from = mode === "variation" && full ? { file: partFile(s, p.id, full.id), x: full.place.x, y: full.place.y, scale: full.scale }
    : { file: partFile(s, p.id), x: p.x, y: p.y, scale: 1 };
  const png = await fsp.readFile(from.file), key = await SC.keyFor(png);
  const { png: input, geom } = await SC.kontextInput(png, mode === "complete" && !full ? p.cut : [], key);
  geom.s *= from.scale; // AI canvas px per picture px
  const prompt = mode === "complete" ? SC.kontextPrompt.complete(p.label, key) : SC.kontextPrompt.variation(p.label, hint, key);
  const made = [];
  for (let i = 0; i < count; i++) {
    const id = newId(), vid = newId();
    await fsp.mkdir(jobDir(id), { recursive: true });
    await fsp.writeFile(path.join(jobDir(id), "input.png"), input);
    const j = { id, kind: "image", name: `${s.name}_${p.name}_${mode === "complete" ? "full" : "variation"}`, prompt, hasInput: true, width: geom.W, height: geom.H,
      sampleSteps: 20, guidance: 2.5, seed: Math.floor(Math.random() * 2 ** 31),
      part: { sceneId: s.id, partId: p.id, variantId: vid, mode, hint: hint || "", key: key.name, geom, origin: { x: from.x, y: from.y } },
      status: "queued", progress: 0, stage: "queued", created: Date.now() + i };
    jobs.set(id, j); saveJob(j); emit("job", publicJob(j));
    p.variants.push({ id: vid, mode, hint: hint || "", jobId: id, inKit: true, created: Date.now() });
    made.push(publicJob(j));
  }
  sceneUpdate(s, {}); pump();
  return made;
}

/** A Kontext job for a scene finished: key the sprite out and put it back at the picture's scale. */
async function onPartImage(j, img) {
  const s = scenes.get(j.part.sceneId); if (!s) return;
  if (j.part.mode === "plate") {
    await fsp.writeFile(path.join(sceneDir(s.id), "plate.png"), await sharp(img).resize(s.w, s.h, { fit: "fill" }).png().toBuffer());
    return sceneUpdate(s, { plate: { jobId: j.id, version: ((s.plate && s.plate.version) || 0) + 1 } });
  }
  const p = s.parts.find((x) => x.id === j.part.partId), v = p && p.variants.find((x) => x.id === j.part.variantId);
  if (!v) return; // deleted while it was being made
  const k = await SC.keyOutput(img, j.part.key), place = SC.placeResult(k, j.part.geom, j.part.origin);
  let png = k.png, w = k.w, h = k.h;
  if (Math.max(w, h) > 1400) { const f = 1400 / Math.max(w, h); w = Math.round(w * f); h = Math.round(h * f); png = await sharp(png).resize(w, h).png().toBuffer(); }
  await fsp.writeFile(partFile(s, p.id, v.id), png);
  Object.assign(v, { file: true, w, h, jobId: j.id, place: { x: place.x, y: place.y, w: place.w, h: place.h }, scale: +(w / place.w).toFixed(4), version: (v.version || 0) + 1 });
  sceneUpdate(s, {});
}

// ---- kit export
/** Everything ticked for the kit (plus sprites a painted layout uses), back to front, with names and pivots. */
async function kitSprites(s, layout) {
  const used = new Set(((layout && layout.items) || []).map((it) => it.k)), out = [];
  const parts = [...s.parts].sort((a, b) => a.depth - b.depth || a.y + a.h - (b.y + b.h));
  for (const p of parts) {
    const base = { category: catName(p.label), kind: p.kind, label: p.label, pivot: partPivot(p) };
    if (p.inKit || used.has(p.id)) out.push({ ...base, key: p.id, name: p.name, file: partFile(s, p.id), w: p.w, h: p.h, x: p.x, y: p.y, pw: p.w, ph: p.h, scale: 1, source: "picture" });
    let nFull = 0, nVar = 0;
    for (const v of p.variants.filter((x) => x.file)) {
      const name = v.mode === "complete" ? `${p.name}_Full${++nFull > 1 ? nFull : ""}` : `${p.name}_Var${++nVar}`, key = `${p.id}.${v.id}`;
      if (v.inKit || used.has(key)) out.push({ ...base, key, name, file: partFile(s, p.id, v.id), w: v.w, h: v.h, x: v.place.x, y: v.place.y, pw: v.place.w, ph: v.place.h,
        scale: v.scale, source: v.mode, hiddenLayer: true });
    }
  }
  for (const [i, sp] of out.entries()) { sp.order = i; sp.png = await fsp.readFile(sp.file); }
  return out;
}

/** Layouts for engines: pivot position in picture px (y down), scale on top of the sprite's own `scale`. */
function kitLayouts(s, sprites, layout) {
  const byKey = new Map(sprites.map((sp) => [sp.key, sp]));
  const at = (sp, x, y, dw, dh) => ({ x: +(x + dw * sp.pivot[0]).toFixed(1), y: +(y + dh * (1 - sp.pivot[1])).toFixed(1) });
  const out = [{ name: "Original", width: s.w, height: s.h, items: sprites.filter((sp) => sp.source === "picture")
    .map((sp) => ({ sprite: sp.name, ...at(sp, sp.x, sp.y, sp.pw, sp.ph), scale: 1, flip: false, order: sp.order })) }];
  if (layout && layout.items && layout.items.length) out.push({ name: "Painted", width: layout.w || s.w, height: layout.h || s.h,
    items: layout.items.filter((it) => byKey.has(it.k)).map((it, i) => { const sp = byKey.get(it.k); return { sprite: sp.name, ...at(sp, it.x, it.y, sp.pw * it.s, sp.ph * it.s), scale: it.s, flip: !!it.f, order: i }; }) });
  return out;
}

const readLayout = (s) => readJson(path.join(sceneDir(s.id), "layout.json"), null);
async function readRaw(file) { const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height }; }

/** Files for one export format: png | sheet | unity | psd | svg. Returns {name, data} or {zip: [...files]}. */
async function sceneExport(s, format) {
  const layout = readLayout(s), sprites = await kitSprites(s, layout), N = s.name;
  if (!sprites.length) throw new Error("Nothing is ticked for the kit yet.");
  const platePath = path.join(sceneDir(s.id), "plate.png"), plate = s.plate && s.plate.version && fs.existsSync(platePath) ? platePath : null;
  const meta = (extra) => ({ scene: N, width: s.w, height: s.h, pixelsPerUnit: 100, ...extra, layouts: kitLayouts(s, sprites, layout) });
  const frame = (sp) => ({ name: sp.name, category: sp.category, kind: sp.kind, pivot: sp.pivot, order: sp.order, scale: sp.scale, source: sp.source });
  if (format === "psd" || format === "svg") {
    // layers sit where the object was in the picture; AI versions are added as hidden layers scaled to match
    const placed = await Promise.all(sprites.map(async (sp) => {
      const w = Math.max(1, Math.round(sp.pw)), h = Math.max(1, Math.round(sp.ph));
      const png = sp.scale === 1 ? sp.png : await sharp(sp.png).resize(w, h).png().toBuffer();
      return { ...sp, png, x: Math.round(sp.x), y: Math.round(sp.y), w, h, raw: format === "psd" ? await readRaw(png) : null };
    }));
    const original = path.join(sceneDir(s.id), "original.png");
    if (format === "psd") return { name: `${N}_Layers.psd`, data: SC.psdFile(s, await readRaw(original), placed, plate && (await readRaw(plate))) };
    return { name: `${N}_Layers.svg`, data: SC.svgFile(s, { w: s.w, h: s.h }, placed, await fsp.readFile(original), plate && (await fsp.readFile(plate))) };
  }
  if (format === "sheet" || format === "unity") {
    const { files, frames } = await SC.sheets(N, sprites);
    const byName = new Map(sprites.map((sp) => [sp.name, sp]));
    const json = meta({ sheets: files.map((f) => f.name), sprites: frames.map((f) => ({ ...frame(byName.get(f.name)), sheet: f.sheet, x: f.x, y: f.y, w: f.w, h: f.h, scale: +f.scale.toFixed(4) })) });
    if (format === "sheet") return { zip: [...files, { name: `${N}_Sheet.json`, data: Buffer.from(JSON.stringify(json, null, 1)) }], name: `${N}_SpriteSheet.zip` };
    const dir = `Assets/SpriteForge/SceneKits/${N}`;
    return { name: `${N}_Unity_SceneKit.zip`, zip: [
      ...files.map((f) => ({ name: `${dir}/${f.name}`, data: f.data })),
      { name: `${dir}/${N}_SceneKit.json`, data: Buffer.from(JSON.stringify(json, null, 1)) },
      { name: "Assets/SpriteForge/Editor/SpriteForgeSceneKit.cs", data: SC.unityScript() },
      { name: "README_Unity.txt", data: Buffer.from(UNITY_README(N)) },
    ] };
  }
  const json = meta({ sprites: sprites.map((sp) => ({ ...frame(sp), file: `Sprites/${sp.category}/${sp.name}.png`, w: sp.w, h: sp.h })) });
  return { name: `${N}_Sprites.zip`, zip: [...sprites.map((sp) => ({ name: `${N}/Sprites/${sp.category}/${sp.name}.png`, data: sp.png })),
    { name: `${N}/${N}_Kit.json`, data: Buffer.from(JSON.stringify(json, null, 1)) }] };
}
const UNITY_README = (N) => `SpriteForge Scene Kit: ${N}

1. Extract this zip into your Unity project folder (the one that contains "Assets"),
   or in Unity use Tools > SpriteForge > Import Scene Kit... and pick this zip.
2. Unity builds the kit by itself (Tools > SpriteForge > Rebuild Scene Kits does it again):
   Assets/SpriteForge/SceneKits/${N}/
     ${N}_Sheet_N.png        sliced into one sprite per object
     Tiles/                  a Tile per sprite
     ${N}_Palette.prefab     Window > 2D > Tile Palette > pick "${N}_Palette", choose a sprite, paint
     Prefabs/                a prefab per sprite (drag in, or use the Prefab Brush)
     ${N}_Original.prefab    the picture rebuilt from its sprites
     ${N}_Painted.prefab     the scene you painted in SpriteForge (if you painted one)
Sprites that stand on the ground have their pivot at the base, clouds in the middle. 100 pixels per unit.
`;

// ---- routes
app.get("/api/scene-labels", (req, res) => res.json({ labels: SC.LABELS, hints: SC.VARIATION_HINTS }));
app.get("/api/scenes", (req, res) => res.json([...scenes.values()].sort((a, b) => a.created - b.created)));
const findScene = (id) => { const s = scenes.get(id); if (!s) throw new Error("scene not found"); return s; };
const findPart = (s, pid) => { const p = s.parts.find((x) => x.id === pid); if (!p) throw new Error("that sprite was deleted"); return p; };
function parseLabels(v) {
  let list = v; if (typeof v === "string") { try { list = JSON.parse(v); } catch { list = v.split(","); } }
  list = (Array.isArray(list) ? list : []).map((l) => String(l).toLowerCase().replace(/[^a-z \-]/g, "").replace(/\s+/g, " ").trim().slice(0, 30)).filter(Boolean);
  return [...new Set(list)].slice(0, 24);
}
function startFind(s, labels, opts) {
  if (!labels.length) throw new Error("Pick at least one thing to look for.");
  if (["queued", "analyzing"].includes(s.status)) throw new Error("Already looking for objects in this picture.");
  sceneUpdate(s, { status: "queued", stage: "waiting to start", progress: 0, error: null });
  sceneTask(() => analyzeScene(s, labels, opts)).catch((e) => console.error("scene", s.id, e.message));
}
app.post("/api/scenes", upload.single("image"), wrap(async (req, res) => {
  if (!req.file) throw new Error("image required");
  const id = newId();
  await fsp.mkdir(path.join(sceneDir(id), "parts"), { recursive: true });
  const png = await sharp(req.file.buffer).rotate().resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const m = await sharp(png).metadata();
  await fsp.writeFile(path.join(sceneDir(id), "original.png"), png);
  const s = { id, name: cleanName(req.body.name || path.parse(req.file.originalname || "").name, "Scene"), w: m.width, h: m.height,
    status: "new", stage: null, progress: 0, labels: [], parts: [], plate: null, version: 1, created: Date.now() };
  scenes.set(id, s); saveScene(s); emit("scene", s);
  const labels = parseLabels(req.body.labels);
  startFind(s, labels.length ? labels : SC.LABELS.filter((l) => l.on).map((l) => l.id), {});
  res.json(s);
}));
app.post("/api/scenes/:id/find", wrap(async (req, res) => {
  const s = findScene(req.params.id);
  startFind(s, parseLabels(req.body.labels), { replace: !!req.body.replace });
  res.json(s);
}));
app.patch("/api/scenes/:id", wrap(async (req, res) => {
  const s = findScene(req.params.id);
  if (req.body.name) sceneUpdate(s, { name: cleanName(req.body.name, s.name) });
  res.json(s);
}));
app.delete("/api/scenes/:id", wrap(async (req, res) => {
  const s = findScene(req.params.id);
  if (["queued", "analyzing"].includes(s.status)) throw new Error("It is still looking for objects; wait for it to finish.");
  for (const j of [...jobs.values()]) if (j.part && j.part.sceneId === s.id) await dropJob(j.id);
  scenes.delete(s.id);
  await fsp.rm(sceneDir(s.id), { recursive: true, force: true });
  emit("sceneDeleted", { id: s.id }); res.json({ ok: true });
}));
app.get("/api/scenes/:id/image", (req, res) => res.sendFile(path.join(sceneDir(req.params.id), "original.png")));
app.get("/api/scenes/:id/plate", (req, res) => res.sendFile(path.join(sceneDir(req.params.id), "plate.png")));
app.get("/api/scenes/:id/sprite/:key", (req, res) => {
  const [pid, vid] = String(req.params.key).split(".");
  if (!/^\w+$/.test(pid) || (vid && !/^\w+$/.test(vid))) return res.status(400).end();
  res.sendFile(partFile({ id: req.params.id }, pid, vid));
});
// add an object by hand: {box:[x0,y0,x1,y1]} or {points:[[x,y]], negative:[[x,y]]}, plus its label
app.post("/api/scenes/:id/parts", wrap(async (req, res) => {
  const s = findScene(req.params.id), b = req.body || {};
  const label = parseLabels([b.label || "object"])[0] || "object";
  const num = (a, n) => Array.isArray(a) && a.length === n && a.every((v) => Number.isFinite(+v));
  let prompt;
  if (num(b.box, 4)) { const bx = SC.clampBox(b.box.map(Number), s.w, s.h); if (bx[2] - bx[0] < 4 || bx[3] - bx[1] < 4) throw new Error("That box is too small."); prompt = { box: bx }; }
  else if (Array.isArray(b.points) && b.points.length && b.points.every((p) => num(p, 2))) prompt = { points: b.points.slice(0, 8), negative: (b.negative || []).filter((p) => num(p, 2)).slice(0, 8) };
  else throw new Error("Click on an object or drag a box around it.");
  res.json(await sceneTask(() => addPartByHand(s, prompt, label)));
}));
app.patch("/api/scenes/:id/parts/:pid", wrap(async (req, res) => {
  const s = findScene(req.params.id), p = findPart(s, req.params.pid), b = req.body || {};
  if (b.label) { const l = parseLabels([b.label])[0]; if (l && l !== p.label) { p.label = l; p.name = partName(s, l); p.depth = partDepth(l, p.kind); } }
  if (b.inKit != null) p.inKit = !!b.inKit;
  if (b.variant) { const v = p.variants.find((x) => x.id === b.variant.id); if (v && b.variant.inKit != null) v.inKit = !!b.variant.inKit; }
  sceneUpdate(s, {}); res.json(p);
}));
app.delete("/api/scenes/:id/parts/:pid", wrap(async (req, res) => {
  const s = findScene(req.params.id); await dropParts(s, [findPart(s, req.params.pid)]); sceneUpdate(s, {}); res.json({ ok: true });
}));
app.delete("/api/scenes/:id/parts/:pid/variants/:vid", wrap(async (req, res) => {
  const s = findScene(req.params.id), p = findPart(s, req.params.pid), v = p.variants.find((x) => x.id === req.params.vid);
  if (!v) throw new Error("not found");
  const j = jobs.get(v.jobId); if (j && j.status === "running") throw new Error("It is being made right now; delete it when it's done.");
  await dropJob(v.jobId); await fsp.rm(partFile(s, p.id, v.id), { force: true });
  p.variants = p.variants.filter((x) => x !== v); sceneUpdate(s, {}); res.json({ ok: true });
}));
app.post("/api/scenes/:id/parts/:pid/ai", wrap(async (req, res) => {
  const s = findScene(req.params.id), p = findPart(s, req.params.pid), b = req.body || {};
  const mode = b.mode === "variation" ? "variation" : "complete";
  const hint = String(b.hint || "").replace(/\s+/g, " ").trim().slice(0, 160);
  res.json(await queuePartAI(s, p, mode, hint, mode === "complete" ? 1 : Math.max(1, Math.min(4, +b.count || 1))));
}));
// the picture with every object removed (FLUX Kontext), used behind a painted scene and in PSD/SVG exports
app.post("/api/scenes/:id/plate", wrap(async (req, res) => {
  const s = findScene(req.params.id);
  if (s.plate && s.plate.jobId && jobs.get(s.plate.jobId) && isBusy(jobs.get(s.plate.jobId))) throw new Error("The clean background is already being made.");
  const things = [...new Set(s.parts.filter((p) => p.kind === "prop").map((p) => SC.plural(p.label)))];
  if (!things.length) throw new Error("There are no objects to remove from this picture.");
  const list = things.length > 1 ? `${things.slice(0, -1).join(", ")} and ${things.at(-1)}` : things[0];
  const id = newId();
  await fsp.mkdir(jobDir(id), { recursive: true });
  await fsp.writeFile(path.join(jobDir(id), "input.png"), await sharp(path.join(sceneDir(s.id), "original.png")).flatten({ background: "#ffffff" }).png().toBuffer());
  const j = { id, kind: "image", name: `${s.name}_background`, prompt: SC.kontextPrompt.plate(list), hasInput: true, width: s.w, height: s.h, sampleSteps: 20, guidance: 2.5,
    seed: Math.floor(Math.random() * 2 ** 31), part: { sceneId: s.id, mode: "plate" }, status: "queued", progress: 0, stage: "queued", created: Date.now() };
  jobs.set(id, j); saveJob(j); emit("job", publicJob(j));
  sceneUpdate(s, { plate: { ...(s.plate || {}), jobId: id } }); pump();
  res.json(publicJob(j));
}));
const isBusy = (j) => j.status === "queued" || j.status === "running";
app.get("/api/scenes/:id/layout", (req, res) => res.json(readLayout(findScene(req.params.id)) || { items: [] }));
app.put("/api/scenes/:id/layout", wrap(async (req, res) => {
  const s = findScene(req.params.id), b = req.body || {};
  const keys = new Set(s.parts.flatMap((p) => [p.id, ...p.variants.map((v) => `${p.id}.${v.id}`)]));
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 20000).filter((it) => it && keys.has(it.k))
    .map((it) => ({ k: it.k, x: +(+it.x).toFixed(1) || 0, y: +(+it.y).toFixed(1) || 0, s: Math.max(0.02, Math.min(20, +it.s || 1)), f: !!it.f }));
  const layout = { w: +b.w || s.w, h: +b.h || s.h, bg: ["picture", "plate", "sky", "none"].includes(b.bg) ? b.bg : "sky", items, saved: Date.now() };
  writeJson(path.join(sceneDir(s.id), "layout.json"), layout);
  sceneUpdate(s, { layoutAt: layout.saved, layoutCount: items.length }); res.json({ ok: true, saved: layout.saved });
}));
app.get("/api/scenes/:id/export", wrap(async (req, res) => {
  const s = findScene(req.params.id);
  const format = ["png", "sheet", "unity", "psd", "svg"].includes(req.query.format) ? req.query.format : "png";
  const out = await sceneExport(s, format);
  res.attachment(out.name).send(out.zip ? await P.zipBuffer(out.zip) : out.data);
}));

// ------------------------------------------------------------------ NFT collection generator
const NFT_DIR = path.join(ROOT, "nft");
const nftConfig = () => JSON.parse(fs.readFileSync(path.join(NFT_DIR, "config.json"), "utf8"));
const nftTraitsPath = () => path.join(NFT_DIR, "traits.json");
const nftOutputDir = () => path.join(ROOT, nftConfig().outputDir || "nft/output");
const nftCombosPath = () => path.join(nftOutputDir(), "combos.json");
const nftImagesDir = () => path.join(nftOutputDir(), "images");

let nftRunning = null; // { abort, promise } — one generation at a time

app.get("/api/nft/config", (req, res) => res.json(nftConfig()));
app.post("/api/nft/config", wrap(async (req, res) => {
  const cur = nftConfig();
  const merged = { ...cur, ...req.body };
  writeJson(path.join(NFT_DIR, "config.json"), merged);
  res.json(merged);
}));
app.get("/api/nft/traits", (req, res) => res.json(JSON.parse(fs.readFileSync(nftTraitsPath(), "utf8"))));
app.post("/api/nft/traits", wrap(async (req, res) => {
  writeJson(nftTraitsPath(), req.body);
  res.json(req.body);
}));

app.get("/api/nft/analyze/status", wrap(async (req, res) => {
  const { ollamaAvailable } = require("./nft/analyze");
  res.json({ available: await ollamaAvailable() });
}));
app.post("/api/nft/analyze", wrap(async (req, res) => {
  const description = req.body.description;
  if (!description || description.trim().length < 5) throw new Error("Describe your base character (at least a few words).");
  const { generateTraitsFromDescription, saveTraits } = require("./nft/analyze");
  const result = await generateTraitsFromDescription(description.trim());
  await saveTraits(result.traits, nftTraitsPath());
  res.json({ traits: result.traits, baseDescription: result.baseDescription });
}));

app.post("/api/nft/combos", wrap(async (req, res) => {
  const { generateCombos, maxCombos } = require("./nft/combos");
  const count = +(req.body.count || 100);
  const seed = +(req.body.seed || 42);
  const max = maxCombos(nftTraitsPath());
  if (count > max) throw new Error(`Requested ${count} but only ${max} unique combinations possible.`);
  const combos = generateCombos({ count, seed, traitsPath: nftTraitsPath(), outputPath: nftCombosPath() });
  res.json({ combos, max });
}));
app.get("/api/nft/combos", wrap(async (req, res) => {
  if (!fs.existsSync(nftCombosPath())) return res.json({ combos: [] });
  res.json({ combos: JSON.parse(await fsp.readFile(nftCombosPath(), "utf8")) });
}));

app.post("/api/nft/generate", upload.single("base"), wrap(async (req, res) => {
  if (nftRunning) throw new Error("A generation is already running.");
  if (!fs.existsSync(nftCombosPath())) throw new Error("Generate combinations first.");
  const baseTmp = path.join(nftOutputDir(), "base.png");
  await fsp.mkdir(nftOutputDir(), { recursive: true });
  if (req.file) await fsp.writeFile(baseTmp, req.file.buffer);
  else if (req.body.basePath && fs.existsSync(req.body.basePath)) await fsp.copyFile(req.body.basePath, baseTmp);
  if (!fs.existsSync(baseTmp)) throw new Error("Base image required. Upload one first.");
  const preview = req.body.preview === "true" || req.body.preview === true;
  const config = nftConfig();
  const ac = new AbortController();
  const { generateImages, generatePreview } = require("./nft/generate");
  const fn = preview ? generatePreview : generateImages;
  const promise = fn({
    basePath: baseTmp, combosPath: nftCombosPath(), outputDir: nftImagesDir(), config,
    onProgress: (p) => emit("nft", { type: "progress", ...p }),
    onError: (id, e) => emit("nft", { type: "error", id, error: e.message }),
    signal: ac.signal,
  }).then((result) => {
    nftRunning = null;
    emit("nft", { type: "done", ...result });
    return result;
  }).catch((e) => {
    nftRunning = null;
    emit("nft", { type: "done", error: e.message });
  });
  nftRunning = { abort: () => ac.abort(), promise };
  res.json({ started: true, preview });
}));

app.post("/api/nft/stop", wrap(async (req, res) => {
  if (nftRunning) nftRunning.abort();
  nftRunning = null;
  res.json({ stopped: true });
}));
app.get("/api/nft/status", (req, res) => {
  const imDir = nftImagesDir();
  let generated = 0;
  try { generated = fs.readdirSync(imDir).filter(f => f.endsWith(".png")).length; } catch {}
  res.json({ running: !!nftRunning, generated });
});

app.post("/api/nft/reject", wrap(async (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids) || !ids.length) throw new Error("ids array required");
  const { loadCombos, rejectCombo } = require("./nft/combos");
  const combos = loadCombos(nftCombosPath());
  for (const id of ids) {
    rejectCombo(combos, id);
    const img = path.join(nftImagesDir(), `${id}.png`);
    if (fs.existsSync(img)) fs.unlinkSync(img);
  }
  writeJson(nftCombosPath(), combos);
  res.json({ rejected: ids.length });
}));

app.post("/api/nft/metadata", wrap(async (req, res) => {
  const { generateMetadata, generateRarity } = require("./nft/metadata");
  const config = nftConfig();
  const result = await generateMetadata({ combosPath: nftCombosPath(), outputDir: nftOutputDir(), config });
  const rarity = generateRarity({ combosPath: nftCombosPath(), outputDir: nftOutputDir() });
  res.json({ count: result.count, rarity });
}));

app.post("/api/nft/set-cid", wrap(async (req, res) => {
  const cid = req.body.cid;
  if (!cid) throw new Error("cid required");
  const { setCid } = require("./nft/metadata");
  const result = await setCid({ combosPath: nftCombosPath(), outputDir: nftOutputDir(), cid });
  const cfg = nftConfig(); cfg.imagesCid = cid;
  writeJson(path.join(NFT_DIR, "config.json"), cfg);
  res.json(result);
}));

app.post("/api/nft/finalize", wrap(async (req, res) => {
  const { finalize } = require("./nft/finalize");
  const { generateMetadata, generateRarity } = require("./nft/metadata");
  const result = await finalize({ combosPath: nftCombosPath(), outputDir: nftOutputDir() });
  const config = nftConfig();
  await generateMetadata({ combosPath: nftCombosPath(), outputDir: nftOutputDir(), config });
  generateRarity({ combosPath: nftCombosPath(), outputDir: nftOutputDir() });
  res.json(result);
}));

app.get("/api/nft/rarity", wrap(async (req, res) => {
  const rarityPath = path.join(nftOutputDir(), "rarity.json");
  if (!fs.existsSync(rarityPath)) { const { generateRarity } = require("./nft/metadata"); generateRarity({ combosPath: nftCombosPath(), outputDir: nftOutputDir() }); }
  res.json(JSON.parse(await fsp.readFile(rarityPath, "utf8")));
}));

app.get("/api/nft/image/:id", (req, res) => {
  const f = path.join(nftImagesDir(), `${req.params.id}.png`);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});
app.post("/api/nft/base", upload.single("base"), wrap(async (req, res) => {
  if (!req.file) throw new Error("No file uploaded.");
  const outDir = nftOutputDir();
  await fsp.mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, "base.png");
  await fsp.writeFile(dest, req.file.buffer);
  res.json({ ok: true });
}));
app.get("/api/nft/base", (req, res) => {
  const f = path.join(nftOutputDir(), "base.png");
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

app.listen(PORT, (err) => {
  if (err) { // Express 5 reports a busy port here; without this the server would print "running" and quietly exit
    console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is already in use by another program. Close it or start with PORT=<another port>.` : err);
    process.exit(1);
  }
  console.log(`SpriteForge running at http://localhost:${PORT}  (ComfyUI: ${config.comfyUrl})`);
  pump();
});
