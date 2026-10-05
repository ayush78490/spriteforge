// Scene Kit: break a landscape picture into reusable sprites.
// Finding objects (Grounding DINO) and cutting them out (SAM 2.1) run on the CPU inside this Node
// process, so they never compete with ComfyUI for VRAM. FLUX Kontext, through the normal image queue,
// completes a partly hidden sprite or draws variations of it. This file: models, masks -> cut-outs,
// keying the AI results, sprite-sheet packing and the kit exports (PNG, sheet, Unity, PSD, SVG).
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");

const MODELS = { detector: "onnx-community/grounding-dino-tiny-ONNX", segmenter: "onnx-community/sam2.1-hiera-tiny-ONNX" };
const DTYPE = "int8"; // ~260 MB download for both; fp32 is 3x bigger for little gain on landscapes
// ONNX Runtime's memory arena keeps every peak allocation: with it off both models stay ~400 MB instead of ~3 GB.
// A few threads that sleep instead of spin: ONNX's default (a spinning thread per core) is 2x slower on a
// busy hybrid laptop CPU and starves ComfyUI and the user's apps.
const SESSION = { enableCpuMemArena: false, enableMemPattern: false, intraOpNumThreads: Math.max(2, Math.min(4, Math.floor(os.cpus().length / 4))),
  interOpNumThreads: 1, extra: { session: { intra_op: { allow_spinning: "0" }, inter_op: { allow_spinning: "0" } } } };
const IDLE_RELEASE_MS = 3 * 60 * 1000;
const SAM_SIZE = 1024; // SAM 2 squashes every image to 1024x1024, so prompts scale per axis

// What can be looked for. kind "layer" = wide background pieces (parallax layers), "prop" = objects you place.
// depth: back (0) to front (4), for draw order, sorting layers and the Unity sorting order.
const LABELS = [
  { id: "tree", kind: "prop", depth: 4, on: true }, { id: "bush", kind: "prop", depth: 4, on: true },
  { id: "rock", kind: "prop", depth: 4, on: true }, { id: "mountain", kind: "layer", depth: 2, on: true },
  { id: "hill", kind: "layer", depth: 2, on: true }, { id: "cliff", kind: "layer", depth: 2, on: false },
  { id: "cloud", kind: "prop", depth: 1, on: true }, { id: "waterfall", kind: "prop", depth: 3, on: true },
  { id: "lake", kind: "layer", depth: 3, on: true }, { id: "river", kind: "layer", depth: 3, on: false },
  { id: "grass", kind: "layer", depth: 3, on: true }, { id: "flower", kind: "prop", depth: 4, on: false },
  { id: "house", kind: "prop", depth: 4, on: false }, { id: "animal", kind: "prop", depth: 4, on: false },
  { id: "sky", kind: "layer", depth: 0, on: false },
];
/** Catalogue entry for a label; "mountain peak" or "palm tree" take after the known word in them. */
function labelInfo(label) {
  const words = String(label).split(/[\s_-]+/).reverse(); // the last word names the thing: "rock cliff" is a cliff
  return LABELS.find((l) => l.id === label) || LABELS.find((l) => words.includes(l.id)) || { id: label, kind: "prop", depth: 4 };
}

// Variation ideas per kind of object; the UI offers these as one-click hints.
const VARIATION_HINTS = {
  tree: ["taller and thinner", "wider with a rounder crown", "small young tree", "leaning, with a twisted trunk"],
  bush: ["wider and lower", "small and round", "taller and denser"],
  rock: ["flatter and wider", "tall and jagged", "small, a cluster of stones", "rounder boulder"],
  mountain: ["taller with one sharp peak", "wide and low, rolling ridges", "twin peaks", "steeper with a snowy top"],
  hill: ["gentler and wider", "steeper and taller", "two rolling humps"],
  cliff: ["taller and sheer", "wider with ledges", "broken into two pillars"],
  cloud: ["long and flat", "tall and puffy", "small wisp", "wide and billowing"],
  waterfall: ["taller and narrower", "wider, several streams", "short with a big splash"],
  default: ["a different shape", "bigger and more detailed", "smaller and simpler"],
};
const hintsFor = (label) => VARIATION_HINTS[label] || VARIATION_HINTS.default;

// ------------------------------------------------------------------ models (lazy, released when idle)
class SceneAI {
  /** @param {{cacheDir: string, roomFor?: (bytes:number, stage:(s:string)=>void) => Promise<void>, onIdle?: () => void}} o */
  constructor(o) { this.o = { roomFor: async () => {}, ...o }; this.det = null; this.sam = null; this.emb = null; this.timer = null; }

  lib() {
    if (!this.T) { this.T = require("@huggingface/transformers"); this.T.env.cacheDir = this.o.cacheDir; }
    return this.T;
  }

