// Video clips with sound: Wan 2.2 image-to-video (GGUF, 4-step Lightning) -> silent MP4 through
// VideoHelperSuite, then MMAudio (sound made from the video) and optional Qwen3-TTS speech, mixed
// and muxed into the final MP4 with ffmpeg. Every stage is its own ComfyUI prompt and the server
// frees ComfyUI between them, so a 6 GB GPU only ever holds one model family at a time.
// Clips longer than one Wan pass (5 s) are chained: each part starts from the previous part's last
// frame, and the sound is made in overlapping 8 s windows (what MMAudio is trained on), crossfaded.
const { execFile } = require("child_process");
const ffmpeg = require("ffmpeg-static");
const { patchWorkflow } = require("./workflow");

const WAN_FPS = 16; // Wan 2.2 A14B renders at 16 fps
const MMAUDIO_FPS = 25; // MMAudio's sync model reads frames at 25 fps and does not resample
const MAX_SECONDS = 30; // chained from parts of at most PART_FRAMES
const PART_FRAMES = 81; // 5 s: the longest single Wan pass that stays sane on 6 GB (and in RAM)
const SOUND_WINDOW = 8, SOUND_OVERLAP = 0.5; // MMAudio is trained on 8 s clips
const SPEAKERS = ["Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian"];
const MMAUDIO = { model: "mmaudio_large_44k_v2_fp16.safetensors", vae: "mmaudio_vae_44k_fp16.safetensors",
  synchformer: "mmaudio_synchformer_fp16.safetensors", clip: "apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors" };

/** Wan wants 4k+1 frames. */
const framesFor = (seconds) => Math.max(5, Math.round((Math.min(MAX_SECONDS, seconds) * WAN_FPS) / 4) * 4 + 1);

/**
 * How a clip of `total` frames is split into Wan passes. Each part after the first starts on the
 * previous part's last frame, which is dropped when joining, so parts add (frames - 1) new frames.
 * Parts are kept even (4k+1 frames each, at most PART_FRAMES). Returns the frame count of every part.
 */
function partPlan(total) {
  if (total <= PART_FRAMES) return [total];
  const steps = (total - 1) / 4, n = Math.ceil(steps / ((PART_FRAMES - 1) / 4)); // new frames come in 4s
  const base = Math.floor(steps / n), extra = steps - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < extra ? 1 : 0)) * 4 + 1);
}

/**
 * Keyframes: the clip travels through `keys` + 1 images in order. The frames are shared evenly between the
 * stretches (image k -> image k+1); a stretch longer than one pass is chained as usual, and its last part
 * ends exactly on the next image (Wan's first-last-frame mode). Returns [{frames, endKey}] per part,
 * endKey = index of the image that part must end on (null for parts that just continue).
 */
function keyframePlan(total, keys) {
  if (!keys) return partPlan(total).map((frames) => ({ frames, endKey: null }));
  const steps = (total - 1) / 4, base = Math.floor(steps / keys), extra = steps - base * keys, out = [];
  for (let k = 0; k < keys; k++) {
    const parts = partPlan((base + (k < extra ? 1 : 0)) * 4 + 1);
    parts.forEach((frames, i) => out.push({ frames, endKey: i === parts.length - 1 ? k + 1 : null }));
  }
  return out;
}

/** Equal overlapping windows ({start, seconds}, at most SOUND_WINDOW long) that cover a clip for MMAudio. */
function soundWindows(total) {
  if (total <= SOUND_WINDOW) return [{ start: 0, seconds: total }];
  const n = Math.ceil((total - SOUND_OVERLAP) / (SOUND_WINDOW - SOUND_OVERLAP)), step = (total - SOUND_OVERLAP) / n;
  return Array.from({ length: n }, (_, i) => ({ start: +(i * step).toFixed(3), seconds: +(step + SOUND_OVERLAP).toFixed(3) }));
}

const n = (class_type, inputs, title) => ({ class_type, inputs, _meta: { title } });

/** The image-to-video template turned into first-last-frame: the same models, plus an image the clip must end on. */
function firstLast(template) {
  const wf = JSON.parse(JSON.stringify(template));
  const id = Object.keys(wf).find((k) => wf[k].class_type === "WanImageToVideo");
  if (!id) throw new Error("The video workflow has no WanImageToVideo node to turn into first-last-frame.");
  wf[id].class_type = "WanFirstLastFrameToVideo";
  wf["900"] = n("LoadImage", { image: "end.png" }, "End image");
  wf[id].inputs.end_image = ["900", 0];
  return wf;
}

/**
 * The Wan image-to-video template with a tiled VAE decode (low VRAM) and a VideoHelperSuite MP4
 * instead of PNG frames. p: {image, prompt, negative, width, height, frames, seed, prefix, tile}
 */
