// Scene Kit worker: the object finder and cut-out models run in this child process, not in the server.
// ONNX Runtime runs inference on the calling thread, so in the server it would freeze the UI for seconds;
// and when this process exits after a few idle minutes, Windows gets every byte of its RAM back.
// The server talks to it through SceneWorker below (one request at a time, progress messages in between).
const path = require("path");
const { fork } = require("child_process");

const MB = 1048576;
const NEED = { analyze: 700 * MB, add: 300 * MB }; // RAM a step needs when its models aren't loaded yet

class SceneWorker {
  /** @param {{cacheDir: string, roomFor: (bytes:number, stage:(s:string)=>void) => Promise<void>}} o */
  constructor(o) { this.o = o; this.proc = null; this.calls = new Map(); this.seq = 0; this.loaded = { det: false, sam: false }; }

  start() {
    if (this.proc) return this.proc;
    const p = fork(__filename, [], { serialization: "advanced", env: { ...process.env, SPRITEFORGE_SCENE_CACHE: this.o.cacheDir }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    p.on("message", (m) => {
      const c = this.calls.get(m.id); if (!c) return;
      if (m.stage != null) return c.stage(m.stage, m.f);
      this.calls.delete(m.id);
      if (m.loaded) this.loaded = m.loaded;
      m.error ? c.reject(new Error(m.error)) : c.resolve(m.result);
    });
    p.on("error", () => {}); // a failed send is reported by call(); an exit by the handler below
    p.on("exit", (code) => {
      if (this.proc === p) { this.proc = null; this.loaded = { det: false, sam: false }; }
      for (const c of this.calls.values()) c.reject(new Error(code ? `The object finder stopped (exit ${code}). Try again.` : "The object finder was stopped."));
      this.calls.clear();
    });
    return (this.proc = p);
  }

  async call(op, args, stage = () => {}) {
    const needs = op === "analyze" ? !this.loaded.det || !this.loaded.sam : !this.loaded.sam;
    if (needs) await this.o.roomFor(NEED[op], stage);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject, stage });
      try { this.start().send({ id, op, ...args }); } catch (e) { this.calls.delete(id); this.proc = null; reject(e); } // it was just exiting (idle)
    });
  }

  /** Find labels in the picture file and cut every object out: [{label, score, png, x, y, w, h, hidden, cut}]. */
  analyze(file, labels, { skip = [], stage } = {}) { return this.call("analyze", { file, labels, skip }, stage); }
  /** One object picked by hand: {part, alpha}. */
  add(file, prompt, label, stage) { return this.call("add", { file, prompt, label }, stage); }
  stop() { if (this.proc) this.proc.kill(); }
}

// ------------------------------------------------------------------ the child process
if (require.main === module && process.send) {
  const sharp = require("sharp");
  const SC = require("./scene");
  const ai = new SC.SceneAI({ cacheDir: process.env.SPRITEFORGE_SCENE_CACHE || path.join(__dirname, "..", "data", "models"), onIdle: () => process.exit(0) });
  let cached = null; // the last picture's pixels, reused by every request about it
  const load = async (file) => {
    if (cached && cached.file === file) return cached.img;
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    cached = { file, img: { data, w: info.width, h: info.height } };
    return cached.img;
  };
  let chain = Promise.resolve();
  process.on("message", (m) => {
    chain = chain.then(async () => {
      const stage = (text, f) => process.send({ id: m.id, stage: text, f });
      try {
        const img = await load(m.file);
        let result;
        if (m.op === "analyze") result = await SC.analyzeImage(ai, img, m.labels, { skip: m.skip, key: m.file, stage });
        else if (m.op === "add") result = await SC.cutByHand(ai, img, m.prompt, m.label, { key: m.file, stage });
        else throw new Error(`unknown step ${m.op}`);
        ai.touch();
        process.send({ id: m.id, result, loaded: { det: !!ai.det, sam: !!ai.sam } });
      } catch (e) {
        process.send({ id: m.id, error: String((e && e.message) || e), loaded: { det: !!ai.det, sam: !!ai.sam } });
      }
    });
  });
  process.on("disconnect", () => process.exit(0)); // the server went away
}

module.exports = { SceneWorker };
