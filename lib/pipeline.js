// Image pipeline: character prep -> frame sampling -> chroma key -> alignment -> exports.
const sharp = require("sharp");
const zlib = require("zlib");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");
const Chroma = require("../public/chroma.js");

// ---------------------------------------------------------------- raw helpers
async function toRaw(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
const toPng = (raw) => sharp(raw.data, { raw: { width: raw.w, height: raw.h, channels: 4 } }).png().toBuffer();

function blank(w, h) { return { data: Buffer.alloc(w * h * 4), w, h }; }

/** src-over blit with clipping (dst assumed straight alpha). */
function blit(dst, src, dx, dy) {
  dx = Math.round(dx); dy = Math.round(dy);
  for (let y = 0; y < src.h; y++) {
    const ty = y + dy; if (ty < 0 || ty >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const tx = x + dx; if (tx < 0 || tx >= dst.w) continue;
      const s = (y * src.w + x) * 4, d = (ty * dst.w + tx) * 4;
      const sa = src.data[s + 3] / 255; if (sa === 0) continue;
      const da = dst.data[d + 3] / 255, oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) dst.data[d + c] = Math.round((src.data[s + c] * sa + dst.data[d + c] * da * (1 - sa)) / oa);
      dst.data[d + 3] = Math.round(oa * 255);
    }
  }
}

async function resizeRaw(raw, w, h) {
  const { data, info } = await sharp(raw.data, { raw: { width: raw.w, height: raw.h, channels: 4 } })
    .resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), { kernel: "lanczos3", fit: "fill" })
    .raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// ---------------------------------------------------------------- character prep
/** If the upload has no transparency, key out the background by the corner colour. */
function removeFlatBackground(raw, tol = 38) {
  const { data, w, h } = raw;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) transparent++;
  if (transparent > w * h * 0.02) return raw; // already has alpha
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => (y * w + x) * 4);
  const bg = [0, 1, 2].map((c) => Math.round(corners.reduce((s, i) => s + data[i + c], 0) / 4));
  // flood fill from the edges so interior colours matching the bg are kept
  const seen = new Uint8Array(w * h), stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const p = stack.pop(); if (seen[p]) continue; seen[p] = 1;
    const i = p * 4;
    const dist = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    if (dist > tol * 3) continue;
    data[i + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) stack.push(p - 1); if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w); if (y < h - 1) stack.push(p + w);
  }
  return raw;
}

/** Clean + trim + optional flip. Returns PNG buffer of the character alone. */
async function normalizeCharacter(buf, flip) {
  let raw = removeFlatBackground(await toRaw(buf));
  const bb = Chroma.alphaBBox(raw.data, raw.w, raw.h, 20);
  if (!bb) throw new Error("Character image is empty after background removal.");
  let img = sharp(await toPng(raw)).extract({ left: bb.x0, top: bb.y0, width: bb.x1 - bb.x0, height: bb.y1 - bb.y0 });
  if (flip) img = img.flop();
  return img.png().toBuffer();
}

/**
 * Place the character on a flat key-colour canvas the video model will animate.
 * Layout is recorded so every generated frame can be mapped back exactly.
 */
async function composeOnKey(charPng, s) {
  const W = s.videoWidth, H = s.videoHeight;
  const meta = await sharp(charPng).metadata();
  const charH = Math.round(H * s.charHeightFrac);
  let charW = Math.round(meta.width * (charH / meta.height));
  let ch = charH;
  if (charW > W * 0.8) { ch = Math.round(charH * (W * 0.8) / charW); charW = Math.round(W * 0.8); }
  const feetY = Math.round(H * s.feetFrac);
  const centerX = Math.round(W * s.centerFrac);
  const left = Math.round(centerX - charW / 2), top = feetY - ch;
  const [r, g, b] = Chroma.KEYS[s.keyColor].rgb;
  const resized = await sharp(charPng).resize(charW, ch, { kernel: "lanczos3" }).png().toBuffer();
  const png = await sharp({ create: { width: W, height: H, channels: 4, background: { r, g, b, alpha: 1 } } })
    .composite([{ input: resized, left, top }]).flatten({ background: { r, g, b } }).png().toBuffer();
  return { png, layout: { W, H, charH: ch, feetY, centerX } };
}

// ---------------------------------------------------------------- frames
/**
 * Small pose fingerprints for comparing frames: 48×80 grey, with the flat key-colour background
 * forced to white so only the character's shape and shading count.
 */