  touch() { clearTimeout(this.timer); this.timer = setTimeout(() => (this.o.onIdle ? this.o.onIdle() : this.release()), IDLE_RELEASE_MS); }

  /** Free both models (gives their RAM back to ComfyUI / other apps). */
  async release() {
    clearTimeout(this.timer);
    const [d, s] = [this.det, this.sam];
    this.det = this.sam = this.emb = null;
    await Promise.all([d && d.dispose(), s && s.model.dispose()].filter(Boolean)).catch(() => {});
  }

  /** Download progress, only when the model isn't on disk yet (loading from disk is quick and says so itself). */
  progress(stage, what, repo) {
    if (fs.existsSync(path.join(this.o.cacheDir, repo, "onnx"))) return undefined;
    const seen = {};
    return (p) => {
      if (p.status !== "progress" || !p.total || p.total < 5e6) return; // only the big weight files are worth a message
      seen[p.file] = p;
      const all = Object.values(seen), done = all.reduce((a, x) => a + x.loaded, 0), total = all.reduce((a, x) => a + x.total, 0);
      stage(`downloading ${what} (first time only) · ${Math.round((done / total) * 100)}% of ${Math.round(total / 1048576)} MB`);
    };
  }

  async detector(stage) {
    this.touch();
    if (!this.det) {
      await this.o.roomFor(450 * 1048576, stage);
      stage("loading the object finder");
      this.det = await this.lib().pipeline("zero-shot-object-detection", MODELS.detector,
        { dtype: DTYPE, session_options: SESSION, progress_callback: this.progress(stage, "the object finder", MODELS.detector) });
    }
    return this.det;
  }

  async segmenter(stage) {
    this.touch();
    if (!this.sam) {
      await this.o.roomFor(250 * 1048576, stage);
      stage("loading the cut-out model");
      const T = this.lib(), cb = this.progress(stage, "the cut-out model", MODELS.segmenter);
      this.sam = {
        model: await T.Sam2Model.from_pretrained(MODELS.segmenter, { dtype: DTYPE, session_options: SESSION, progress_callback: cb }),
        proc: await T.AutoProcessor.from_pretrained(MODELS.segmenter, { progress_callback: cb }),
      };
    }
    return this.sam;
  }

  rawImage(img) {
    const T = this.lib(), rgb = new Uint8ClampedArray(img.w * img.h * 3);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { rgb[i] = img.data[j]; rgb[i + 1] = img.data[j + 1]; rgb[i + 2] = img.data[j + 2]; }
    return new T.RawImage(rgb, img.w, img.h, 3);
  }

  /** Boxes for every label, one detector pass per label (a long "tree. rock. cloud." prompt finds far less). */
  async detect(img, labels, { threshold = 0.3, stage = () => {} } = {}) {
    const det = await this.detector(stage), image = this.rawImage(img), out = [];
    for (const [i, label] of labels.entries()) {
      stage(`looking for ${plural(label)} (${i + 1}/${labels.length})`, i / labels.length);
      const found = await det(image, [`${label}.`], { threshold, top_k: 16 });
      for (const o of found) out.push({ label, score: o.score, box: clampBox([o.box.xmin, o.box.ymin, o.box.xmax, o.box.ymax], img.w, img.h) });
      this.touch();
    }
    return out;
  }

  /**
   * Soft mask (alpha 0..255, full image size) for one prompt: {box:[x0,y0,x1,y1]} or {points:[[x,y]...], negative:[[x,y]...]}.
   * The image embedding is computed once per scene and reused for every prompt.
   */
  async mask(img, key, prompt, stage = () => {}) {
    const { model, proc } = await this.segmenter(stage), T = this.lib();
    if (!this.emb || this.emb.key !== key) {
      stage("reading the picture");
      const { pixel_values } = await proc(this.rawImage(img));
      this.emb = { key, value: await model.get_image_embeddings({ pixel_values }) };
    }
    const sx = SAM_SIZE / img.w, sy = SAM_SIZE / img.h, inputs = {};
    if (prompt.box) {
      const [x0, y0, x1, y1] = prompt.box;
      inputs.input_boxes = new T.Tensor("float32", Float32Array.of(x0 * sx, y0 * sy, x1 * sx, y1 * sy), [1, 1, 4]);
    } else {
      const pts = [...prompt.points.map((p) => [p, 1n]), ...(prompt.negative || []).map((p) => [p, 0n])];
      inputs.input_points = new T.Tensor("float32", Float32Array.from(pts.flatMap(([p]) => [p[0] * sx, p[1] * sy])), [1, 1, pts.length, 2]);
      inputs.input_labels = new T.Tensor("int64", BigInt64Array.from(pts.map(([, l]) => l)), [1, 1, pts.length]);
    }
    const r = await model({ ...this.emb.value, ...inputs });
    this.touch();
    const dims = r.pred_masks.dims, mh = dims.at(-2), mw = dims.at(-1), n = dims.at(-3), iou = Array.from(r.iou_scores.data);
    const k = iou.indexOf(Math.max(...iou));
    const logits = r.pred_masks.data.subarray(k * mh * mw, (k + 1) * mh * mw);
    return { alpha: await upsampleMask(logits, mw, mh, img, prompt.box), iou: iou[k], masks: n };
  }
}