function videoGraph(template, p) {
  if (p.endImage) template = firstLast(template);
  const { workflow: wf } = patchWorkflow(template, { image: p.image, endImage: p.endImage, positive: p.prompt, negative: p.negative,
    width: p.width, height: p.height, length: p.frames, seed: p.seed, prefix: p.prefix });
  const ids = Object.keys(wf);
  const decode = ids.filter((id) => /^VAEDecode(Tiled)?$/.test(wf[id].class_type)).pop();
  if (!decode) throw new Error("The video workflow has no VAEDecode node.");
  const tile = Math.max(64, Math.round((p.tile || 128) / 32) * 32);
  wf[decode] = n("VAEDecodeTiled", { samples: wf[decode].inputs.samples, vae: wf[decode].inputs.vae,
    tile_size: tile, overlap: Math.min(32, tile / 2), temporal_size: 32, temporal_overlap: 8 }, `Decode (tiles of ${tile})`);
  for (const id of ids) if (wf[id].class_type === "SaveImage") delete wf[id]; // the MP4 is enough
  const out = String(Math.max(...ids.map((x) => parseInt(x, 10) || 0)) + 100);
  wf[out] = n("VHS_VideoCombine", { images: [decode, 0], frame_rate: WAN_FPS, loop_count: 0, filename_prefix: p.prefix,
    format: "video/h264-mp4", pix_fmt: "yuv420p", crf: 19, save_metadata: false, trim_to_audio: false, pingpong: false, save_output: true }, "Silent MP4");
  return { workflow: wf, outputNodeIds: [out] };
}

/**
 * MMAudio: sound for the video, one window at a time (read back from the silent MP4 at the 25 fps it
 * expects). The models load once and every window shares them. p.windows: soundWindows(seconds).
 */
function soundGraph(p) {
  const wf = {
    2: n("MMAudioModelLoader", { mmaudio_model: MMAUDIO.model, base_precision: "fp16" }, "MMAudio"),
    3: n("MMAudioFeatureUtilsLoader", { vae_model: MMAUDIO.vae, synchformer_model: MMAUDIO.synchformer, clip_model: MMAUDIO.clip, mode: "44k", precision: "fp16" }, "MMAudio features"),
  };
  const outputNodeIds = [];
  for (const [i, w] of (p.windows || [{ start: 0, seconds: p.seconds }]).entries()) {
    const id = 10 + i * 3, seconds = +Math.max(0.5, w.seconds - 0.02).toFixed(3); // a hair short, so the frames always cover it
    // frames come in small (short side 256): MMAudio shrinks them to 224/384 anyway, and ComfyUI keeps every
    // window's frames in RAM until the prompt ends (full size would be ~1 GB per 8 s window)
    wf[id] = n("VHS_LoadVideo", { video: p.video, force_rate: MMAUDIO_FPS, custom_width: p.portrait ? 256 : 0, custom_height: p.portrait ? 0 : 256,
      frame_load_cap: Math.ceil(w.seconds * MMAUDIO_FPS), skip_first_frames: Math.round(w.start * MMAUDIO_FPS), select_every_nth: 1 }, `Video from ${w.start}s`);
    // SpriteForgeMMAudioSampler (ComfyUI/custom_nodes/spriteforge_nodes) puts MMAudio's parts on the GPU one at a time
    const sampler = p.lowVram === false ? { class: "MMAudioSampler", extra: { force_offload: true } } : { class: "SpriteForgeMMAudioSampler", extra: {} };
    wf[id + 1] = n(sampler.class, { mmaudio_model: ["2", 0], feature_utils: ["3", 0], images: [String(id), 0], duration: seconds, steps: p.steps || 25, cfg: p.cfg || 4.5,
      seed: p.seed + i, prompt: p.prompt || "", negative_prompt: p.negative || "", mask_away_clip: false, ...sampler.extra }, `Sound from ${w.start}s`);
    wf[id + 2] = n("SaveAudio", { audio: [String(id + 1), 0], filename_prefix: `${p.prefix}_sound${i}` }, `Save sound ${i}`);
    outputNodeIds.push(String(id + 2));
  }
  return { workflow: wf, outputNodeIds };
}

/** Qwen3-TTS CustomVoice: one line of speech, model unloaded right after to give the VRAM back. */
function speechGraph(p) {
  return { workflow: {
    1: n("FB_Qwen3TTSCustomVoice", { text: p.text, speaker: SPEAKERS.includes(p.speaker) ? p.speaker : "Ryan", model_choice: p.model === "1.7B" ? "1.7B" : "0.6B",
      device: "auto", precision: "bf16", language: p.language || "Auto", seed: p.seed, instruct: p.instruct || "", max_new_tokens: 2048,
      top_p: 1, top_k: 50, temperature: 0.9, repetition_penalty: 1.05, attention: "auto", unload_model_after_generate: true,
      custom_model_path: "", custom_speaker_name: "" }, "Speech"),
    2: n("SaveAudio", { audio: ["1", 0], filename_prefix: `${p.prefix}_speech` }, "Save speech"),
  }, outputNodeIds: ["2"] };
}