async function thumbs(frames) {
  return Promise.all(frames.map(async (b) => {
    const px = await sharp(b).resize(48, 80, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const out = new Uint8Array(px.length / 3);
    for (let i = 0; i < out.length; i++) {
      const r = px[i * 3], g = px[i * 3 + 1], bl = px[i * 3 + 2], mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      out[i] = mx - mn > 90 && mx > 150 ? 255 : (r * 0.3 + g * 0.59 + bl * 0.11) | 0; // saturated bright = backdrop
    }
    return out;
  }));
}
const diff = (a, b) => { let d = 0; for (let k = 0; k < a.length; k++) d += Math.abs(a[k] - b[k]); return d / a.length; };

/**
 * Best loop in the clip: the span [a, b) whose end looks most like its start while the pose in between
 * really moves. Video models ease in (the first ~second is often the still input image) and drift late
 * (e.g. turning toward the camera), so the cycle is searched for anywhere rather than pinned to frame 0.
 */
function findCycle(th, lo, hi, count) {
  const n = hi - lo, D = (i, j) => diff(th[i], th[j]);
  const minLen = Math.min(n - 1, Math.max(6, count, Math.round(n * 0.18))), maxLen = Math.max(minLen + 1, Math.round(n * 0.75));
  const peakFrom = new Map(); // a -> running max of D(a, k)
  let globalPeak = 0;
  for (let a = lo; a < hi; a++) { const row = []; let m = 0; for (let k = a + 1; k < hi; k++) { m = Math.max(m, D(a, k)); row.push(m); } peakFrom.set(a, row); globalPeak = Math.max(globalPeak, m); }
  if (globalPeak < 2) return null; // essentially no motion (e.g. lying still): any span works
  let best = null;
  for (let a = lo; a < hi - minLen; a++) {
    const row = peakFrom.get(a);
    for (let b = a + minLen; b <= Math.min(hi - 1, a + maxLen); b++) {
      const peak = row[b - a - 1];
      if (peak < globalPeak * 0.55) continue; // too little movement inside the span
      const score = D(a, b) / peak + (b - a) / n * 0.08; // closes well; slight preference for one short cycle
      if (!best || score < best.score) best = { a, b, score };
    }
  }
  return best && { start: best.a, end: best.b };
}

/** First frame where the pose has clearly started to change (skips the still lead-in of one-shot actions). */
function motionStart(th, lo, hi) {
  const d = []; let peak = 0;
  for (let k = lo; k < hi; k++) { d.push(diff(th[lo], th[k])); peak = Math.max(peak, d[d.length - 1]); }
  if (peak < 2) return lo;
  const k = d.findIndex((v) => v > peak * 0.12);
  return Math.max(lo, lo + k - 2);
}

/**
 * Choose `count` frame indices. Loops use the best cycle in the clip; one-shots skip the still lead-in.
 * A manual range (Tune → From/To) always wins. `reverse` plays the result backwards.
 */
async function pickFrames(frameBufs, count, loop, range, reverse) {
  const total = frameBufs.length;
  const manualStart = range && range.start != null, manualEnd = range && range.end != null;
  let start = Math.max(0, manualStart ? range.start : 0);
  let end = Math.min(total, manualEnd ? range.end : total); // exclusive
  if (total > 8 && !(manualStart && manualEnd)) {
    const th = await thumbs(frameBufs);
    if (loop) { const c = findCycle(th, start, end, count); if (c) { if (!manualStart) start = c.start; if (!manualEnd) end = c.end; } }
    else if (!manualStart) start = motionStart(th, start, end);
  }
  const span = Math.max(1, end - start);
  count = Math.min(count, span);
  const idx = [];
  for (let i = 0; i < count; i++) idx.push(start + Math.floor((loop ? i / count : count === 1 ? 0 : i / (count - 1)) * (span - (loop ? 0 : 1))));
  return reverse ? idx.reverse() : idx;
}

/**
 * Turn raw video frames into aligned transparent cells.
 * layout: from composeOnKey, s: settings, key: {tolerance,softness,despill}
 */
async function processFrames(rawFrames, layout, s, key, pick) {
  const idx = await pickFrames(rawFrames, pick.count, pick.loop, pick.range, pick.reverse);
  const scale = s.charHeightPx / layout.charH;
  const cells = [];
  for (const i of idx) {
    const raw = await toRaw(rawFrames[i]);
    // Video may come back at a slightly different size; map through the layout proportionally
    const sx = layout.W / raw.w, sy = layout.H / raw.h;
    Chroma.keyFrame(raw.data, raw.w, raw.h, { key: s.keyColor, ...key });
    const scaled = await resizeRaw(raw, raw.w * sx * scale, raw.h * sy * scale);
    const cell = blank(s.cellWidth, s.cellHeight);
    blit(cell, scaled, s.cellWidth / 2 - layout.centerX * scale, s.baselineY - layout.feetY * scale);
    cells.push(cell);
  }
  return { cells, indices: idx };
}

// ---------------------------------------------------------------- exports
async function sheetPng(cells, cols) {
  const w = cells[0].w, h = cells[0].h, rows = Math.ceil(cells.length / cols);
  const sheet = blank(w * Math.min(cols, cells.length), h * rows);
  cells.forEach((c, i) => blit(sheet, c, (i % cols) * w, Math.floor(i / cols) * h));
  return toPng(sheet);
}

/** GIF of the cells. bg = [r,g,b] flattens onto that colour; bg = null keeps transparency (1-bit, edges hard). */
function gifBuffer(cells, fps, bg = [30, 30, 36]) {
  const enc = GIFEncoder();
  const w = cells[0].w, h = cells[0].h;
  if (!bg) {
    for (const c of cells) {
      const rgba = new Uint8Array(c.data);
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = rgba[i] >= 128 ? 255 : 0;
      const palette = quantize(rgba, 256, { format: "rgba4444", oneBitAlpha: true });
      const index = applyPalette(rgba, palette, "rgba4444");
      const t = palette.findIndex((p) => p[3] === 0);
      enc.writeFrame(index, w, h, { palette, delay: Math.round(1000 / fps), transparent: t >= 0, transparentIndex: Math.max(t, 0), dispose: 2 });
    }
    enc.finish();
    return Buffer.from(enc.bytes());
  }
  for (const c of cells) {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      const a = c.data[i + 3] / 255;
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(c.data[i + k] * a + bg[k] * (1 - a));
      rgba[i + 3] = 255;
    }
    const palette = quantize(rgba, 256);
    enc.writeFrame(applyPalette(rgba, palette), w, h, { palette, delay: Math.round(1000 / fps) });
  }
  enc.finish();
  return Buffer.from(enc.bytes());
}