const UNCOUNTABLE = /(grass|water|sky|snow|fog|mist|sand|ice|lava|foliage|ground|terrain|smoke|moss|scenery)$/;
const plural = (w) => (UNCOUNTABLE.test(w) ? w : /(s|sh|ch|x)$/.test(w) ? w + "es" : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : w + "s");
const clampBox = (b, W, H) => [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(W, b[2]), Math.min(H, b[3])].map(Math.round);
const boxArea = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const boxInter = (a, b) => boxArea([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
const boxIou = (a, b) => { const i = boxInter(a, b); return i / (boxArea(a) + boxArea(b) - i || 1); };

/**
 * 256x256 mask logits -> full-size soft alpha whose edge follows the picture's own edges.
 * The logits are upscaled (bilinear) and turned into a narrow ramp, then a guided filter snaps the
 * blocky 256-grid edge onto real colour edges (leaves, rock outlines) inside the object's area.
 */
async function upsampleMask(logits, mw, mh, img, box) {
  const enc = Buffer.alloc(mw * mh);
  for (let i = 0; i < enc.length; i++) enc[i] = Math.max(0, Math.min(255, Math.round(128 + logits[i] * 12)));
  const up = await sharp(enc, { raw: { width: mw, height: mh, channels: 1 } }).resize(img.w, img.h, { kernel: "cubic", fit: "fill" }).extractChannel(0).raw().toBuffer();
  const alpha = new Uint8Array(img.w * img.h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = Math.max(0, Math.min(255, (up[i] - 128) * 8 + 128));
  // SAM sometimes leaks past the box it was given: keep a small margin around it only
  if (box) {
    const mx = (box[2] - box[0]) * 0.04 + 4, my = (box[3] - box[1]) * 0.04 + 4;
    const x0 = Math.max(0, Math.floor(box[0] - mx)), x1 = Math.min(img.w, Math.ceil(box[2] + mx)), y0 = Math.max(0, Math.floor(box[1] - my)), y1 = Math.min(img.h, Math.ceil(box[3] + my));
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (x < x0 || x >= x1 || y < y0 || y >= y1) alpha[y * img.w + x] = 0;
  }
  const bb = alphaBox(alpha, img.w, img.h, 8);
  if (bb) refineEdges(alpha, img, bb);
  return alpha;
}

function alphaBox(alpha, w, h, min = 8) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > min) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Grey-guided filter (He et al.) on the object's area, in place. r ~ one 256-grid cell, so it fixes exactly the blockiness. */
function refineEdges(alpha, img, bb) {
  const W = img.w, r = Math.max(2, Math.round(Math.max(img.w, img.h) / 256)), pad = r * 2;
  const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad), x1 = Math.min(img.w, bb.x1 + pad), y1 = Math.min(img.h, bb.y1 + pad);
  const w = x1 - x0, h = y1 - y0, n = w * h;
  const I = new Float32Array(n), p = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y + y0) * W + x + x0, d = s * 4;
    I[y * w + x] = (img.data[d] * 0.3 + img.data[d + 1] * 0.59 + img.data[d + 2] * 0.11) / 255;
    p[y * w + x] = alpha[s] / 255;
  }
  const box = (src) => boxFilter(src, w, h, r);
  const mI = box(I), mP = box(p), II = new Float32Array(n), IP = new Float32Array(n);
  for (let i = 0; i < n; i++) { II[i] = I[i] * I[i]; IP[i] = I[i] * p[i]; }
  const mII = box(II), mIP = box(IP), a = II, b = IP, eps = 0.004; // reuse buffers
  for (let i = 0; i < n; i++) { const v = mII[i] - mI[i] * mI[i]; a[i] = (mIP[i] - mI[i] * mP[i]) / (v + eps); b[i] = mP[i] - a[i] * mI[i]; }
  const ma = box(a), mb = box(b);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, q = ma[i] * I[i] + mb[i], orig = p[i];
    // only let the filter move the edge band; deep inside/outside keep SAM's answer
    const v = orig > 0.02 && orig < 0.98 || Math.abs(q - orig) < 0.5 ? q : orig;
    alpha[(y + y0) * W + x + x0] = Math.max(0, Math.min(255, Math.round((v - 0.5) * 1.35 * 255 + 127.5)));
  }
}

