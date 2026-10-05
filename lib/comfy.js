// Minimal ComfyUI HTTP/WebSocket client.
// Docs: POST /upload/image, POST /prompt, GET /history/{id}, GET /view, WS /ws?clientId=
const WebSocket = require("ws");
const crypto = require("crypto");

class ComfyClient {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, "");
    this.clientId = crypto.randomUUID();
  }

  async ping() {
    const r = await fetch(`${this.base}/system_stats`);
    if (!r.ok) throw new Error(`ComfyUI not reachable at ${this.base} (${r.status})`);
    return r.json();
  }

  async uploadImage(buffer, filename) {
    const form = new FormData();
    form.append("image", new Blob([buffer], { type: "image/png" }), filename);
    form.append("overwrite", "true");
    const r = await fetch(`${this.base}/upload/image`, { method: "POST", body: form });
    if (!r.ok) throw new Error(`upload failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  async queue(workflow) {
    const r = await fetch(`${this.base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const detail = j.node_errors ? JSON.stringify(j.node_errors).slice(0, 800) : JSON.stringify(j).slice(0, 800);
      throw new Error(`ComfyUI rejected the workflow: ${detail}`);
    }
    return j.prompt_id;
  }

  /**
   * Wait for a prompt to finish. Resolves with the history entry.
   * onProgress({node}) when a node starts executing, onProgress({node, value, max}) for sampler steps.
   */
  wait(promptId, onProgress = () => {}, timeoutMs = 60 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      const wsUrl = this.base.replace(/^http/, "ws") + `/ws?clientId=${this.clientId}`;
      let ws;
      let done = false;
      const finish = async (err) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        try { ws && ws.close(); } catch {}
        if (err) return reject(err);
        try { resolve(await this.history(promptId)); } catch (e) { reject(e); }
      };
      const timer = setTimeout(() => finish(new Error("ComfyUI job timed out")), timeoutMs);
      // Polling fallback (also catches the case where the WS message was missed), and notices when
      // ComfyUI restarted/crashed and forgot the prompt, instead of waiting for the timeout.
      let missing = 0, unreachableSince = null;
      const poll = setInterval(async () => {
        try {
          const h = await this.history(promptId);
          unreachableSince = null;
          if (h && h.status && h.status.completed) return finish();
          if (h && h.status && h.status.status_str === "error") return finish(new Error(historyError(h)));
          if (!h) {
            const q = await (await fetch(`${this.base}/queue`)).json();
            const queued = [...(q.queue_running || []), ...(q.queue_pending || [])].some((e) => e[1] === promptId);
            missing = queued ? 0 : missing + 1;
            if (missing >= 3) finish(new Error("ComfyUI lost this job (it was restarted or crashed). Press Retry."));
          }
        } catch {
          unreachableSince = unreachableSince || Date.now();
          if (Date.now() - unreachableSince > 60000) finish(new Error("ComfyUI stopped responding. Press Retry once it is running again."));
        }
      }, 3000);
      try {
        ws = new WebSocket(wsUrl);
        ws.on("message", (data, isBinary) => {
          if (isBinary) return; // preview images
          let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
          const d = msg.data || {};
          if (d.prompt_id && d.prompt_id !== promptId) return;
          if (msg.type === "progress") onProgress({ node: d.node, value: d.value, max: d.max });
          else if (msg.type === "executing" && d.node === null) finish();
          else if (msg.type === "executing") onProgress({ node: d.node });
          else if (msg.type === "execution_error") finish(new Error(d.exception_message || "execution error"));
        });
        ws.on("error", () => {}); // polling keeps working
      } catch {}
    });
  }

  /** RAM figures from the spriteforge_ram_guard custom node, or null if it isn't installed. */
  async memory() {
    try {
      const r = await fetch(`${this.base}/spriteforge/memory`, { signal: AbortSignal.timeout(2000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  /**
   * Unload models and release ComfyUI's cached RAM/VRAM, and wait until the VRAM is really back.
   * ComfyUI only acts on /free between prompts, after taking the next one off the queue, so a prompt
   * queued right after it would still find the old models on the GPU (MMAudio then runs out of memory).
   */
  async free({ wait = true } = {}) {
    await fetch(`${this.base}/free`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }) });
    if (!wait) return;
    const held = async () => { const d = ((await this.ping()).devices || [])[0]; return d && d.torch_vram_total != null ? d.torch_vram_total : null; };
    for (let t = 0, last = null; t < 20; t++) { // up to ~10 s
      const now = await held().catch(() => null);
      if (now == null || now < 512 * 1048576 || (last != null && now === last && t >= 4)) return;
      last = now;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async history(promptId) {
    const r = await fetch(`${this.base}/history/${promptId}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j[promptId] || null;
  }

  /** All images produced by SaveImage/PreviewImage-style nodes, in order. */
  async outputImages(historyEntry, preferNodeIds = []) {
    const outs = historyEntry.outputs || {};
    let ids = Object.keys(outs);
    if (preferNodeIds.length) ids = ids.filter((id) => preferNodeIds.includes(id)).concat(ids.filter((id) => !preferNodeIds.includes(id)));
    for (const id of ids) {
      const imgs = (outs[id].images || []).filter((im) => /\.(png|jpg|jpeg|webp)$/i.test(im.filename));
      if (imgs.length > 1 || (imgs.length === 1 && preferNodeIds.includes(id))) {
        const bufs = [];
        for (const im of imgs) bufs.push(await this.view(im));
        return bufs;
      }
    }
    throw new Error("Workflow finished but produced no image frames. Make sure it ends with a SaveImage node on the decoded frames.");
  }

  async view({ filename, subfolder = "", type = "output" }) {
    const q = new URLSearchParams({ filename, subfolder, type });
    const r = await fetch(`${this.base}/view?${q}`);
    if (!r.ok) throw new Error(`could not download ${filename}`);
    return Buffer.from(await r.arrayBuffer());
  }
}

function historyError(h) {
  const msgs = (h.status && h.status.messages) || [];
  const err = msgs.find((m) => m[0] === "execution_error");
  return err ? err[1].exception_message : "ComfyUI execution error";
}

module.exports = { ComfyClient };
