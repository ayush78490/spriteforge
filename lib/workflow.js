// Patch an exported ComfyUI *API-format* workflow (Workflow > Export (API)) for one job.
// Works with Wan 2.x image-to-video graphs (14B MoE two-sampler, 5B TI2V, first-last-frame)
// by tracing links instead of relying on hard-coded node ids.
const I2V_NODES = ["WanImageToVideo", "WanFirstLastFrameToVideo", "Wan22ImageToVideoLatent", "WanFunInpaintToVideo"];
const SAMPLERS = ["KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"];
const TEXT_NODES = ["CLIPTextEncode", "WanVideoTextEncode", "TextEncodeWan"];

const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string";

// Walk upstream from nodeId until a node of one of `classes` is found.
// `prefer` ("positive"/"negative"/...) is followed first so a node like WanImageToVideo,
// which carries both conditionings, leads to the right text encoder.
function traceTo(wf, nodeId, classes, prefer, seen = new Set()) {
  if (!wf[nodeId] || seen.has(nodeId)) return null;
  seen.add(nodeId);
  const n = wf[nodeId];
  if (classes.includes(n.class_type)) return nodeId;
  const other = prefer === "negative" ? "positive" : "negative";
  const rank = (k) => (k === prefer ? 0 : k === other ? 9 : /cond/.test(k) ? 1 : 5);
  const keys = Object.keys(n.inputs || {}).sort((a, b) => rank(a) - rank(b));
  for (const k of keys) {
    if (k === other) continue; // never cross over to the opposite conditioning
    const v = n.inputs[k];
    if (isLink(v)) {
      const hit = traceTo(wf, v[0], classes, prefer, seen);
      if (hit) return hit;
    }
  }
  return null;
}

function traceInput(wf, fromIds, inputName, classes) {
  for (const id of fromIds) {
    const v = wf[id].inputs && wf[id].inputs[inputName];
    if (isLink(v)) {
      const hit = traceTo(wf, v[0], classes, inputName);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * @param {object} template  API workflow JSON
 * @param {object} p  {image, endImage?, positive, negative, width, height, length, seed, prefix}
 * @returns {{workflow, report, outputNodeIds}}
 */
function patchWorkflow(template, p) {
  const wf = JSON.parse(JSON.stringify(template));
  const report = [];
  const ids = Object.keys(wf);
  const byClass = (classes) => ids.filter((id) => classes.includes(wf[id].class_type));

  // --- images
  const i2v = byClass(I2V_NODES);
  const loadImages = byClass(["LoadImage"]);
  let startNode = traceInput(wf, i2v, "start_image", ["LoadImage"]);
  let endNode = traceInput(wf, i2v, "end_image", ["LoadImage"]);
  if (!startNode && loadImages.length) startNode = loadImages[0];
  if (!startNode) throw new Error("Workflow has no LoadImage node for the character image.");
  wf[startNode].inputs.image = p.image;
  report.push(`start image -> node ${startNode}`);
  if (endNode) {
    wf[endNode].inputs.image = p.endImage || p.image;
    report.push(`end image -> node ${endNode}`);
  }

  // --- size / length on every node that has them as plain numbers
  for (const id of ids) {
    const inp = wf[id].inputs || {};
    for (const [k, v] of [["width", p.width], ["height", p.height], ["length", p.length]]) {
      if (v != null && typeof inp[k] === "number") { inp[k] = v; report.push(`${k}=${v} -> node ${id}`); }
    }
  }

  // --- prompts: trace sampler.positive / sampler.negative back to text encoders
  const samplers = byClass(SAMPLERS);
  const guiderPos = samplers.length ? traceInput(wf, samplers, "positive", TEXT_NODES) : null;
  const guiderNeg = samplers.length ? traceInput(wf, samplers, "negative", TEXT_NODES) : null;
  let posNode = guiderPos || traceInput(wf, i2v, "positive", TEXT_NODES);
  let negNode = guiderNeg || traceInput(wf, i2v, "negative", TEXT_NODES);
  const texts = byClass(TEXT_NODES);
  if (!posNode || !negNode) {
    for (const id of texts) {
      const title = ((wf[id]._meta && wf[id]._meta.title) || "").toLowerCase();
      if (!negNode && title.includes("neg")) negNode = id;
      else if (!posNode && !title.includes("neg")) posNode = id;
    }
  }
  if (!posNode) throw new Error("Could not find the positive prompt node.");
  const textKey = (id) => ("text" in wf[id].inputs ? "text" : "positive_prompt" in wf[id].inputs ? "positive_prompt" : "text");
  wf[posNode].inputs[textKey(posNode)] = p.positive;
  report.push(`positive prompt -> node ${posNode}`);
  if (negNode && negNode !== posNode) {
    wf[negNode].inputs[textKey(negNode)] = p.negative;
    report.push(`negative prompt -> node ${negNode}`);
  }

  // --- seed
  for (const id of ids) {
    const inp = wf[id].inputs || {};
    for (const k of ["seed", "noise_seed"]) if (typeof inp[k] === "number") { inp[k] = p.seed; report.push(`${k} -> node ${id}`); }
  }

  // --- outputs: make sure decoded frames are saved as PNGs
  let saves = byClass(["SaveImage"]);
  if (!saves.length) {
    const decode = byClass(["VAEDecode", "VAEDecodeTiled", "WanVideoDecode"]);
    if (!decode.length) throw new Error("No VAEDecode node found to take frames from.");
    const newId = String(Math.max(...ids.map((x) => parseInt(x, 10) || 0)) + 1000);
    wf[newId] = { class_type: "SaveImage", inputs: { images: [decode[decode.length - 1], 0], filename_prefix: p.prefix }, _meta: { title: "SpriteForge frames" } };
    saves = [newId];
    report.push(`added SaveImage node ${newId}`);
  }
  for (const id of saves) wf[id].inputs.filename_prefix = p.prefix;

  return { workflow: wf, report, outputNodeIds: saves };
}

module.exports = { patchWorkflow };