function run(args) {
  return new Promise((resolve, reject) => execFile(ffmpeg, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => (err && !/Duration:/.test(stderr) ? reject(new Error(`ffmpeg: ${String(stderr).split("\n").slice(-4).join(" ").trim()}`)) : resolve(String(stderr)))));
}

/** Length of an audio/video file in seconds (ffmpeg prints it while probing). */
async function duration(file) {
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(await run(["-hide_banner", "-i", file]));
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

/** Frame `index` (0-based) of a video as a PNG: the start of the next chained part. */
async function frameAt(file, index, out) {
  await run(["-hide_banner", "-y", "-i", file, "-vf", `select=eq(n\\,${index})`, "-vsync", "0", "-frames:v", "1", out]);
  return out;
}

/** Join chained parts into one video: every part after the first drops its first frame (the previous part's last). */
async function joinParts(files, out, fps = WAN_FPS) {
  if (files.length === 1) { await run(["-hide_banner", "-y", "-i", files[0], "-c", "copy", out]); return out; }
  const args = ["-hide_banner", "-y"], chains = [];
  files.forEach((f, i) => { args.push("-i", f); chains.push(`[${i}:v]${i ? "trim=start_frame=1," : ""}setpts=PTS-STARTPTS[v${i}]`); });
  const graph = `${chains.join(";")};${files.map((_, i) => `[v${i}]`).join("")}concat=n=${files.length}:v=1:a=0,fps=${fps}[out]`;
  await run([...args, "-filter_complex", graph, "-map", "[out]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  return out;
}

/** Mean level of an audio file in dB (ffmpeg volumedetect), or null for silence. */
async function meanVolume(file) {
  const m = /mean_volume: (-?[\d.]+) dB/.exec(await run(["-hide_banner", "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"]));
  return m && +m[1] > -80 ? +m[1] : null;
}

/**
 * One sound track from overlapping windows. MMAudio makes each window on its own and their levels can
 * differ a lot (measured: -15 dB then -32 dB), so every window is first brought to the median level
 * (gain kept within -12..+18 dB, so a truly quiet moment stays quiet), then crossfaded into the next.
 */
async function joinSound(files, out) {
  if (files.length === 1) { await run(["-hide_banner", "-y", "-i", files[0], out]); return out; }
  const levels = await Promise.all(files.map(meanVolume));
  const known = levels.filter((v) => v != null).sort((a, b) => a - b), target = known.length ? known[known.length >> 1] : null;
  const gain = (v) => (v == null || target == null ? 0 : Math.max(-12, Math.min(18, target - v)));
  const args = ["-hide_banner", "-y"], steps = [];
  files.forEach((f, i) => { args.push("-i", f); steps.push(`[${i}:a]volume=${gain(levels[i]).toFixed(1)}dB[w${i}]`); });
  let last = "[w0]";
  for (let i = 1; i < files.length; i++) {
    const to = i === files.length - 1 ? "[out]" : `[x${i}]`;
    steps.push(`${last}[w${i}]acrossfade=d=${SOUND_OVERLAP}:c1=tri:c2=tri${to}`); last = to;
  }
  await run([...args, "-filter_complex", steps.join(";"), "-map", "[out]", out]);
  return out;
}

/**
 * Final MP4: the silent video with the sound track and/or the speech (starting at speechStart s),
 * sound ducked under speech, a limiter against clipping, cut or padded to the video's length.
 * The video stream is copied, not re-encoded.
 */
async function mux({ video, sound, speech, out, seconds, soundVolume = 1, speechVolume = 1, speechStart = 0.3 }) {
  const args = ["-hide_banner", "-y", "-i", video], chains = [], mix = [];
  if (sound) { args.push("-i", sound); chains.push(`[${mix.length + 1}:a]volume=${speech ? soundVolume * 0.55 : soundVolume}[a${mix.length}]`); mix.push(`[a${mix.length}]`); }
  if (speech) {
    const ms = Math.round(speechStart * 1000);
    args.push("-i", speech); chains.push(`[${mix.length + 1}:a]adelay=${ms}:all=1,volume=${speechVolume}[a${mix.length}]`); mix.push(`[a${mix.length}]`);
  }
  if (!mix.length) throw new Error("no audio to add");
  // EBU R128 loudness for video (-16 LUFS, peaks under -1.5 dB): the raw models' output is quiet (about -29 dB on average)
  const tail = "loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.9,apad,aresample=48000[out]";
  const graph = mix.length === 1 ? `${chains[0]};${mix[0]}${tail}` : `${chains.join(";")};${mix.join("")}amix=inputs=${mix.length}:duration=longest:normalize=0,${tail}`;
  await run([...args, "-filter_complex", graph, "-map", "0:v", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ac", "2",
    "-t", seconds.toFixed(3), "-movflags", "+faststart", out]);
  return out;
}

module.exports = { WAN_FPS, MAX_SECONDS, PART_FRAMES, SPEAKERS, framesFor, partPlan, keyframePlan, soundWindows, videoGraph, soundGraph, speechGraph,
  duration, frameAt, joinParts, joinSound, mux };