/** Mean over a (2r+1)^2 window, clipped at the borders (separable running sums). */
function boxFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0; const row = y * w;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = x - r - 1, hi = x + r;
      if (x > 0) { if (hi < w) s += src[row + hi]; if (lo >= 0) s -= src[row + lo]; }
      tmp[row + x] = s / (Math.min(w - 1, hi) - Math.max(0, x - r) + 1);
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = y - r - 1, hi = y + r;
      if (y > 0) { if (hi < h) s += tmp[hi * w + x]; if (lo >= 0) s -= tmp[lo * w + x]; }
      out[y * w + x] = s / (Math.min(h - 1, hi) - Math.max(0, y - r) + 1);
    }
  }
  return out;
}

// ------------------------------------------------------------------ detections -> parts
/**
 * Clean up raw detections: drop whole-picture and tiny boxes, duplicate boxes of the same thing,
 * "group" boxes (one box around several trees that were also found one by one), and the same object
 * found under two labels (bush/tree): the higher score wins.
 */
function dedupe(dets, W, H, max = 48, found = []) { // found: boxes of objects already cut out earlier
  const img = W * H;
  const list = dets.filter((d) => {
    const a = boxArea(d.box), bw = d.box[2] - d.box[0], bh = d.box[3] - d.box[1];
    if (a < img * 0.0006 || bw < 10 || bh < 10) return false;
    return labelInfo(d.label).kind === "layer" ? a < img * 0.97 : a < img * 0.6; // an "object" filling the frame is a miss
  }).sort((a, b) => b.score - a.score);
  const kept = []; // duplicates first (same label overlapping, or the same box under another label), so they can't look like a group
  for (const d of list) if (!kept.some((k) => boxIou(k.box, d.box) > (k.label === d.label ? 0.55 : 0.8))) kept.push(d);
  // a box is a group when 2+ objects found inside it also fill most of it (a big tree with small ones behind it is not)
  const isProp = (d) => labelInfo(d.label).kind === "prop";
  const covered = (b, inner) => {
    let hit = 0; const N = 24;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = b[0] + (i + 0.5) * (b[2] - b[0]) / N, y = b[1] + (j + 0.5) * (b[3] - b[1]) / N;
      if (inner.some((k) => x >= k[0] && x < k[2] && y >= k[1] && y < k[3])) hit++;
    }
    return hit / (N * N);
  };
  const groups = new Set(kept.filter((d) => {
    if (!isProp(d)) return false;
    const inside = [...kept.filter((k) => k !== d && isProp(k)).map((k) => k.box), ...found].filter((b) => boxInter(b, d.box) > 0.85 * boxArea(b));
    return inside.length >= 2 && covered(d.box, inside) > 0.55;
  }));
  return kept.filter((d) => !groups.has(d)).slice(0, max);
}

/**
 * Turn full-size masks into cut-outs. Where masks overlap, each pixel goes to the object in front:
 * nearer kinds first (objects, then water/grass, mountains, clouds, sky), and between two of the same
 * kind the one standing lower in the picture (a tree whose foot is lower is nearer), then the smaller.
 * The part of a sprite hidden that way is reported (`hidden`), as are frame edges it touches (`cut`).
 * parts: [{label, score, box, alpha}] -> [{..., png, x, y, w, h, hidden, cut}]
 */
async function cutOut(img, parts, { exclusive = true } = {}) {
  const W = img.w, H = img.h, sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  for (const p of parts) p.total = sum(p.alpha);
  // an "object" covering a fifth of the picture (a cliff found as "rock") sits back with the mountains
  const depth = (p) => (labelInfo(p.label).kind === "prop" && p.box && boxArea(p.box) > W * H * 0.2 ? 2 : labelInfo(p.label).depth);
  const order = exclusive ? [...parts].sort((a, b) => depth(b) - depth(a)
    || (b.box ? b.box[3] : 0) - (a.box ? a.box[3] : 0) || a.total - b.total) : parts;
  const taken = exclusive ? new Uint8Array(W * H) : null;
  const out = [];
  for (const p of order) {
    const vis = p.alpha;
    // a front object's soft edge removes the pixel from the one behind it completely (no ghost outline)
    if (taken) for (let i = 0; i < vis.length; i++) if (vis[i]) { const v = Math.round(vis[i] * Math.max(0, 255 - taken[i] * 2) / 255); vis[i] = v; taken[i] = Math.min(255, taken[i] + v); }
    const visible = sum(vis), bb = alphaBox(vis, W, H, 24);
    if (!bb || visible / 255 < 150) continue; // nothing left of it
    if (exclusive && depth(p) >= 4 && visible < p.total * 0.15) continue; // an object almost all behind another one: a second find of it
    const x = Math.max(0, bb.x0 - 1), y = Math.max(0, bb.y0 - 1), w = Math.min(W, bb.x1 + 1) - x, h = Math.min(H, bb.y1 + 1) - y;
    const rgba = Buffer.alloc(w * h * 4);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const s = (yy + y) * W + xx + x, d = (yy * w + xx) * 4;
      rgba[d] = img.data[s * 4]; rgba[d + 1] = img.data[s * 4 + 1]; rgba[d + 2] = img.data[s * 4 + 2];
      rgba[d + 3] = Math.round(vis[s] * img.data[s * 4 + 3] / 255);
    }
    dropSpecks(rgba, w, h);
    const edge = (x0, y0, x1, y1) => { for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) if (vis[yy * W + xx] > 128) return true; return false; };
    const cut = [["left", edge(0, 0, 2, H)], ["right", edge(W - 2, 0, W, H)], ["top", edge(0, 0, W, 2)], ["bottom", edge(0, H - 2, W, H)]].filter((e) => e[1]).map((e) => e[0]);
    out.push({ label: p.label, score: p.score, source: p.source, png: await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(),
      x, y, w, h, hidden: +(1 - visible / p.total).toFixed(3), cut });
  }
  return out;
}

