// FLUX.1 Kontext [dev] image generation / editing graph (ComfyUI API format).
// With a source image it edits that image (e.g. "turn to a side view"); without one it is text-to-image.
const KONTEXT = {
  unet: "flux1-kontext-dev-Q4_K_M.gguf",
  clipL: "clip_l.safetensors",
  t5: "t5xxl_fp8_e4m3fn_scaled.safetensors",
  vae: "ae.safetensors",
};

const IMAGE_PRESETS = [
  { id: "side", label: "Side view (walk-ready)", prompt: "Turn this character to a full side view facing right, standing mid-step with both legs clearly visible. Keep the exact same outfit, colors, proportions and art style. Full body, plain white background." },
  { id: "front", label: "Front view", prompt: "Show this character from the front, standing straight, full body visible. Keep the exact same outfit, colors and art style. Plain white background." },
  { id: "back", label: "Back view", prompt: "Show this character from behind, full body visible. Keep the exact same outfit, colors and art style. Plain white background." },
  { id: "stance", label: "Fighting stance", prompt: "Put this character in a side-view fighting stance facing right, fists raised, knees slightly bent, full body visible. Keep the exact same outfit, colors and art style. Plain white background." },
  { id: "clean", label: "Clean background", prompt: "Remove the background and place the full-body character on a plain white background. Do not change the character." },
];

/**
 * @param {object} p {image?: uploaded ComfyUI filename, images?: several of them (references to combine),
 *   prompt, width, height, steps, guidance, seed, prefix}
 * @returns {{workflow, outputNodeIds}}
 */
function buildKontextWorkflow(p) {
  if (p.images && p.images.length) return buildKontextMulti(p);
  const n = (class_type, inputs, title) => ({ class_type, inputs, _meta: { title } });
  const wf = {
    1: n("UnetLoaderGGUF", { unet_name: KONTEXT.unet }, "Load FLUX Kontext (GGUF)"),
    2: n("DualCLIPLoader", { clip_name1: KONTEXT.clipL, clip_name2: KONTEXT.t5, type: "flux", device: "default" }, "Load text encoders"),
    3: n("VAELoader", { vae_name: KONTEXT.vae }, "Load VAE"),
    4: n("CLIPTextEncode", { clip: ["2", 0], text: p.prompt }, "Prompt"),
  };
  let cond = ["4", 0], latent;
  if (p.image) {
    wf[5] = n("LoadImage", { image: p.image }, "Source image");
    wf[6] = n("FluxKontextImageScale", { image: ["5", 0] }, "Scale to Kontext size");
    wf[7] = n("VAEEncode", { pixels: ["6", 0], vae: ["3", 0] }, "Encode source");
    wf[8] = n("ReferenceLatent", { conditioning: ["4", 0], latent: ["7", 0] }, "Reference");
    cond = ["8", 0]; latent = ["7", 0];
  } else {
    wf[7] = n("EmptySD3LatentImage", { width: p.width, height: p.height, batch_size: 1 }, "Empty latent");
    latent = ["7", 0];
  }
  wf[9] = n("FluxGuidance", { conditioning: cond, guidance: p.guidance }, "Guidance");
  wf[10] = n("ConditioningZeroOut", { conditioning: ["4", 0] }, "Empty negative");
  wf[11] = n("KSampler", { model: ["1", 0], seed: p.seed, steps: p.steps, cfg: 1, sampler_name: "euler", scheduler: "simple",
    positive: ["9", 0], negative: ["10", 0], latent_image: latent, denoise: 1 }, "Sampler");
  wf[12] = n("VAEDecode", { samples: ["11", 0], vae: ["3", 0] }, "Decode");
  wf[13] = n("SaveImage", { images: ["12", 0], filename_prefix: p.prefix }, "Save image");
  return { workflow: wf, outputNodeIds: ["13"] };
}

/**
 * Several reference images combined into a new picture (e.g. a character, a place and an object): every image
 * is its own ReferenceLatent on the prompt, and the picture is drawn fresh at width x height. References are
 * shrunk to 0.5 MP each so three of them still fit a 6 GB card.
 */
function buildKontextMulti(p) {
  const n = (class_type, inputs, title) => ({ class_type, inputs, _meta: { title } });
  const wf = {
    1: n("UnetLoaderGGUF", { unet_name: KONTEXT.unet }, "Load FLUX Kontext (GGUF)"),
    2: n("DualCLIPLoader", { clip_name1: KONTEXT.clipL, clip_name2: KONTEXT.t5, type: "flux", device: "default" }, "Load text encoders"),
    3: n("VAELoader", { vae_name: KONTEXT.vae }, "Load VAE"),
    4: n("CLIPTextEncode", { clip: ["2", 0], text: p.prompt }, "Prompt"),
  };
  let cond = ["4", 0];
  p.images.forEach((img, i) => {
    const id = 20 + i * 4;
    wf[id] = n("LoadImage", { image: img }, `Reference ${i + 1}`);
    wf[id + 1] = n("ImageScaleToTotalPixels", { image: [String(id), 0], upscale_method: "lanczos", megapixels: 0.5, resolution_steps: 16 }, `Shrink ${i + 1}`);
    wf[id + 2] = n("VAEEncode", { pixels: [String(id + 1), 0], vae: ["3", 0] }, `Encode ${i + 1}`);
    wf[id + 3] = n("ReferenceLatent", { conditioning: cond, latent: [String(id + 2), 0] }, `Reference ${i + 1}`);
    cond = [String(id + 3), 0];
  });
  wf[7] = n("EmptySD3LatentImage", { width: p.width, height: p.height, batch_size: 1 }, "Empty latent");
  wf[9] = n("FluxGuidance", { conditioning: cond, guidance: p.guidance }, "Guidance");
  wf[10] = n("ConditioningZeroOut", { conditioning: ["4", 0] }, "Empty negative");
  wf[11] = n("KSampler", { model: ["1", 0], seed: p.seed, steps: p.steps, cfg: 1, sampler_name: "euler", scheduler: "simple",
    positive: ["9", 0], negative: ["10", 0], latent_image: ["7", 0], denoise: 1 }, "Sampler");
  wf[12] = n("VAEDecode", { samples: ["11", 0], vae: ["3", 0] }, "Decode");
  wf[13] = n("SaveImage", { images: ["12", 0], filename_prefix: p.prefix }, "Save image");
  return { workflow: wf, outputNodeIds: ["13"] };
}

module.exports = { buildKontextWorkflow, IMAGE_PRESETS, KONTEXT };
