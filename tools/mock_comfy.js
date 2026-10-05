// Mock ComfyUI for testing SpriteForge without a GPU.
// Returns `length` frames of the uploaded green-screen image with a small bob + sway,
// sends progress over WebSocket, and serves results through /history and /view.
// Run: node tools/mock_comfy.js  (listens on 8188)
const http = require("http");
const { WebSocketServer } = require("ws");
const sharp = require("sharp");
const crypto = require("crypto");

const uploads = new Map(), outputs = new Map(), history = {};
const sockets = new Set();
const send = (obj) => sockets.forEach((s) => s.readyState === 1 && s.send(JSON.stringify(obj)));

function readBody(req) {
  return new Promise((res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => res(Buffer.concat(c))); });
}

function parseMultipart(buf, boundary) {
  const parts = {}, sep = Buffer.from("--" + boundary);
  let i = buf.indexOf(sep);
  while (i !== -1) {
    const next = buf.indexOf(sep, i + sep.length); if (next === -1) break;
    const part = buf.slice(i + sep.length + 2, next - 2);
    const h = part.indexOf("\r\n\r\n"), head = part.slice(0, h).toString(), body = part.slice(h + 4);
    const name = /name="([^"]+)"/.exec(head)[1], file = /filename="([^"]+)"/.exec(head);
    parts[name] = file ? { filename: file[1], data: body } : body.toString();
    i = next;
  }
  return parts;
}

async function generate(pid, wf) {
  const load = Object.values(wf).find((n) => n.class_type === "LoadImage");
  const lenNode = Object.values(wf).find((n) => n.inputs && typeof n.inputs.length === "number");
  const save = Object.entries(wf).find(([, n]) => n.class_type === "SaveImage");
  const src = uploads.get(load.inputs.image);
  const L = lenNode ? lenNode.inputs.length : 33;
  const meta = await sharp(src).metadata();
  const frames = [];
  for (let i = 0; i < L; i++) {
    const t = (i / (L - 1)) * Math.PI * 2;
    const dy = Math.round(Math.sin(t) * 6), ang = Math.sin(t) * 2.5;
    const rotated = await sharp(src).rotate(ang, { background: { r: 0, g: 255, b: 0 } }).resize(meta.width, meta.height, { fit: "cover" }).toBuffer();
    const frame = await sharp({ create: { width: meta.width, height: meta.height, channels: 3, background: { r: 0, g: 255, b: 0 } } })
      .composite([{ input: rotated, left: 0, top: dy }]).png().toBuffer();
    const name = `${save[1].inputs.filename_prefix.replace(/\//g, "_")}_${String(i).padStart(5, "0")}_.png`;
    outputs.set(name, frame); frames.push({ filename: name, subfolder: "", type: "output" });
    send({ type: "progress", data: { value: i + 1, max: L, prompt_id: pid } });
    await new Promise((r) => setTimeout(r, +process.env.MOCK_FRAME_MS || 15));
  }
  history[pid] = { status: { completed: true, status_str: "success" }, outputs: { [save[0]]: { images: frames } } };
  send({ type: "executing", data: { node: null, prompt_id: pid } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (url.pathname === "/system_stats") return json({ devices: [{ name: "cuda:0 Mock GPU (no real model)" }] });
  if (url.pathname === "/upload/image" && req.method === "POST") {
    const b = /boundary=(.+)$/.exec(req.headers["content-type"])[1];
    const p = parseMultipart(await readBody(req), b);
    uploads.set(p.image.filename, p.image.data);
    return json({ name: p.image.filename, subfolder: "", type: "input" });
  }
  if (url.pathname === "/prompt" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString());
    const pid = crypto.randomUUID();
    history[pid] = { status: { completed: false }, outputs: {} };
    setTimeout(() => generate(pid, body.prompt).catch((e) => { history[pid] = { status: { status_str: "error", messages: [["execution_error", { exception_message: e.message }]] }, outputs: {} }; }), 50);
    return json({ prompt_id: pid, number: 1, node_errors: {} });
  }
  if (url.pathname === "/queue") {
    const running = Object.entries(history).filter(([, h]) => !h.status.completed && h.status.status_str !== "error").map(([pid]) => [1, pid, {}, {}, []]);
    return json({ queue_running: running, queue_pending: [] });
  }
  if (url.pathname.startsWith("/history/")) {
    const pid = url.pathname.split("/")[2];
    return json(history[pid] && history[pid].status.completed ? { [pid]: history[pid] } : history[pid] && history[pid].status.status_str === "error" ? { [pid]: history[pid] } : {});
  }
  if (url.pathname === "/view") {
    const f = outputs.get(url.searchParams.get("filename"));
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "image/png" }); return res.end(f);
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
server.listen(+process.env.MOCK_PORT || 8188, () => console.log("Mock ComfyUI on :" + (process.env.MOCK_PORT || 8188)));