/**
 * Take a newly added object's pixels out of a sprite behind it (e.g. a snowy peak picked by hand out of
 * the cloud layer). part: {png, x, y}; alpha: full-size mask. Returns the new PNG and the share of the
 * sprite that is left, or null when the two don't overlap.
 */
async function carve(part, alpha, W) {
  const { data, info } = await sharp(part.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let before = 0, after = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const d = (y * info.width + x) * 4, a = data[d + 3]; if (!a) continue;
    const m = alpha[(y + part.y) * W + x + part.x] || 0;
    before += a;
    if (m) data[d + 3] = Math.round(a * Math.max(0, 255 - m * 2) / 255);
    after += data[d + 3];
  }
  if (after === before) return null;
  return { png: await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer(), left: before ? after / before : 0 };
}

// ------------------------------------------------------------------ whole steps (run in the worker process)
/** Find `labels`, drop duplicates and boxes already covered by `skip` boxes, cut every object out. */
async function analyzeImage(ai, img, labels, { skip = [], key, stage = () => {} } = {}) {
  const dets = await ai.detect(img, labels, { stage: (t, f) => stage(t, f != null ? 0.03 + f * 0.72 : null) });
  const found = dedupe(dets, img.w, img.h, 48, skip).filter((d) => !skip.some((b) => boxIou(b, d.box) > 0.6));
  const masks = [];
  for (const [i, d] of found.entries()) {
    stage(`cutting out ${i + 1} of ${found.length}`, 0.75 + (0.22 * i) / Math.max(1, found.length));
    masks.push({ ...d, source: "auto", alpha: (await ai.mask(img, key, { box: d.box }, stage)).alpha });
  }
  stage("finishing the sprites", 0.97);
  return cutOut(img, masks);
}

/** One object picked by hand (point or box): its cut-out, plus its full mask to carve it out of the sprites behind it. */
async function cutByHand(ai, img, prompt, label, { key, stage = () => {} } = {}) {
  const { alpha } = await ai.mask(img, key, prompt, stage);
  const [part] = await cutOut(img, [{ label, score: 1, source: "manual", box: prompt.box, alpha }], { exclusive: false });
  return { part: part || null, alpha };
}

// ------------------------------------------------------------------ FLUX Kontext in/out
const KEYS = {
  green: { name: "green", words: "bright green (#00FF00)", rgb: [0, 255, 0], k: (r, g, b) => g - Math.max(r, b) },
  magenta: { name: "magenta", words: "bright magenta (#FF00FF)", rgb: [255, 0, 255], k: (r, g, b) => Math.min(r, b) - g },
};
/** Key colour for the AI to draw on: the one the sprite's own colours are furthest from (dark olive trees get magenta). */
async function keyFor(png) {
  const { data } = await sharp(png).ensureAlpha().resize(64, 64, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const near = { green: 0, magenta: 0 };
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128)
    for (const k of Object.values(KEYS)) near[k.name] += Math.max(0, k.k(data[i], data[i + 1], data[i + 2]) + 20);
  const { k, ...key } = near.magenta < near.green ? KEYS.magenta : KEYS.green;
  return key;
}

/**
 * The sprite on a flat key-colour canvas with room around it (more room on the sides where it was cut
 * off). Small sprites are scaled up so the AI draws them with real detail. Soft edges are firmed up first:
 * see-through mist blended with the key colour would come back as green (or pink) haze. Returns the PNG
 * and where the sprite sits on it ({l, t, s, W, H}), so the result can be mapped back to the picture.
 */