/** Copy of a cell flattened onto a solid [r,g,b] background (null = keep transparency). */
function onBackground(cell, bg) {
  if (!bg) return cell;
  const out = { data: Buffer.alloc(cell.data.length), w: cell.w, h: cell.h };
  for (let i = 0; i < cell.data.length; i += 4) {
    const a = cell.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out.data[i + k] = Math.round(cell.data[i + k] * a + bg[k] * (1 - a));
    out.data[i + 3] = 255;
  }
  return out;
}

// ---- tiny zip writer (deflate via zlib, no dependencies)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** files: [{name, data}] -> zip Buffer */
async function zipBuffer(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * Unity export in the FighterSpriteLibraryBuilder format:
 * <Name>_Sheet_N.png (8 columns, 16 rows per sheet) + <Name>_Spritesheet.json
 * anims: [{name, fps, loop, cells}]
 */
async function unityExport(name, anims, s) {
  const COLS = 8, ROWS = 16;
  const rows = [];
  for (const a of anims) for (let i = 0; i < a.cells.length; i += COLS) rows.push({ a, cells: a.cells.slice(i, i + COLS) });
  const meta = { character: name, cell: [s.cellWidth, s.cellHeight], columns: COLS,
    pivot: [0.5, +((s.cellHeight - s.baselineY) / s.cellHeight).toFixed(4)], sheets: [], animations: [] };
  const byName = {}, files = [];
  for (let si = 0; si < rows.length; si += ROWS) {
    const part = rows.slice(si, si + ROWS);
    const fname = `${name}_Sheet_${si / ROWS + 1}.png`;
    meta.sheets.push(fname);
    const sheet = blank(s.cellWidth * COLS, s.cellHeight * part.length);
    part.forEach((row, r) => row.cells.forEach((c, k) => {
      blit(sheet, c, k * s.cellWidth, r * s.cellHeight);
      if (!byName[row.a.name]) { byName[row.a.name] = { name: row.a.name, fps: row.a.fps, loop: row.a.loop, frames: [] }; meta.animations.push(byName[row.a.name]); }
      byName[row.a.name].frames.push({ sheet: fname, x: k * s.cellWidth, y: r * s.cellHeight, w: s.cellWidth, h: s.cellHeight });
    }));
    files.push({ name: fname, data: await toPng(sheet) });
  }
  files.push({ name: `${name}_Spritesheet.json`, data: Buffer.from(JSON.stringify(meta, null, 1)) });
  return zipBuffer(files);
}

module.exports = { toRaw, toPng, normalizeCharacter, composeOnKey, processFrames, pickFrames, sheetPng, gifBuffer, onBackground, zipBuffer, unityExport };