async function kontextInput(png, cut = [], key) {
  const m = await sharp(png).metadata(), s = 720 / Math.max(m.width, m.height);
  const w = Math.max(1, Math.round(m.width * s)), h = Math.max(1, Math.round(m.height * s));
  const room = (side) => Math.round((cut.includes(side) ? 0.45 : 0.14) * (side === "left" || side === "right" ? w : h)) + 16;
  let [l, r, t, b] = ["left", "right", "top", "bottom"].map(room);
  const W = w + l + r, H = h + t + b; // keep the canvas between 1:2 and 2:1 (Kontext's range)
  if (W > H * 2) { const e = Math.ceil(W / 2 - H); t += e >> 1; b += e - (e >> 1); } else if (H > W * 2) { const e = Math.ceil(H / 2 - W); l += e >> 1; r += e - (e >> 1); }
  const [R, G, B] = key.rgb;
  const { data } = await sharp(png).ensureAlpha().resize(w, h, { kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) data[i] = Math.max(0, Math.min(255, (data[i] - 64) * 2)); // < 25% gone, > 75% solid
  const sprite = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  const out = await sharp({ create: { width: w + l + r, height: h + t + b, channels: 4, background: { r: R, g: G, b: B, alpha: 1 } } })
    .composite([{ input: sprite, left: l, top: t }]).flatten({ background: { r: R, g: G, b: B } }).png().toBuffer();
  return { png: out, geom: { l, t, s, W: w + l + r, H: h + t + b } };
}

/**
 * Where an AI result lands on the original picture: the AI resizes our canvas to its own size, so a
 * point (X, Y) on its output maps back through that resize, the canvas margins and the sprite's scale.
 * key: keyOutput() result, geom: kontextInput() geometry, part: the sprite's box on the picture.
 */
function placeResult(key, geom, part) {
  const kx = key.W / geom.W, ky = key.H / geom.H;
  const x = part.x + (key.x / kx - geom.l) / geom.s, y = part.y + (key.y / ky - geom.t) / geom.s;
  const w = key.w / kx / geom.s, h = key.h / ky / geom.s;
  return { x: +x.toFixed(1), y: +y.toFixed(1), w: +w.toFixed(1), h: +h.toFixed(1), scale: +(key.w / w).toFixed(4) };
}

const kontextPrompt = {
  complete: (label, key) => `Redraw this ${label} as one complete, whole ${label}: fill in every part that is hidden, missing or cut off at the edges, `
    + `so the entire ${label} is visible with some space around it. Keep exactly the same art style, colors, lighting and level of detail. `
    + `Only the ${label} on a plain flat solid ${key.words} background, no ground, no shadow, no other objects.`,
  variation: (label, hint, key) => `Draw a different ${label} in exactly the same art style, colors, lighting and level of detail as this one: ${hint || "a different shape"}. `
    + `The whole ${label} is visible, centered, with space around it. Only the ${label} on a plain flat solid ${key.words} background, no ground, no shadow, no other objects.`,
  plate: (things) => `Remove all the ${things} from this picture and fill in the scenery that was behind them, so only the empty landscape is left. `
    + `Keep the sky, mountains, water and ground, the colors, lighting and art style exactly the same.`,
};

/**
 * Cut the AI's sprite off its flat key-colour background. The model rarely paints the exact key colour,
 * so the background is measured from the border. Background connected to the border goes (so similar
 * colours inside the sprite stay), as do enclosed gaps of nearly pure key colour (between branches).
 * Along the edge, alpha comes from how much key colour a pixel holds; those pixels are un-mixed from the
 * background and despilled, so no green or pink fringe is left. Stray specks are dropped.
 */
async function keyOutput(buf, keyName) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, n = W * H;
  const border = [];
  for (let x = 0; x < W; x += 2) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y += 2) border.push(y * W, y * W + W - 1);
  const bg = [0, 1, 2].map((c) => median(border.map((p) => data[p * 4 + c])));
  const K = KEYS[keyName] || (KEYS.magenta.k(...bg) > KEYS.green.k(...bg) ? KEYS.magenta : KEYS.green);
  const kb = Math.max(40, K.k(...bg)); // how much key colour the background itself has
  const keyness = (p) => K.k(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
  const dist = (p) => { const i = p * 4; return Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]); };
  const LO = 40, HI = 115, alpha = new Uint8Array(n).fill(255), seen = new Uint8Array(n), stack = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const p = stack.pop(); if (seen[p]) continue; seen[p] = 1;
    const d = dist(p); if (d >= HI) continue;
    alpha[p] = d <= LO ? 0 : Math.round(((d - LO) / (HI - LO)) * 255);
    const x = p % W;
    if (x > 0) stack.push(p - 1); if (x < W - 1) stack.push(p + 1);
    if (p >= W) stack.push(p - W); if (p < n - W) stack.push(p + W);
  }
  for (let p = 0; p < n; p++) if (alpha[p] === 255 && dist(p) < LO * 0.8 && keyness(p) > kb * 0.75) alpha[p] = 0; // enclosed gaps
  // the edge band: a few pixels either side of where the background starts
  const band = new Uint8Array(n), R = Math.max(2, Math.round(Math.max(W, H) / 400));
  for (let p = 0; p < n; p++) if (alpha[p] < 255 || keyness(p) > kb * 0.15) band[p] = 1;
  for (let it = 0; it < R; it++) {
    const grow = [];
    for (let p = 0; p < n; p++) if (!band[p]) { const x = p % W; if ((x > 0 && band[p - 1]) || (x < W - 1 && band[p + 1]) || (p >= W && band[p - W]) || (p < n - W && band[p + W])) grow.push(p); }
    for (const p of grow) band[p] = 1;
  }
  for (let p = 0; p < n; p++) {
    const i = p * 4, kp = keyness(p);
    // the key colour was picked far from the sprite's colours, so any pixel holding a lot of it is part background
    if (alpha[p] > 0 && (band[p] || kp > kb * 0.15)) alpha[p] = Math.min(alpha[p], Math.round(Math.max(0, Math.min(1, 1 - kp / (kb * 0.9))) * 255));
    const a = alpha[p] / 255;
    if (a > 0 && a < 1) for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, Math.round((data[i + c] - (1 - a) * bg[c]) / a))); // C = aF + (1-a)B
    if (a > 0 && (band[p] || a < 1)) { // despill whatever key colour is left
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (K.name === "green" && g > Math.max(r, b)) data[i + 1] = Math.max(r, b);
      if (K.name === "magenta" && Math.min(r, b) > g) { const e = Math.min(r, b) - g; data[i] = r - e; data[i + 2] = b - e; }
    }
    data[i + 3] = Math.round(alpha[p] * data[i + 3] / 255);
  }
  dropSpecks(data, W, H);
  const a8 = new Uint8Array(n); for (let p = 0; p < n; p++) a8[p] = data[p * 4 + 3];
  const bb = alphaBox(a8, W, H, 10);
  if (!bb) throw new Error("the AI returned an empty picture");
  const x = Math.max(0, bb.x0 - 2), y = Math.max(0, bb.y0 - 2), w = Math.min(W, bb.x1 + 2) - x, h = Math.min(H, bb.y1 + 2) - y;
  const png = await sharp(data, { raw: { width: W, height: H, channels: 4 } }).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
  return { png, x, y, w, h, W, H }; // trim box inside the AI's canvas, to map it back onto the picture
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

/** Remove opaque islands much smaller than the main shape (key noise, bits of ground the AI added). */
function dropSpecks(data, W, H) {
  const n = W * H, comp = new Int32Array(n).fill(-1), sizes = [], stack = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || data[s * 4 + 3] < 128) continue;
    const id = sizes.length; let size = 0; stack.push(s); comp[s] = id;
    while (stack.length) {
      const p = stack.pop(); size++;
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) if (q >= 0 && q < n && comp[q] < 0 && data[q * 4 + 3] >= 128) { comp[q] = id; stack.push(q); }
    }
    sizes.push(size);
  }
  if (!sizes.length) return;
  const keep = Math.max(40, Math.max(...sizes) * 0.012);
  for (let p = 0; p < n; p++) {
    let id = comp[p];
    if (id < 0 && data[p * 4 + 3] > 0) { // soft edge pixel: belongs to a neighbouring component
      const x = p % W; for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) if (q >= 0 && q < n && comp[q] >= 0) { id = comp[q]; break; }
    }
    if (id >= 0 ? sizes[id] < keep : data[p * 4 + 3] > 0) data[p * 4 + 3] = 0;
  }
}

// ------------------------------------------------------------------ sprite sheets & exports
/** Shelf-pack sprites ({w, h}) into pages of at most maxSize; returns [{w, h, items:[{i, x, y}]}]. */
function packPages(sizes, { pad = 2, maxSize = 4096 } = {}) {
  const order = sizes.map((s, i) => ({ ...s, i })).sort((a, b) => b.h - a.h || b.w - a.w);
  const area = order.reduce((a, s) => a + (s.w + pad) * (s.h + pad), 0);
  const width = Math.min(maxSize, Math.max(Math.ceil(Math.sqrt(area * 1.15)), ...order.map((s) => s.w + pad)));
  const pages = [];
  let page = null, x = 0, y = 0, rowH = 0;
  const newPage = () => { page = { w: 0, h: 0, items: [] }; pages.push(page); x = y = rowH = 0; };
  for (const s of order) {
    if (!page) newPage();
    if (x + s.w + pad > width) { x = 0; y += rowH; rowH = 0; } // next shelf
    if (y + s.h + pad > maxSize) newPage();
    page.items.push({ i: s.i, x: x + pad, y: y + pad });
    x += s.w + pad; rowH = Math.max(rowH, s.h + pad);
    page.w = Math.max(page.w, x + pad); page.h = Math.max(page.h, y + rowH + pad);
  }
  for (const p of pages) { p.w = Math.ceil(p.w / 4) * 4; p.h = Math.ceil(p.h / 4) * 4; } // block-compression friendly
  return pages;
}

/** Sprites bigger than a sheet page are scaled down to fit (a 4096 px mountain range is rare). */
async function fitSprite(sp, maxSize) {
  if (sp.w + 4 <= maxSize && sp.h + 4 <= maxSize) return sp;
  const s = (maxSize - 4) / Math.max(sp.w, sp.h), w = Math.floor(sp.w * s), h = Math.floor(sp.h * s);
  return { ...sp, png: await sharp(sp.png).resize(w, h).png().toBuffer(), w, h, scale: (sp.scale || 1) * s };
}

async function sheets(name, sprites, maxSize = 4096) {
  const fitted = await Promise.all(sprites.map((s) => fitSprite(s, maxSize)));
  const pages = packPages(fitted, { maxSize }), files = [], frames = [];
  for (const [pi, page] of pages.entries()) {
    const file = `${name}_Sheet_${pi + 1}.png`;
    const composite = page.items.map((it) => ({ input: fitted[it.i].png, left: it.x, top: it.y }));
    files.push({ name: file, data: await sharp({ create: { width: page.w, height: page.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composite).png().toBuffer() });
    for (const it of page.items) {
      const s = fitted[it.i];
      frames.push({ name: s.name, category: s.category, kind: s.kind, sheet: file, x: it.x, y: it.y, w: s.w, h: s.h, pivot: s.pivot, order: s.order, scale: s.scale || 1, source: s.source });
    }
  }
  frames.sort((a, b) => a.name.localeCompare(b.name));
  return { files, frames };
}

/** Layered Photoshop file: one group per category, every sprite at its place in the picture. */
function psdFile(scene, img, sprites, plate) {
  const W = img.w, H = img.h, toData = (raw) => ({ width: raw.w, height: raw.h, data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length) });
  const groups = new Map();
  for (const s of sprites.filter((x) => x.raw && x.x != null).sort((a, b) => a.order - b.order)) {
    if (!groups.has(s.category)) groups.set(s.category, []);
    groups.get(s.category).push({ name: s.name, left: s.x, top: s.y, hidden: !!s.hiddenLayer, imageData: toData(s.raw) });
  }
  const children = [{ name: "Original picture", hidden: true, left: 0, top: 0, imageData: toData(img) }];
  if (plate) children.push({ name: "Clean background (AI)", left: 0, top: 0, imageData: toData(plate) });
  for (const [cat, layers] of groups) children.push({ name: cat, opened: true, children: layers });
  const { writePsdBuffer } = require("ag-psd");
  return writePsdBuffer({ width: W, height: H, imageData: toData(img), children }, { generateThumbnail: false });
}

/** Layered SVG (opens with one layer per category in Inkscape, Illustrator, Figma, Affinity). */
function svgFile(scene, img, sprites, originalPng, platePng) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const href = (png) => `data:image/png;base64,${png.toString("base64")}`;
  const layer = (name, body, hidden) => `<g id="${esc(name)}" inkscape:groupmode="layer" inkscape:label="${esc(name)}"${hidden ? ' style="display:none"' : ""}>\n${body}</g>\n`;
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${img.w}" height="${img.h}" viewBox="0 0 ${img.w} ${img.h}">\n`;
  out += layer("Original picture", `  <image width="${img.w}" height="${img.h}" href="${href(originalPng)}"/>\n`, true);
  if (platePng) out += layer("Clean background (AI)", `  <image width="${img.w}" height="${img.h}" href="${href(platePng)}"/>\n`);
  const groups = new Map();
  for (const s of sprites.filter((x) => x.x != null).sort((a, b) => a.order - b.order)) { if (!groups.has(s.category)) groups.set(s.category, []); groups.get(s.category).push(s); }
  for (const [cat, list] of groups) out += layer(cat, list.map((s) => `  <image id="${esc(s.name)}" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" href="${href(s.png)}"${s.hiddenLayer ? ' style="display:none"' : ""}/>\n`).join(""));
  return Buffer.from(out + "</svg>\n");
}

const UNITY_SCRIPT = path.join(__dirname, "unity", "SpriteForgeSceneKit.cs");
const unityScript = () => fs.readFileSync(UNITY_SCRIPT);

module.exports = { SceneAI, analyzeImage, cutByHand, LABELS, labelInfo, hintsFor, dedupe, cutOut, carve, keyFor, kontextInput, placeResult, kontextPrompt, keyOutput,
  sheets, psdFile, svgFile, unityScript, plural, clampBox, boxIou, VARIATION_HINTS };
