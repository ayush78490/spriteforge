/* SpriteForge front-end (no build step). */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = async (url, opts = {}) => {
  const r = await fetch(url, opts.body && !(opts.body instanceof FormData)
    ? { ...opts, headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) } : opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
/** Toast with an optional action button: toast("Ready", false, {label: "Download", run: fn}). */
function toast(msg, err, action) {
  const t = $("#toast"), b = t.querySelector("button");
  t.firstElementChild.textContent = msg; t.className = "show" + (err ? " err" : "");
  b.hidden = !action; if (action) { b.textContent = action.label; b.onclick = () => { t.className = ""; action.run(); }; }
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ""), action ? 12000 : err ? 6000 : 3200);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const nice = (s) => String(s).replace(/_/g, " ");
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const gb = (b) => (b / 1073741824).toFixed(1);
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const dur = (s) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);
const svgUse = (id) => `<svg><use href="#${id}"/></svg>`;
const VIEWS = ["side", "front", "back"];
const viewOf = (c) => c.view || "side";
const groupOf = (c) => c.group || c.id;
const isActive = (j) => j.status === "queued" || j.status === "running";

const state = {
  chars: [], jobs: new Map(), actions: [], presets: [], charId: null, selected: new Set(),
  set: store.get("sf.set") || "fighter", category: "all", filter: "", layout: store.get("sf.layout") || "grid",
  fmt: store.get("sf.fmt") || "png", bg: store.get("sf.bg") || "transparent",
  extraPrompt: "", seed: "", config: null, workflows: [], view: "animate", stats: null,
  batch: null, // {charId, ids:Set} of the last Generate click, for the "all ready" message
  studio: { source: "character", characterId: null, imageJobId: null, file: null, fileUrl: null, preset: null, mode: store.get("sf.studioMode") || "image",
    multi: [], multiMode: store.get("sf.multiMode") || "keyframes" }, // several images for a clip: [{file, url}]
};

// ------------------------------------------------------------------ boot
(async function boot() {
  const [a, presets] = await Promise.all([api("/api/actions"), api("/api/image-presets")]);
  state.actions = a.actions; state.presets = presets;
  await Promise.all([loadConfig(), Scene.init()]); // scene.js has loaded by the time the first fetch resolves
  state.chars = await api("/api/characters");
  (await api("/api/jobs")).forEach((j) => state.jobs.set(j.id, j));
  if (store.get("sf.hero") === "hidden") $("#hero").hidden = true;
  $("#setSel").value = state.set;
  setLayout(state.layout); setFmt(state.fmt); setBg(state.bg);
  const last = store.get("sf.char");
  if (state.chars.length) selectChar(state.chars.some((c) => c.id === last) ? last : state.chars[state.chars.length - 1].id);
  else showEmpty();
  const want = location.hash.slice(1) || store.get("sf.view");
  setView(["studio", "scene", "nft"].includes(want) ? want : "animate");
  buildMeters(); renderNow(); setInterval(renderNow, 1000);
  renderNotes(); initApps();
  connectEvents(); checkComfy(); setInterval(checkComfy, 15000);
  requestAnimationFrame(animate);
})();

async function loadConfig() { const c = await api("/api/config"); state.config = c.config; state.workflows = c.workflows; }

async function checkComfy() {
  const el = $("#comfyStatus");
  try {
    const s = await api("/api/status");
    el.className = "status " + (s.ok ? "ok" : "bad");
    el.lastElementChild.textContent = s.ok ? "ComfyUI Connected" : "ComfyUI offline";
    el.title = s.ok ? (s.devices || []).join("\n") : s.error;
  } catch { el.className = "status bad"; el.lastElementChild.textContent = "Server offline"; }
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("job", (e) => { const j = JSON.parse(e.data), old = state.jobs.get(j.id); state.jobs.set(j.id, j); onJobChange(j, old); });
  es.addEventListener("jobDeleted", (e) => { state.jobs.delete(JSON.parse(e.data).id); renderAll(); renderImages(); renderNow(); });
  es.addEventListener("character", async () => { state.chars = await api("/api/characters"); renderChars(); renderGenCard(); if (state.view === "studio") renderSource(); });
  es.addEventListener("reload", () => location.reload());
  es.addEventListener("scene", (e) => Scene.onScene(JSON.parse(e.data)));
  es.addEventListener("sceneDeleted", (e) => Scene.onDeleted(JSON.parse(e.data).id));
  es.addEventListener("nft", (e) => { if (typeof NFT !== "undefined") NFT.onEvent(JSON.parse(e.data)); });
  es.addEventListener("stats", (e) => onStats(JSON.parse(e.data)));
}

// ------------------------------------------------------------------ views
function setView(v) {
  state.view = v; store.set("sf.view", v);
  if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
  $$("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  $("#viewAnimate").hidden = v !== "animate"; $("#viewStudio").hidden = v !== "studio"; $("#viewScene").hidden = v !== "scene"; $("#viewNft").hidden = v !== "nft";
  $("#genCard").hidden = v !== "animate"; // animation settings only apply on the Animate page
  $("#sceneCard").hidden = v !== "scene";
  $("#charSide").hidden = v === "scene" || v === "nft"; $("#sceneSide").hidden = v !== "scene";
  $(".right").hidden = v === "nft"; // NFT view has its own side panel
  if (v === "studio") renderStudio();
  if (v === "scene") Scene.show();
  if (v === "nft" && typeof NFT !== "undefined") NFT.show();
}
$$("#nav button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
$("#heroHide").onclick = () => { $("#hero").hidden = true; store.set("sf.hero", "hidden"); };

// ------------------------------------------------------------------ upload (tile, empty state, drag & drop)
async function uploadCharacter(file) {
  if (!file || !/^image\//.test(file.type)) return toast("Please choose an image file (PNG or JPG).", true);
  const tile = $("#uploadTile"); tile.classList.add("busy");
  try {
    const fd = new FormData(); fd.append("image", file);
    const c = await api("/api/characters", { method: "POST", body: fd });
    if (!state.chars.some((x) => x.id === c.id)) state.chars.push(c);
    selectChar(c.id); setView("animate");
    toast(`${nice(c.name)} added. Select animations and press Generate.`);
  } catch (e) { toast(e.message, true); }
  tile.classList.remove("busy");
}
$("#uploadInput").onchange = (e) => { uploadCharacter(e.target.files[0]); e.target.value = ""; };
$(".upload-proxy").onchange = (e) => { uploadCharacter(e.target.files[0]); e.target.value = ""; };
$("#addChar").onclick = () => $("#uploadInput").click();

let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (![...(e.dataTransfer.types || [])].includes("Files")) return; dragDepth++;
  $("#dropOverlay").firstElementChild.textContent = state.view === "studio" ? "Drop image to edit it" : state.view === "scene" ? "Drop a landscape to break it into sprites" : "Drop image to add a character";
  $("#dropOverlay").hidden = false; });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropOverlay").hidden = true; } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("#dropOverlay").hidden = true;
  const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (!f) return;
  if (state.view === "studio" && state.studio.mode === "clip" && (state.studio.source === "multi" || e.dataTransfer.files.length > 1)) addMultiFiles(e.dataTransfer.files);
  else if (state.view === "studio") setStudioFile(f); else if (state.view === "scene") Scene.upload(f); else uploadCharacter(f);
});

// ------------------------------------------------------------------ characters
const charImgUrl = (c) => `/api/characters/${c.id}/image?v=${c.version || 1}`;
const cur = () => state.chars.find((x) => x.id === state.charId);
const jobsFor = (cid) => [...state.jobs.values()].filter((j) => j.characterId === cid && j.kind !== "image");
function latestByAction(cid) {
  const m = {};
  for (const j of jobsFor(cid).sort((a, b) => a.created - b.created)) m[j.action] = j;
  return m;
}
/** Latest finished job per action (what "Download all" packs). */
function finishedByAction(cid) {
  const m = {};
  for (const j of jobsFor(cid).filter((x) => x.status === "done" && x.frameCount).sort((a, b) => (a.finished || 0) - (b.finished || 0))) m[j.action] = j;
  return m;
}
const doneCount = (cid) => Object.keys(finishedByAction(cid)).length;

function charItem(c, on, onClick, sub) {
  const el = document.createElement("div");
  el.className = "char-item" + (on ? " on" : "");
  el.innerHTML = `<img src="${charImgUrl(c)}" alt=""><div><b></b><small></small></div>`;
  el.querySelector("b").textContent = nice(c.name);
  el.querySelector("small").innerHTML = sub;
  el.onclick = onClick;
  return el;
}

/** Left list: one entry per character group (its view angles live in the Generation Settings card). */
function renderChars() {
  const list = $("#charList"); list.innerHTML = "";
  if (!state.chars.length) { list.innerHTML = `<div class="side-empty">No characters yet.</div>`; return; }
  const groups = new Map();
  for (const c of state.chars) { const g = groupOf(c); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
  const active = cur();
  for (const [g, members] of groups) {
    const rep = active && groupOf(active) === g ? active : members.find((m) => viewOf(m) === "side") || members[0];
    const busy = members.some((m) => jobsFor(m.id).some(isActive));
    const n = members.reduce((t, m) => t + doneCount(m.id), 0);
    list.appendChild(charItem(rep, active && groupOf(active) === g, () => { selectChar(rep.id); setView("animate"); },
      busy ? `<span class="busy-dot"></span>generating…` : `${n} animation${n === 1 ? "" : "s"}`));
  }
}

function showEmpty() { $("#empty").hidden = false; $("#animPane").hidden = true; renderGenCard(); }

function selectChar(id) {
  const c = state.chars.find((x) => x.id === id);
  if (!c) { state.charId = null; renderChars(); return showEmpty(); }
  if (state.charId !== id) state.selected.clear();
  state.charId = id; store.set("sf.char", id);
  $("#empty").hidden = true; $("#animPane").hidden = false;
  renderAll();
}
function renderAll() { renderChars(); renderGenCard(); renderGrid(); }

// ------------------------------------------------------------------ generation settings card
function renderGenCard() {
  const c = cur();
  $("#gsImg").src = c ? charImgUrl(c) : ""; $("#gsImg").hidden = !c;
  $("#gsName").textContent = c ? nice(c.name) : "No character";
  const n = c ? doneCount(c.id) : 0;
  $("#gsSub").textContent = c ? `${n} animation${n === 1 ? "" : "s"} · ${cap(viewOf(c))} view` : "Upload one to start";
  $("#changeChar").disabled = !state.chars.length;
  renderViews(); updateGenBtn();
}

$("#changeChar").onclick = (e) => {
  e.stopPropagation();
  const pop = $("#charPop");
  if (!pop.hidden) return (pop.hidden = true);
  pop.innerHTML = "";
  for (const c of state.chars) pop.appendChild(charItem(c, c.id === state.charId, () => { pop.hidden = true; selectChar(c.id); setView("animate"); },
    `${cap(viewOf(c))} view · ${doneCount(c.id)} animations`));
  pop.hidden = false;
};

function pendingView(c, v) {
  return [...state.jobs.values()].find((j) => j.kind === "image" && j.attach && j.attach.group === groupOf(c) && j.attach.view === v && isActive(j));
}
function renderViews() {
  const box = $("#viewTiles"), c = cur(); box.innerHTML = "";
  if (!c) return;
  const members = state.chars.filter((x) => groupOf(x) === groupOf(c));
  for (const v of VIEWS) {
    const m = v === viewOf(c) ? c : members.find((x) => viewOf(x) === v), pend = !m && pendingView(c, v);
    const el = document.createElement("button"); el.type = "button";
    el.className = "view-tile" + (m && m.id === c.id ? " on" : "") + (!m && !pend ? " missing" : "") + (pend ? " pending" : "");
    const pct = pend ? Math.round((pend.progress || 0) * 100) : 0;
    el.innerHTML = `<img src="${charImgUrl(m || c)}" alt=""><span>${pend ? (pend.status === "queued" ? "Queued" : `${pct}%`) : cap(v)}</span>${pend ? `<i class="vp" style="width:${pct}%"></i>` : ""}`;
    el.title = m ? `${cap(v)} view` : pend ? `Making a ${v} view with FLUX Kontext…` : `Make a ${v} view of this character with FLUX Kontext (~5 min)`;
    el.onclick = async () => {
      if (m) return m.id !== c.id && selectChar(m.id);
      if (pend) return toast(`The ${v} view is being made (${pend.status === "queued" ? "queued" : pct + "%"}). It appears here when ready.`);
      if (!confirm(`Make a ${v} view of ${nice(c.name)} with FLUX Kontext?\n\nIt takes about 5 minutes. When it's done it shows up here as its own view you can animate.`)) return;
      try { const j = await api(`/api/characters/${c.id}/views`, { method: "POST", body: { view: v } }); state.jobs.set(j.id, j); renderViews(); renderNow(); toast(`Making the ${v} view…`); }
      catch (e) { toast(e.message, true); }
    };
    box.appendChild(el);
  }
}

function setFmt(f) { state.fmt = f; store.set("sf.fmt", f); $$("#fmtSeg button").forEach((b) => b.classList.toggle("on", b.dataset.fmt === f)); updateGenBtn(); }
function setBg(bg) {
  state.bg = bg; store.set("sf.bg", bg); $("#bgSel").value = bg;
  const sw = $("#bgSwatch");
  sw.style.background = bg === "dark" ? "#181820" : bg === "white" ? "#fff" : bg === "green" ? "#00ff00" : "";
  updateGenBtn();
}
$$("#fmtSeg button").forEach((b) => (b.onclick = () => setFmt(b.dataset.fmt)));
$("#bgSel").onchange = (e) => setBg(e.target.value);
const FMT_LABEL = { png: "PNG sequence", gif: "GIF", sheet: "sprite sheet", unity: "Unity pack" };

function updateGenBtn() {
  const n = state.selected.size, btn = $("#generate"), avg = avgJobSeconds();
  btn.disabled = !n || !state.charId;
  btn.querySelector("span").textContent = n ? `Generate ${n} animation${n > 1 ? "s" : ""}` : "Generate";
  $("#genHint").textContent = !state.charId ? "Upload a character first" : n ? (avg ? `About ${dur(avg * n)} on your GPU` : `${n} selected`) : "Select one or more animations to generate";
  $("#selCount").textContent = n ? `${n} selected` : "";
  const fin = state.charId ? finishedByAction(state.charId) : {};
  const selDone = [...state.selected].filter((a) => fin[a]);
  const total = Object.keys(fin).length, k = selDone.length || total;
  const dl = $("#downloadAll");
  dl.disabled = !k;
  dl.querySelector("span").textContent = selDone.length ? `Download selected (${k})` : `Download all (${total})`;
  $("#dlHint").textContent = k ? `One zip · ${FMT_LABEL[state.fmt]} · ${state.bg === "transparent" ? "transparent" : state.bg + " background"}` : "Finished animations can be downloaded here in one click";
}

$("#generate").onclick = async () => {
  const c = cur(); if (!c || !state.selected.size) return;
  const latest = latestByAction(c.id), names = [...state.selected];
  const again = names.filter((a) => latest[a] && latest[a].status === "done");
  const busy = names.filter((a) => latest[a] && isActive(latest[a]));
  const run = names.filter((a) => !busy.includes(a));
  if (!run.length) return toast("Those animations are already being made.");
  if (again.length && !confirm(`${again.length} of these ${again.length === 1 ? "is" : "are"} already made (${again.map(nice).join(", ")}).\n\nMake ${again.length === 1 ? "it" : "them"} again? The current version stays until the new one is ready.`)) return;
  try {
    const created = await api("/api/jobs", { method: "POST", body: { characterId: c.id, actions: run, extraPrompt: state.extraPrompt, seed: state.seed } });
    created.forEach((j) => state.jobs.set(j.id, j));
    state.batch = { charId: c.id, ids: new Set(created.map((j) => j.id)) };
    state.selected.clear(); renderAll(); renderNow();
    toast(`Queued ${created.length} animation${created.length > 1 ? "s" : ""}. Download all appears when they're done.`);
  } catch (e) { toast(e.message, true); }
};

function downloadAll(actions) {
  const c = cur(); if (!c) return;
  const q = new URLSearchParams({ format: state.fmt, bg: state.bg });
  if (actions && actions.length) q.set("actions", actions.join(","));
  const a = document.createElement("a"); a.href = `/api/characters/${c.id}/export/all?${q}`; a.click();
  toast("Preparing your zip… the download starts in a moment.");
}
$("#downloadAll").onclick = () => {
  const fin = finishedByAction(state.charId), sel = [...state.selected].filter((a) => fin[a]);
  downloadAll(sel.length ? sel : null);
};

// ------------------------------------------------------------------ prompt options dialog
$("#genOpts").onclick = () => {
  const c = cur();
  $("#extraPrompt").value = state.extraPrompt; $("#seedInput").value = state.seed;
  $("#charDesc").value = c ? c.description || "" : ""; $("#charName").value = c ? nice(c.name) : "";
  $("#charViewSel").value = c ? viewOf(c) : "side";
  $$("#optsDlg .char-only").forEach((el) => (el.hidden = !c));
  $("#optsDlg").showModal();
};
$("#saveOpts").onclick = async () => {
  state.extraPrompt = $("#extraPrompt").value.trim(); state.seed = $("#seedInput").value;
  const c = cur();
  if (c) {
    try {
      const r = await api(`/api/characters/${c.id}`, { method: "PATCH", body: { name: $("#charName").value, description: $("#charDesc").value, view: $("#charViewSel").value } });
      Object.assign(c, r); renderAll();
    } catch (e) { return toast(e.message, true); }
  }
  $("#optsDlg").close(); toast("Saved. New generations use these options.");
};
$("#flipChar").onclick = async () => {
  const c = cur(); if (!c) return;
  try { const r = await api(`/api/characters/${c.id}`, { method: "PATCH", body: { flip: !c.flip } }); Object.assign(c, r); renderAll(); toast("Flipped. New animations use this facing."); }
  catch (e) { toast(e.message, true); }
};
$("#deleteChar").onclick = async () => {
  const c = cur(); if (!c) return;
  if (!confirm(`Delete ${nice(c.name)} and all its animations?`)) return;
  $("#optsDlg").close();
  await api(`/api/characters/${c.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
};

// ------------------------------------------------------------------ animation grid
$("#actSearch").oninput = (e) => { state.filter = e.target.value.trim().toLowerCase(); renderGrid(); };
$("#setSel").onchange = (e) => { state.set = e.target.value; store.set("sf.set", state.set); state.category = "all"; renderGrid(); };
$("#catSel").onchange = (e) => { state.category = e.target.value; renderGrid(); };
function setLayout(l) {
  state.layout = l; store.set("sf.layout", l);
  $$("#layoutSeg button").forEach((b) => b.classList.toggle("on", b.dataset.layout === l));
  $("#actionGrid").classList.toggle("list", l === "list");
}
$$("#layoutSeg button").forEach((b) => (b.onclick = () => setLayout(b.dataset.layout)));
const shownActions = () => state.actions.filter((a) => a.set === state.set && (state.category === "all" || a.category === state.category)
  && (!state.filter || nice(a.name).toLowerCase().includes(state.filter) || (a.tag || "").toLowerCase().includes(state.filter)));
$("#selAll").onclick = () => { shownActions().forEach((a) => state.selected.add(a.name)); renderGrid(); };
$("#selMissing").onclick = () => {
  const latest = latestByAction(state.charId);
  shownActions().filter((a) => !(latest[a.name] && (latest[a.name].status === "done" || isActive(latest[a.name])))).forEach((a) => state.selected.add(a.name));
  renderGrid();
};
$("#selNone").onclick = () => { state.selected.clear(); renderGrid(); };

const players = new Map(); // canvas -> {imgs, fps, i, t}
const frameCache = new Map(); // jobId -> {version, imgs}
function framesOf(j) {
  const c = frameCache.get(j.id);
  if (c && c.version === j.version) return c.imgs;
  const imgs = Array.from({ length: j.frameCount }, (_, i) => { const im = new Image(); im.src = `/api/jobs/${j.id}/frame/${i}?v=${j.version}`; return im; });
  frameCache.set(j.id, { version: j.version, imgs });
  return imgs;
}
/** Still shown on a card: the middle frame, where the action is (frame 0 is usually the plain stance). */
const posterOf = (j) => { const imgs = framesOf(j); return imgs[Math.floor(imgs.length / 2)]; };
function drawFrame(canvas, im) {
  if (!im || !im.complete || !im.naturalWidth) { if (im) im.onload = () => drawFrame(canvas, im); return; }
  const ctx = canvas.getContext("2d"); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(im, 0, 0);
}

function renderGrid() {
  if (!state.charId) return;
  const cats = [...new Set(state.actions.filter((a) => a.set === state.set).map((a) => a.category))];
  const sel = $("#catSel");
  sel.innerHTML = `<option value="all">All Categories</option>` + cats.map((c) => `<option ${c === state.category ? "selected" : ""}>${c}</option>`).join("");
  const latest = latestByAction(state.charId), list = shownActions();
  const grid = $("#actionGrid"); grid.innerHTML = ""; players.clear();
  for (const a of list) grid.appendChild(animCard(a, latest[a.name]));
  if (!list.length) grid.innerHTML = `<div class="empty-note">No animation matches “${esc(state.filter)}”.</div>`;
  $("#animCount").textContent = list.length;
  const fin = finishedByAction(state.charId), made = list.filter((a) => fin[a.name]).length;
  $("#animHint").textContent = `${made} of ${list.length} made. Hover a card to preview; tick cards to generate or download them.`;
  updateGenBtn();
}

function animCard(a, j) {
  const el = document.createElement("div");
  el.className = "anim-card"; el.dataset.action = a.name;
  el.innerHTML = `<div class="anim-view checker"><canvas width="256" height="320"></canvas></div>
    <button class="tick" type="button" aria-label="Select">${svgUse("i-check")}</button>
    <div class="anim-info"><div class="anim-name"><b></b><small></small></div><div class="tags"></div><div class="anim-btns"></div></div>`;
  el.querySelector(".anim-name b").textContent = nice(a.name);
  el.querySelector(".tick").onclick = (e) => { e.stopPropagation(); toggleSel(a.name, el); };
  const view = el.querySelector(".anim-view");
  view.onmouseenter = () => { const jj = latestDone(a.name); if (jj) players.set(view.querySelector("canvas"), { imgs: framesOf(jj), fps: jj.fps, i: 0, t: 0 }); };
  view.onmouseleave = () => { const cv = view.querySelector("canvas"); players.delete(cv); const jj = latestDone(a.name); if (jj) drawFrame(cv, posterOf(jj)); };
  view.onclick = () => (latestDone(a.name) ? openPreview(a.name) : toggleSel(a.name, el));
  fillCard(el, a, j);
  return el;
}
const latestDone = (action) => finishedByAction(state.charId)[action];
function toggleSel(name, el) {
  state.selected.has(name) ? state.selected.delete(name) : state.selected.add(name);
  el.classList.toggle("sel", state.selected.has(name)); updateGenBtn();
}

function fillCard(el, a, j) {
  const shown = latestDone(a.name); // keep showing the finished version while a redo runs
  el.classList.toggle("sel", state.selected.has(a.name));
  el.querySelector(".anim-name small").textContent = shown ? `${shown.frameCount}f • ${shown.fps}fps` : `${a.frames}f • ${a.fps}fps`;
  el.querySelector(".tags").innerHTML = `<span class="tag">${esc(a.category)}</span>` + (a.loop ? `<span class="tag loop">Loop</span>` : a.tag ? `<span class="tag">${esc(a.tag)}</span>` : "")
    + (!shown && !(j && isActive(j)) ? `<span class="tag state">${j && j.status === "error" ? "Failed" : "Not made"}</span>` : "");
  const view = el.querySelector(".anim-view"), cv = view.querySelector("canvas");
  $$(".overlay, .ghost-img", view).forEach((x) => x.remove());
  if (shown) drawFrame(cv, posterOf(shown));
  else { cv.getContext("2d").clearRect(0, 0, 256, 320); const g = document.createElement("img"); g.className = "ghost-img"; g.src = charImgUrl(cur()); view.prepend(g); }
  if (j && (isActive(j) || j.status === "error")) {
    const o = document.createElement("div"), pct = Math.round((j.progress || 0) * 100);
    o.className = "overlay" + (j.status === "error" ? " err" : "");
    o.innerHTML = j.status === "error" ? `<span class="tagline" title="${esc(j.error || "")}">Failed · ${esc((j.error || "").slice(0, 60))}</span>`
      : `<div class="ring-wrap"><div class="ring" style="--p:${pct}">${j.status === "queued" ? "…" : pct + "%"}</div><small class="tagline">${esc(j.status === "queued" ? "Queued" : j.stage || "")}</small></div>`;
    view.appendChild(o);
  }
  const b = el.querySelector(".anim-btns"); b.innerHTML = "";
  const main = document.createElement("button"); main.className = "btn ghost";
  if (shown) { main.innerHTML = `${svgUse("i-play")}Preview`; main.onclick = () => openPreview(a.name); }
  else if (j && isActive(j)) { main.textContent = j.status === "queued" ? "Queued" : "Generating…"; main.disabled = true; }
  else { main.innerHTML = `${svgUse("i-spark")}${j && j.status === "error" ? "Retry" : "Generate"}`; main.onclick = () => generateOne(a.name, j); }
  const more = document.createElement("button"); more.className = "btn ghost more"; more.innerHTML = svgUse("i-dots"); more.title = "More"; more.setAttribute("aria-label", "More");
  more.onclick = (e) => { e.stopPropagation(); openMenu(more, cardMenu(a, j, shown)); };
  b.append(main, more);
}

async function generateOne(name, j) {
  try {
    if (j && j.status === "error") await api(`/api/jobs/${j.id}/retry`, { method: "POST", body: {} });
    else { const created = await api("/api/jobs", { method: "POST", body: { characterId: state.charId, actions: [name], extraPrompt: state.extraPrompt, seed: state.seed } }); created.forEach((x) => state.jobs.set(x.id, x)); }
    renderGrid(); renderNow(); toast(`${nice(name)} queued.`);
  } catch (e) { toast(e.message, true); }
}

function cardMenu(a, j, shown) {
  const items = [];
  const dl = (fmt) => () => { const x = document.createElement("a"); x.href = `/api/jobs/${shown.id}/export/${fmt}?bg=${state.bg}`; x.click(); };
  if (shown) {
    items.push(["Preview", () => openPreview(a.name)], ["Tune key & frames", () => openTuner(shown.id)]);
    if (!(j && isActive(j))) items.push(["Make again (new take)", () => redo(shown)]);
    items.push("-", ["Download GIF", dl("gif")], ["Download sprite sheet", dl("sheet")], ["Download PNG frames (zip)", dl("png")], ["Download everything (zip)", dl("zip")]);
  } else if (!(j && isActive(j))) items.push([j && j.status === "error" ? "Retry" : "Generate", () => generateOne(a.name, j)]);
  if (j && j.status === "error") items.push(["Show error", () => alert(j.error)]);
  items.push(state.selected.has(a.name) ? ["Deselect", () => { state.selected.delete(a.name); renderGrid(); }] : ["Select", () => { state.selected.add(a.name); renderGrid(); }]);
  const del = j && !isActive(j) ? j : shown;
  if (del && !isActive(del)) items.push("-", ["Delete this animation", async () => { if (confirm(`Delete ${nice(a.name)}?`)) await api(`/api/jobs/${del.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true)); }, "danger"]);
  return items;
}
async function redo(j) {
  const a = state.actions.find((x) => x.name === j.action);
  const msg = a && a.reverseOf ? `Rebuild ${nice(j.action)} from the latest ${nice(a.reverseOf)}?` : `Make ${nice(j.action)} again with a new take (about ${dur(avgJobSeconds() || 400)})?`;
  if (!confirm(msg)) return;
  try { await api("/api/jobs", { method: "POST", body: { characterId: j.characterId, actions: [j.action], extraPrompt: state.extraPrompt } }).then((c) => c.forEach((x) => state.jobs.set(x.id, x))); renderGrid(); renderNow(); }
  catch (e) { toast(e.message, true); }
}

function openMenu(anchor, items) {
  closeMenu();
  const m = document.createElement("div"); m.className = "menu"; m.id = "menu";
  for (const it of items) {
    if (it === "-") { m.appendChild(document.createElement("hr")); continue; }
    const b = document.createElement("button"); b.textContent = it[0]; if (it[2]) b.className = it[2];
    b.onclick = () => { closeMenu(); it[1](); }; m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8))}px`;
  m.style.top = `${r.bottom + mh + 8 > innerHeight ? r.top - mh - 6 : r.bottom + 6}px`;
}
function closeMenu() { const m = $("#menu"); if (m) m.remove(); }
document.addEventListener("click", (e) => {
  if (!e.target.closest("#menu")) closeMenu();
  if (!e.target.closest("#charPop, #changeChar")) $("#charPop").hidden = true;
  if (!e.target.closest("#notePop, #bellBtn")) $("#notePop").hidden = true;
});
window.addEventListener("scroll", closeMenu, true);

function animate(ts) {
  for (const [cv, p] of players) {
    if (ts - p.t < 1000 / p.fps) continue;
    p.t = ts; p.i = (p.i + 1) % p.imgs.length;
    drawFrame(cv, p.imgs[p.i]);
  }
  requestAnimationFrame(animate);
}

// ------------------------------------------------------------------ preview dialog
const pv = { action: null, playing: true, i: 0 };
function openPreview(action) {
  const j = latestDone(action); if (!j) return;
  pv.action = action; pv.playing = true; pv.i = 0;
  const a = state.actions.find((x) => x.name === action) || {};
  $("#pvTitle").textContent = nice(action);
  $("#pvSub").textContent = `${j.frameCount} frames · ${a.loop ? "loop" : "plays once"} · from ${j.rawCount}-frame video · seed ${j.seed}`;
  $("#pvNote").textContent = j.derivedFrom ? `Made from ${nice(j.derivedFrom.action)}, played in reverse, so the two always match.`
    : j.range ? `Frames ${j.range.start ?? "auto"}–${j.range.end ?? "auto"} of the video (set in Tune).` : "Frames picked automatically from the best part of the video.";
  $("#pvFps").value = j.fps; $("#pvFpsOut").value = `${j.fps} fps`;
  const imgs = framesOf(j), strip = $("#pvFrames"); strip.innerHTML = "";
  imgs.forEach((im, i) => { const t = document.createElement("img"); t.src = im.src; t.onclick = () => { pv.playing = false; pv.i = i; syncPv(); }; strip.appendChild(t); });
  const canvas = $("#pvCanvas");
  players.set(canvas, { imgs, fps: j.fps, i: 0, t: 0, preview: true });
  const dl = $("#pvDl"); dl.innerHTML = "";
  for (const [label, fmt] of [["GIF", "gif"], ["Sheet", "sheet"], ["PNG frames", "png"], ["All (zip)", "zip"]]) {
    const b = document.createElement("button"); b.className = "btn ghost sm"; b.innerHTML = `${svgUse("i-download")}${label}`;
    b.onclick = () => { const x = document.createElement("a"); x.href = `/api/jobs/${j.id}/export/${fmt}?bg=${state.bg}`; x.click(); }; dl.appendChild(b);
  }
  const act = $("#pvAct"); act.innerHTML = "";
  const add = (label, fn, cls = "ghost") => { const b = document.createElement("button"); b.className = `btn ${cls} sm`; b.textContent = label; b.onclick = fn; act.appendChild(b); };
  add("Tune key & frames", () => { $("#preview").close(); openTuner(j.id); }, "soft");
  add(a.reverseOf ? "Rebuild" : "Make again", () => { $("#preview").close(); redo(j); });
  $("#pvPlay").innerHTML = svgUse("i-pause");
  $("#preview").showModal();
}
function syncPv() {
  const canvas = $("#pvCanvas"), p = players.get(canvas);
  $("#pvPlay").innerHTML = svgUse(pv.playing ? "i-pause" : "i-play");
  if (!p) return;
  if (!pv.playing) { p.fps = 0.0001; p.i = pv.i; drawFrame(canvas, p.imgs[pv.i]); } else p.fps = +$("#pvFps").value;
  $$("#pvFrames img").forEach((im, i) => im.classList.toggle("on", !pv.playing && i === pv.i));
}
$("#pvPlay").onclick = () => { pv.playing = !pv.playing; const p = players.get($("#pvCanvas")); if (p) pv.i = p.i; syncPv(); };
$("#pvFps").oninput = (e) => { $("#pvFpsOut").value = `${e.target.value} fps`; pv.playing = true; syncPv(); };
$("#preview").addEventListener("close", () => players.delete($("#pvCanvas")));

// ------------------------------------------------------------------ job events
function onJobChange(j, old) {
  renderNow();
  const finished = old && old.status !== j.status && (j.status === "done" || j.status === "error");
  if (j.part) return Scene.onJob(j, finished); // Scene Kit: completed sprite, variation or clean background
  if (j.kind === "clip") {
    const el = $("#img-" + j.id);
    if (el) fillClipCard(el, j); else renderImages();
    if (finished) {
      addNote(j.status === "done" ? `Video clip ready: ${nice(j.name)}` : `Video clip failed: ${j.error}`, j.status === "error", { studio: true });
      if (j.status === "error") toast(`Video clip: ${j.error}`, true);
      else toast(`Video clip ready: ${nice(j.name)}${j.speechCut ? " (the spoken line was longer than the clip and got cut)" : ""}.`, false, { label: "Show", run: () => setView("studio") });
    }
    return;
  }
  if (j.kind === "image") {
    const el = $("#img-" + j.id);
    if (el) fillImgCard(el, j); else renderImages();
    if (j.status === "done" && state.studio.source === "image") renderSource();
    if (j.attach) renderViews();
    if (finished) {
      addNote(j.status === "done" ? (j.attach ? `${cap(j.attach.view)} view is ready` : `Image ready: ${nice(j.name)}`) : `Image failed: ${j.error}`, j.status === "error", j.attach && j.attach.characterId ? { charId: j.attach.characterId } : { studio: true });
      if (j.status === "error") toast(`Image: ${j.error}`, true);
      else if (j.attach && j.attach.characterId) toast(`${cap(j.attach.view)} view is ready.`, false, { label: "Open it", run: () => selectChar(j.attach.characterId) });
    }
    return;
  }
  renderChars();
  if (finished) {
    const c = state.chars.find((x) => x.id === j.characterId);
    addNote(j.status === "done" ? `${nice(j.action)} is ready` : `${nice(j.action)} failed`, j.status === "error", { charId: j.characterId, action: j.action }, c ? nice(c.name) : "");
    if (j.status === "error") toast(`${nice(j.action)}: ${j.error}`, true);
    checkBatch();
  }
  if (j.characterId !== state.charId) return;
  const el = $(`#actionGrid .anim-card[data-action="${CSS.escape(j.action)}"]`);
  const a = state.actions.find((x) => x.name === j.action);
  if (el && a) fillCard(el, a, latestByAction(state.charId)[j.action]);
  renderGenCard();
  if (j.status === "done" && tuner.jobId === j.id) tuner.refreshOut();
}

/** When every animation from the last Generate click has finished, offer them as one download. */
function checkBatch() {
  const b = state.batch; if (!b) return;
  const list = [...b.ids].map((id) => state.jobs.get(id)).filter(Boolean);
  if (list.some(isActive)) return;
  state.batch = null;
  const ok = list.filter((j) => j.status === "done");
  if (!ok.length) return;
  const names = ok.map((j) => j.action), failed = list.length - ok.length;
  addNote(`All ${ok.length} animation${ok.length > 1 ? "s are" : " is"} ready${failed ? ` (${failed} failed)` : ""}`, false, { charId: b.charId, download: names });
  toast(`All ${ok.length} animation${ok.length > 1 ? "s are" : " is"} ready${failed ? `, ${failed} failed` : ""}.`, false,
    { label: `Download ${ok.length > 1 ? "all " + ok.length : ""}`.trim(), run: () => { if (state.charId !== b.charId) selectChar(b.charId); downloadAll(names); } });
}

// ------------------------------------------------------------------ notifications
let notes = (() => { try { return JSON.parse(store.get("sf.notes") || "[]"); } catch { return []; } })();
function addNote(text, err, target, sub = "") {
  notes.unshift({ text, err: !!err, target, sub, at: Date.now(), unread: true });
  notes = notes.slice(0, 30); store.set("sf.notes", JSON.stringify(notes)); renderNotes();
}
function renderNotes() {
  $("#bellBtn .dot").hidden = !notes.some((n) => n.unread);
  const list = $("#noteList"); list.innerHTML = notes.length ? "" : `<div class="empty-pop">Nothing yet. Finished animations show up here.</div>`;
  for (const n of notes) {
    const el = document.createElement("div"); el.className = "note" + (n.err ? " err" : "");
    const ago = (Date.now() - n.at) / 1000;
    el.innerHTML = `<i></i><div><b></b><small>${esc(n.sub ? n.sub + " · " : "")}${ago < 60 ? "just now" : dur(ago) + " ago"}</small></div>`;
    el.querySelector("b").textContent = n.text;
    el.onclick = () => {
      $("#notePop").hidden = true;
      const t = n.target || {};
      if (t.studio) return setView("studio");
      if (t.scene) { setView("scene"); return Scene.select(t.scene, t.part); }
      if (t.charId && state.chars.some((c) => c.id === t.charId)) { selectChar(t.charId); setView("animate"); }
      if (t.download) downloadAll(t.download); else if (t.action && latestDone(t.action)) openPreview(t.action);
    };
    list.appendChild(el);
  }
}
$("#bellBtn").onclick = (e) => {
  e.stopPropagation();
  const pop = $("#notePop"); pop.hidden = !pop.hidden;
  if (!pop.hidden) { renderNotes(); notes.forEach((n) => (n.unread = false)); store.set("sf.notes", JSON.stringify(notes)); $("#bellBtn .dot").hidden = true; }
};
$("#clearNotes").onclick = () => { notes = []; store.set("sf.notes", "[]"); renderNotes(); };

// ------------------------------------------------------------------ image studio (FLUX Kontext)
const CLIP_TEXT = {
  hint: "Animate a picture with Wan 2.2 (or describe a scene and FLUX draws the first frame), then MMAudio adds sound made from the video and Qwen3-TTS speaks a line.",
  none: "Describe the scene: FLUX draws the first frame from your prompt, then Wan 2.2 animates it.",
};
function renderStudio() {
  const clip = state.studio.mode === "clip";
  $$("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.studio.mode));
  if (!clip && state.studio.source === "multi") state.studio.source = "upload"; // several images are for clips only
  $$(".clip-only").forEach((el) => (el.hidden = !clip)); $$(".image-only").forEach((el) => (el.hidden = clip));
  $("#srcSeg").classList.toggle("five", clip);
  $("#studioTag").textContent = clip ? "Wan 2.2 + MMAudio + Qwen3-TTS" : "FLUX Kontext";
  $("#studioHint").textContent = clip ? CLIP_TEXT.hint : "Edit a character (turn it to a side view, change the pose…) or create a new one from text.";
  $("#promptLabel").textContent = clip ? "What happens (the motion)" : "Prompt";
  $("#imgPrompt").placeholder = clip ? "e.g. the camera slowly pushes in as waves crash against the rocks, mist drifts" : "Describe the change, e.g. turn this character to a side view facing right";
  $("#imgGenerate span").textContent = clip ? "Generate video clip" : "Generate image";
  $("#genTime").textContent = clip ? clipEstimate() : "About 3–5 minutes per image on your GPU.";
  $$("#srcSeg button").forEach((b) => b.classList.toggle("on", b.dataset.src === state.studio.source));
  const chips = $("#presetChips"); chips.innerHTML = "";
  for (const p of state.presets) {
    const b = document.createElement("button"); b.type = "button";
    b.className = "chip" + (state.studio.preset === p.id ? " on" : ""); b.textContent = p.label; b.title = p.prompt;
    b.onclick = () => { state.studio.preset = p.id; $("#imgPrompt").value = p.prompt; renderStudio(); };
    chips.appendChild(b);
  }
  $$(".t2i-only").forEach((el) => (el.hidden = clip || state.studio.source !== "none"));
  renderSource(); renderImages();
}
$$("#modeSeg button").forEach((b) => (b.onclick = () => { state.studio.mode = b.dataset.mode; store.set("sf.studioMode", b.dataset.mode); renderStudio(); }));
/** Rough time on the RTX 4050: ~6 min for a short clip; over 5 s it is made in 5 s parts of ~10 min each. */
function clipEstimate() {
  const sec = +$("#clipSeconds").value, parts = Math.ceil((sec * 16) / 80);
  return sec <= 5 ? `About ${sec <= 3 ? "6–9" : "8–12"} minutes on your GPU. Try short clips first.`
    : `Made in ${parts} parts of up to 5 s, each continuing from the last frame: about ${parts * 8}–${parts * 12} minutes on your GPU.`;
}
$("#clipSeconds").onchange = () => ($("#genTime").textContent = clipEstimate());
$$("#srcSeg button").forEach((b) => (b.onclick = () => { state.studio.source = b.dataset.src; renderStudio(); }));
$("#imgPrompt").oninput = () => { if (state.studio.preset) { state.studio.preset = null; $$("#presetChips .chip").forEach((c) => c.classList.remove("on")); } };

function thumbRow(items, selectedId, onPick) {
  const row = document.createElement("div"); row.className = "thumb-row";
  for (const it of items) {
    const b = document.createElement("button"); b.type = "button"; b.className = "thumb" + (it.id === selectedId ? " on" : ""); b.title = it.title;
    b.innerHTML = `<img src="${it.src}" alt="">`; b.onclick = () => onPick(it.id); row.appendChild(b);
  }
  return row;
}

function renderSource() {
  const box = $("#srcPanel"), s = state.studio; box.innerHTML = "";
  if (s.source === "character") {
    if (!state.chars.length) { box.innerHTML = `<p class="hint">Upload a character first (left sidebar), or switch to Upload.</p>`; return; }
    if (!state.chars.some((c) => c.id === s.characterId)) s.characterId = state.charId || state.chars[0].id;
    box.appendChild(thumbRow(state.chars.map((c) => ({ id: c.id, src: charImgUrl(c), title: nice(c.name) })), s.characterId, (id) => { s.characterId = id; renderSource(); }));
  } else if (s.source === "image") {
    const done = [...state.jobs.values()].filter((j) => j.kind === "image" && !j.part && j.status === "done").sort((a, b) => b.created - a.created);
    if (!done.length) { box.innerHTML = `<p class="hint">No results yet. Generate an image first, then refine it from here.</p>`; return; }
    if (!done.some((j) => j.id === s.imageJobId)) s.imageJobId = done[0].id;
    box.appendChild(thumbRow(done.map((j) => ({ id: j.id, src: `/api/jobs/${j.id}/output?v=${j.version}`, title: j.prompt })), s.imageJobId, (id) => { s.imageJobId = id; renderSource(); }));
  } else if (s.source === "multi") {
    renderMulti(box);
  } else if (s.source === "upload") {
    const lab = document.createElement("label"); lab.className = "mini-drop";
    lab.innerHTML = `<input type="file" accept="image/*" hidden>${s.fileUrl ? `<img src="${s.fileUrl}" alt="">` : ""}<span>${s.file ? esc(s.file.name) + "<br><small>click to change</small>" : "Click or drop an image to edit"}</span>`;
    lab.querySelector("input").onchange = (e) => setStudioFile(e.target.files[0]);
    box.appendChild(lab);
  } else {
    box.innerHTML = state.studio.mode === "clip" ? `<p class="hint">${CLIP_TEXT.none}</p>`
      : `<p class="hint">Describe a brand-new character. Tip: ask for “full body, side view facing right, plain white background”.</p>`;
  }
}
const MULTI = {
  keyframes: { max: 7, hint: "The clip starts on image 1 and passes through each image in order, ending on the last one (up to 7). Every step gets at least 1.5 s; the Length is shared between them." },
  combine: { max: 3, hint: "FLUX Kontext puts the people, places and things from these images (up to 3) together into the first frame, then Wan animates it. Say in the prompt how they come together." },
};
function renderMulti(box) {
  const s = state.studio, cfg = MULTI[s.multiMode];
  const seg = document.createElement("div"); seg.className = "segmented two";
  for (const [m, label] of [["keyframes", "Keyframes in order"], ["combine", "Combine into one scene"]]) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.className = s.multiMode === m ? "on" : "";
    b.onclick = () => { s.multiMode = m; store.set("sf.multiMode", m); renderSource(); };
    seg.appendChild(b);
  }
  const hint = document.createElement("p"); hint.className = "hint"; hint.textContent = cfg.hint;
  if (s.multi.length > cfg.max) hint.innerHTML += ` <b class="err">Only the first ${cfg.max} will be used; remove ${s.multi.length - cfg.max}.</b>`;
  const list = document.createElement("div"); list.className = "multi-list";
  s.multi.forEach((m, i) => {
    const el = document.createElement("div"); el.className = "multi-item"; el.title = m.file.name;
    el.innerHTML = `<img src="${m.url}" alt=""><b>${i + 1}</b><div class="mi-btns"><button type="button" title="Earlier">←</button><button type="button" title="Remove">✕</button><button type="button" title="Later">→</button></div>`;
    const [left, del, right] = el.querySelectorAll("button");
    left.onclick = () => { if (i) { [s.multi[i - 1], s.multi[i]] = [s.multi[i], s.multi[i - 1]]; renderSource(); } };
    right.onclick = () => { if (i < s.multi.length - 1) { [s.multi[i + 1], s.multi[i]] = [s.multi[i], s.multi[i + 1]]; renderSource(); } };
    del.onclick = () => { URL.revokeObjectURL(m.url); s.multi.splice(i, 1); renderSource(); };
    list.appendChild(el);
  });
  if (s.multi.length < cfg.max) {
    const add = document.createElement("label"); add.className = "multi-add";
    add.innerHTML = `<input type="file" accept="image/*" multiple hidden><span>+ Add<br>images</span>`;
    add.querySelector("input").onchange = (e) => { addMultiFiles(e.target.files); e.target.value = ""; };
    list.appendChild(add);
  }
  box.append(seg, hint, list);
}
function addMultiFiles(files) {
  const s = state.studio, imgs = [...files].filter((f) => /^image\//.test(f.type));
  if (!imgs.length) return toast("Please choose image files.", true);
  for (const f of imgs) s.multi.push({ file: f, url: URL.createObjectURL(f) });
  s.source = "multi"; renderStudio();
}
function setStudioFile(f) {
  if (!f || !/^image\//.test(f.type)) return toast("Please choose an image file.", true);
  if (state.studio.fileUrl) URL.revokeObjectURL(state.studio.fileUrl);
  Object.assign(state.studio, { source: "upload", file: f, fileUrl: URL.createObjectURL(f) });
  renderStudio();
}

async function generateClip() {
  const s = state.studio, fd = new FormData();
  const prompt = $("#imgPrompt").value.trim(); if (!prompt) return toast("Describe what happens in the clip.", true);
  fd.append("prompt", prompt);
  if (s.source === "character") fd.append("characterId", s.characterId || "");
  if (s.source === "image") fd.append("imageJobId", s.imageJobId || "");
  if (s.source === "upload") { if (!s.file) return toast("Choose a picture to animate.", true); fd.append("image", s.file); }
  if (s.source === "multi") {
    if (!s.multi.length) return toast("Add the images to use (Several).", true);
    s.multi.slice(0, MULTI[s.multiMode].max).forEach((m) => fd.append("images", m.file));
    fd.append("imagesMode", s.multiMode);
  }
  fd.append("seconds", $("#clipSeconds").value); fd.append("shape", $("#clipShape").value);
  const sound = $("#clipSound").value.trim(), speech = $("#clipSpeech").value.trim();
  if (sound) fd.append("sound", JSON.stringify({ prompt: sound }));
  if (speech) fd.append("speech", JSON.stringify({ text: speech, speaker: $("#clipSpeaker").value, start: +$("#clipSpeechStart").value || 0 }));
  fd.append("fitSpeech", $("#clipFit").checked); fd.append("tile", $("#clipTile").value); fd.append("seed", $("#imgSeed").value);
  const btn = $("#imgGenerate"); btn.disabled = true;
  try { const j = await api("/api/clips", { method: "POST", body: fd }); state.jobs.set(j.id, j); renderImages(); renderNow(); toast("Video clip queued. It runs after any jobs ahead of it."); }
  catch (e) { toast(e.message, true); }
  btn.disabled = false;
}

$("#imgGenerate").onclick = async () => {
  if (state.studio.mode === "clip") return generateClip();
  const s = state.studio, fd = new FormData();
  const prompt = $("#imgPrompt").value.trim(); if (!prompt) return toast("Write what you want, or pick a quick edit.", true);
  fd.append("prompt", prompt); fd.append("source", s.source);
  if (s.source === "character") fd.append("characterId", s.characterId || "");
  if (s.source === "image") fd.append("imageJobId", s.imageJobId || "");
  if (s.source === "upload") { if (!s.file) return toast("Choose an image to edit.", true); fd.append("image", s.file); }
  const [w, h] = $("#imgSize").value.split("x");
  fd.append("width", w); fd.append("height", h);
  fd.append("steps", $("#imgSteps").value); fd.append("guidance", $("#imgGuidance").value); fd.append("seed", $("#imgSeed").value);
  const btn = $("#imgGenerate"); btn.disabled = true;
  try { const j = await api("/api/images", { method: "POST", body: fd }); state.jobs.set(j.id, j); renderImages(); renderNow(); toast("Image queued. It runs after any animations ahead of it."); }
  catch (e) { toast(e.message, true); }
  btn.disabled = false;
};

function renderImages() {
  if (state.view !== "studio") return;
  const grid = $("#imgGrid"); grid.innerHTML = "";
  const list = [...state.jobs.values()].filter((j) => (j.kind === "image" && !j.part) || j.kind === "clip").sort((a, b) => b.created - a.created);
  if (!list.length) grid.innerHTML = `<div class="empty-note">Your generated images and clips appear here. Try <b>Side view (walk-ready)</b> on a character.</div>`;
  for (const j of list) {
    const el = document.createElement("div"); el.className = "img-card" + (j.kind === "clip" ? " clip" : ""); el.id = "img-" + j.id;
    el.innerHTML = `<div class="img-view"></div><div class="info"><div class="name"></div><p class="prompt"></p><div class="meta"></div><div class="btns"></div></div>`;
    (j.kind === "clip" ? fillClipCard : fillImgCard)(el, j); grid.appendChild(el);
  }
}

function fillClipCard(el, j) {
  const view = el.querySelector(".img-view"), pct = Math.round((j.progress || 0) * 100);
  if (j.status === "done") {
    if (view.dataset.v !== String(j.version)) { view.className = "img-view"; view.dataset.v = j.version; view.innerHTML = `<video src="/api/clips/${j.id}/video?v=${j.version}" controls loop playsinline preload="metadata"></video>`; }
  } else {
    view.className = "img-view pending"; view.dataset.v = "";
    view.innerHTML = j.status === "error" ? `<div class="img-progress"><b class="err">Failed</b></div>`
      : `<div class="img-progress"><div class="ring" style="--p:${pct}">${j.status === "queued" ? "…" : pct + "%"}</div><span>${esc(j.status === "queued" ? "Queued" : j.stage || "")}</span></div>`;
  }
  el.querySelector(".name").textContent = `🎬 ${nice(j.name)}`;
  el.querySelector(".prompt").textContent = j.status === "error" ? j.error : j.prompt + (j.speech ? ` · “${j.speech.text}”` : "");
  el.querySelector(".prompt").className = j.status === "error" ? "prompt err" : "prompt";
  const audio = [j.sound && "sound", j.speech && `voice ${j.speech.speaker}`].filter(Boolean).join(" + ") || "no audio";
  const refs = j.refs ? ` · ${j.refs} ${j.refsMode === "combine" ? "images combined" : "keyframes"}` : "";
  el.querySelector(".meta").textContent = `${j.width}×${j.height} · ${(j.frames / 16).toFixed(1)} s${refs} · ${audio}${j.speechCut ? " · line cut" : ""}`;
  const b = el.querySelector(".btns"); b.innerHTML = "";
  const add = (label, fn, cls = "ghost") => { const x = document.createElement("button"); x.className = "btn " + cls; x.textContent = label; x.onclick = fn; b.appendChild(x); };
  const dl = (q, file) => () => { const a = document.createElement("a"); a.href = `/api/clips/${j.id}/video${q}`; a.download = file; a.click(); };
  if (j.status === "done") { add("⤓ MP4", dl("", `${j.name}.mp4`), "primary"); if (j.sound || j.speech) add("Silent", dl("?silent=1", `${j.name}_silent.mp4`)); }
  if (j.status !== "running") add(j.status === "done" ? "Redo" : "Retry", async () => { try { await api(`/api/jobs/${j.id}/retry`, { method: "POST", body: {} }); } catch (e) { toast(e.message, true); } });
  if (j.status !== "running") add("✕", async () => { if (confirm("Delete this clip?")) await api(`/api/jobs/${j.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true)); }, "ghost danger");
}

function fillImgCard(el, j) {
  const view = el.querySelector(".img-view"), pct = Math.round((j.progress || 0) * 100);
  if (j.status === "done") {
    const src = `/api/jobs/${j.id}/output?v=${j.version}`;
    if (!view.querySelector("img") || view.dataset.v !== String(j.version)) { view.className = "img-view"; view.dataset.v = j.version; view.innerHTML = `<img src="${src}" alt="">`; }
  } else {
    view.className = "img-view pending"; view.dataset.v = "";
    view.innerHTML = j.status === "error" ? `<div class="img-progress"><b class="err">Failed</b></div>`
      : `<div class="img-progress"><div class="ring" style="--p:${pct}">${j.status === "queued" ? "…" : pct + "%"}</div><span>${esc(j.status === "queued" ? "Queued" : j.stage || "")}</span></div>`;
  }
  el.querySelector(".name").textContent = nice(j.name) + (j.attach ? ` · ${j.attach.view} view` : "");
  el.querySelector(".prompt").textContent = j.status === "error" ? j.error : j.prompt;
  el.querySelector(".prompt").className = j.status === "error" ? "prompt err" : "prompt";
  el.querySelector(".meta").textContent = j.status === "done" ? `${j.outWidth}×${j.outHeight} · seed ${j.seed}` : `${j.hasInput ? "edit" : "text to image"} · ${j.sampleSteps} steps`;
  const b = el.querySelector(".btns"); b.innerHTML = "";
  const add = (label, fn, cls = "ghost") => { const x = document.createElement("button"); x.className = "btn " + cls; x.textContent = label; x.onclick = fn; b.appendChild(x); };
  if (j.status === "done") {
    add("Use as character", async () => {
      try { const c = await api(`/api/jobs/${j.id}/to-character`, { method: "POST", body: {} }); if (!state.chars.some((x) => x.id === c.id)) state.chars.push(c); selectChar(c.id); setView("animate"); toast(`${nice(c.name)} is ready to animate.`); }
      catch (e) { toast(e.message, true); }
    }, "primary");
    add("Edit this", () => { Object.assign(state.studio, { source: "image", imageJobId: j.id }); renderStudio(); $("#imgPrompt").focus(); });
    add("⤓", () => { const a = document.createElement("a"); a.href = `/api/jobs/${j.id}/output`; a.download = `${j.name}.png`; a.click(); });
  }
  if (j.status !== "running") add(j.status === "done" ? "Redo" : "Retry", async () => { try { await api(`/api/jobs/${j.id}/retry`, { method: "POST", body: {} }); } catch (e) { toast(e.message, true); } });
  if (j.status !== "running") add("✕", async () => { if (confirm("Delete this image?")) await api(`/api/jobs/${j.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true)); }, "ghost danger");
}

// ------------------------------------------------------------------ now generating
const PHASES = [["prepare", "Prep"], ["load", "Load"], ["sample", "Sample"], ["decode", "Decode"], ["frames", "Key"]];

/** Mean wall time of the last few generated (not reversed) animation jobs, for estimates. */
function avgJobSeconds() {
  const done = [...state.jobs.values()].filter((j) => !j.kind && j.status === "done" && j.started && j.finished && !j.derivedFrom).sort((a, b) => b.finished - a.finished).slice(0, 5);
  return done.length ? done.reduce((a, j) => a + (j.finished - j.started) / 1000, 0) / done.length : null;
}

function renderNow() {
  const all = [...state.jobs.values()];
  const run = all.find((j) => j.status === "running");
  const queued = all.filter((j) => j.status === "queued").length;
  $("#nowCard").hidden = !run && !queued;
  if (!run && !queued) return;
  const avg = avgJobSeconds();
  $("#queueInfo").textContent = queued ? `${queued} queued${avg ? ` · ~${dur(avg * queued)}` : ""}` : "";
  const body = $("#nowBody");
  if (!run) { body.innerHTML = `<p class="hint">Starting the next job…</p>`; return; }
  const c = state.chars.find((x) => x.id === run.characterId), isImg = run.kind === "image", isClip = run.kind === "clip";
  const title = isClip ? "Video clip" : isImg ? (run.attach ? `${cap(run.attach.view)} view` : run.part ? Scene.jobTitle(run) : "Image") : nice(run.action);
  if (run.waitingRam) {
    const w = run.waitingRam;
    body.innerHTML = `<div class="now-title"><b>${esc(title)}</b><small>waiting for RAM</small></div>
      <p class="hint">Only <b>${gb(w.room)} GB</b> is free under your ${gb(w.limit)} GB limit. The AI needs at least ${gb(w.min)} GB to start
      (about ${gb(w.need)} GB for full speed). It starts by itself as soon as there is room.</p>
      <button class="btn soft sm" onclick="setApps(true)">Free up RAM →</button>`;
    return;
  }
  const now = Date.now(), curPh = PHASES.findIndex(([k]) => k === run.phase), pct = Math.round((run.progress || 0) * 100);
  let remaining = "estimating…";
  if (run.eta != null) remaining = `~${dur(Math.max(0, run.eta - (now - run.etaAt) / 1000))}`;
  else if (run.secPerStep && run.stepsLeft) remaining = `~${dur(run.stepsLeft * run.secPerStep)} + decode`;
  const s = run.settings;
  // a clip runs several stages; show those instead of one run's phases
  const stages = isClip ? [!run.ownImage && ["image", "Frame"], run.speech && ["speech", "Voice"], ["video", "Video"], run.sound && ["sound", "Sound"], ["mux", "Mix"]].filter(Boolean) : null;
  const curSt = stages ? stages.findIndex(([k]) => k === run.stageName) : -1;
  const steps = stages ? `<ol class="phases" style="grid-template-columns:repeat(${stages.length},1fr)">${stages.map(([k, label], i) => `<li class="${i < curSt ? "done" : i === curSt ? "on" : ""}">${label}</li>`).join("")}</ol>`
    : `<ol class="phases">${PHASES.map(([k, label], i) => `<li class="${i < curPh ? "done" : i === curPh ? "on" : ""}">${k === "frames" && isImg ? "Save" : label}</li>`).join("")}</ol>`;
  const details = isClip ? `<dt>Clip</dt><dd>${run.frames} frames · ${run.width}×${run.height} · ${(run.frames / 16).toFixed(1)} s</dd>${run.parts > 1 ? `<dt>Part</dt><dd>${run.part || 1} of ${run.parts}</dd>` : ""}<dt>Audio</dt><dd>${[run.sound && "MMAudio", run.speech && "Qwen3-TTS"].filter(Boolean).join(" + ") || "none"}</dd>`
    : isImg ? `<dt>Output</dt><dd>${run.hasInput ? "edit of source" : `${run.width}×${run.height}`}</dd>`
    : run.derivedFrom ? `<dt>Source</dt><dd>${esc(nice(run.derivedFrom.action))}, reversed</dd>`
    : `<dt>Video</dt><dd>${run.rawCount || s.videoLength} frames · ${s.videoWidth}×${s.videoHeight}</dd><dt>Sprites</dt><dd>${run.frames} frames · ${run.fps} fps</dd>`;
  body.innerHTML = `
    <div class="now-title"><b>${esc(title)}</b><small>${esc(isImg || isClip ? nice(run.name) : c ? nice(c.name) : "")}</small></div>
    ${steps}
    <div class="now-pct"><span class="pct">${pct}%</span><span class="stage">${esc(run.stage || "")}</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <dl class="now-grid">
      <dt>Elapsed</dt><dd>${clock((now - (run.started || now)) / 1000)}</dd>
      <dt>Remaining</dt><dd>${remaining}</dd>
      ${run.step ? `<dt>Steps</dt><dd>${run.step}/${run.steps}${run.secPerStep ? ` · ${run.secPerStep.toFixed(1)} s/step` : ""}</dd>` : ""}
      ${details}
    </dl>`;
}

// ------------------------------------------------------------------ system meters (left)
const HISTORY = 120; // samples (~2 min at 1/s); each meter plots a 0..1 ratio
const memStatus = (r) => (r >= 0.95 ? ["crit", "nearly full"] : r >= 0.85 ? ["warn", "high"] : null);
const METERS = [
  { k: "gpu", label: "GPU", spark: true, get: (s) => s.gpu && s.gpu.util, ratio: (v) => v / 100, fmt: (v) => `${Math.round(v)}%` },
  { k: "vram", label: "VRAM", title: "ComfyUI keeps models in VRAM, so near-full is normal while generating",
    get: (s) => s.gpu && s.gpu.memUsed, ratio: (v, s) => v / s.gpu.memTotal, fmt: (v, s) => `${gb(v)} / ${gb(s.gpu.memTotal)} GB` },
  { k: "airam", label: "AI RAM", title: "Physical RAM used by ComfyUI (the AI). It can never take more than what is left under your PC limit.",
    get: (s) => s.comfy && s.comfy.workingSet, ratio: (v, s) => v / (s.comfy.cap || s.ramTotal), fmt: (v, s) => `${gb(v)} / ${gb(s.comfy.cap || s.ramTotal)} GB` },
  { k: "ram", label: "PC RAM", title: "RAM in use on the whole PC, against your limit",
    get: (s) => pcRam(s).inUse, ratio: (v, s) => v / pcRam(s).limit, fmt: (v, s) => `${gb(v)} / ${gb(pcRam(s).limit)} GB`, status: memStatus },
  { k: "cpu", label: "CPU", spark: true, get: (s) => s.cpu, ratio: (v) => v / 100, fmt: (v) => `${Math.round(v)}%` },
  { k: "temp", label: "GPU Temp", spark: true, noBar: true, get: (s) => s.gpu && s.gpu.temp, ratio: (v) => v / 100,
    fmt: (v, s) => `${Math.round(v)}°C${s.gpu.power != null ? ` · ${Math.round(s.gpu.power)}W` : ""}`,
    status: (r) => (r >= 0.9 ? ["crit", "hot"] : r >= 0.83 ? ["warn", "warm"] : null) },
];
const meterState = new Map();

function buildMeters() {
  const box = $("#meters"); box.innerHTML = "";
  for (const m of METERS) {
    const el = document.createElement("div");
    el.className = "meter"; if (m.title) el.title = m.title;
    el.innerHTML = `<span class="m-label">${m.label}</span><div class="m-row"><span class="m-val">–</span><span class="m-status"></span>${m.spark ? `<canvas class="spark"></canvas>` : ""}</div>${m.noBar ? "" : `<div class="m-track"><i></i></div>`}`;
    const st = { el, hist: [], hoverSlot: null };
    const cv = el.querySelector("canvas");
    if (cv) {
      cv.onmousemove = (e) => { const r = cv.getBoundingClientRect(); st.hoverSlot = Math.round(((e.clientX - r.left) / r.width) * (HISTORY - 1)); drawMeter(m, st); };
      cv.onmouseleave = () => { st.hoverSlot = null; drawMeter(m, st); };
    }
    meterState.set(m.k, st); box.appendChild(el);
  }
}

/** Whole-PC RAM in use and the limit it must stay under (the guard's limit, or total RAM without it). */
function pcRam(s) {
  const c = s.comfy || {};
  return { inUse: c.systemInUse || s.ramUsed, limit: c.systemLimit || s.ramTotal, total: c.systemTotal || s.ramTotal };
}

function onStats(s) {
  state.stats = s; updateRamPill(s); renderRamBudget();
  $("#gpuName").textContent = s.gpu ? s.gpu.name.replace(/^NVIDIA\s+(GeForce\s+)?/, "") : "";
  for (const m of METERS) {
    const st = meterState.get(m.k), v = m.get(s);
    const has = v != null && Number.isFinite(v);
    st.hist.push(has ? { t: s.t, r: Math.min(Math.max(m.ratio(v, s), 0), 1), text: m.fmt(v, s) } : { t: s.t, r: null, text: "n/a" });
    if (st.hist.length > HISTORY) st.hist.shift();
    drawMeter(m, st);
  }
  const pc = pcRam(s), atLimit = pc.inUse / pc.limit >= 0.97, warn = $("#sysWarn");
  warn.hidden = !(atLimit || s.gpuError);
  warn.textContent = s.gpuError ? `GPU stats unavailable: ${s.gpuError}` : "The PC is at your RAM limit, so the AI is slowed down to stay under it. Close apps to speed it up.";
}

function drawMeter(m, st) {
  const last = st.hist[st.hist.length - 1]; if (!last) return;
  const off = HISTORY - st.hist.length, hi = st.hoverSlot != null ? st.hoverSlot - off : -1;
  st.hover = hi >= 0 && hi < st.hist.length ? hi : null;
  const shown = st.hover != null ? st.hist[st.hover] : last;
  const status = last.r != null && m.status ? m.status(last.r) : null;
  st.el.className = "meter" + (status ? " " + status[0] : "");
  st.el.querySelector(".m-val").textContent = st.hover != null ? `${shown.text} · ${Math.round((last.t - shown.t) / 1000)}s ago` : shown.text;
  st.el.querySelector(".m-status").textContent = status ? status[1] : "";
  const bar = st.el.querySelector(".m-track i"); if (bar) bar.style.width = `${(last.r || 0) * 100}%`;
  const cv = st.el.querySelector("canvas"); if (!cv) return;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w) return;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const X = (i) => ((i + off) / (HISTORY - 1)) * (w - 3) + 1.5, Y = (r) => h - 1.5 - r * (h - 3);
  const pts = st.hist.map((p, i) => (p.r == null ? null : [X(i), Y(p.r)])).filter(Boolean);
  if (pts.length > 1) {
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineWidth = 2; ctx.strokeStyle = "#a78bfa"; ctx.lineJoin = "round"; ctx.stroke();
    ctx.lineTo(pts[pts.length - 1][0], h); ctx.lineTo(pts[0][0], h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "rgba(139,92,246,.35)"); g.addColorStop(1, "rgba(139,92,246,0)");
    ctx.fillStyle = g; ctx.fill();
  }
  const mi = st.hover != null ? st.hover : st.hist.length - 1, mark = st.hist[mi];
  if (st.hover != null) { ctx.fillStyle = "#9a9dbd"; ctx.fillRect(Math.round(X(mi)), 0, 1, h); }
  if (mark.r != null) { ctx.beginPath(); ctx.arc(X(mi), Y(mark.r), 3, 0, Math.PI * 2); ctx.fillStyle = "#c4b5fd"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#121330"; ctx.stroke(); }
}

// ------------------------------------------------------------------ RAM: pill, usage card, apps drawer
const ramUi = { timer: null, apps: [], closing: new Map(), open: false };
const RAM_FULL_SPEED_DEFAULT = 11 * 1073741824, RAM_MIN_START = 6 * 1073741824;

function initApps() {
  $("#ramToggle").onclick = () => setApps(!ramUi.open);
  $("#openApps").onclick = () => setApps(true);
  $("#closeApps").onclick = () => setApps(false);
  $("#scrim").onclick = () => setApps(false);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ramUi.open && !document.querySelector("dialog[open]")) setApps(false); });
  refreshApps(); schedApps();
}
function setApps(open) {
  ramUi.open = open; document.body.classList.toggle("apps-open", open);
  $("#scrim").hidden = !open; $("#appsDrawer").setAttribute("aria-hidden", String(!open));
  $("#ramToggle").setAttribute("aria-expanded", String(open));
  if (open) refreshApps();
  schedApps();
}
// Apps are listed often while the drawer is open; otherwise just enough to split "your apps" from Windows in the usage card.
function schedApps() { clearInterval(ramUi.timer); ramUi.timer = setInterval(() => { if (!document.hidden) refreshApps(); }, ramUi.open ? 4000 : 15000); }

function updateRamPill(s) {
  const pc = pcRam(s), r = pc.inUse / pc.limit, pill = $("#ramToggle");
  pill.className = "ram-pill" + (r >= 0.97 ? " crit" : r >= 0.85 ? " warn" : "");
  pill.querySelector("b").textContent = `RAM ${gb(pc.inUse)} / ${gb(pc.limit)} GB`;
  pill.querySelector(".ram-bar i").style.width = `${Math.min(100, r * 100)}%`;
  pill.querySelector(".ram-ico").style.setProperty("--p", `${Math.min(100, r * 100)}%`);
}

async function refreshApps() {
  try { const r = await api("/api/apps"); ramUi.apps = r.apps; renderRamBudget(); if (ramUi.open) renderApps(); }
  catch (e) { if (ramUi.open) $("#appList").innerHTML = `<p class="hint">Couldn't list apps: ${esc(e.message)}</p>`; }
}

/** RAM the last finished video job needed at full speed. */
function fullSpeedNeed() {
  const last = [...state.jobs.values()].filter((j) => !j.kind && j.ramPeak && j.status === "done").sort((a, b) => b.finished - a.finished)[0];
  return last ? last.ramPeak : RAM_FULL_SPEED_DEFAULT;
}

function renderRamBudget() {
  const s = state.stats; if (!s) return;
  const pc = pcRam(s), ai = (s.comfy && s.comfy.workingSet) || 0;
  const apps = Math.min(ramUi.apps.filter((a) => !a.protected).reduce((t, a) => t + a.bytes, 0), Math.max(0, pc.inUse - ai));
  const win = Math.max(0, pc.inUse - ai - apps), free = Math.max(0, pc.limit - pc.inUse);
  $("#rpInUse").textContent = gb(pc.inUse);
  $("#rpLimit").textContent = s.comfy && s.comfy.systemLimit ? `of ${gb(pc.limit)} GB limit in use` : `of ${gb(pc.total)} GB in use`;
  const segs = $$("#rpStack .seg"), pct = (b) => `${(b / pc.total) * 100}%`;
  segs[0].style.width = pct(ai); segs[1].style.width = pct(apps); segs[2].style.width = pct(win);
  $("#rpStack .limit-mark").style.left = pct(pc.limit);
  $("#rpLegend").innerHTML = [["ai", "ComfyUI (AI)", ai], ["apps", "Your apps", apps], ["win", "Windows & drivers", win], ["free", "Free under limit", free]]
    .map(([k, label, b]) => `<li><i class="${k}"></i>${label}<b>${gb(b)} GB</b></li>`).join("");
  const room = pc.limit - (pc.inUse - ai), need = fullSpeedNeed(), note = $("#rpNote");
  const shortBy = (x) => `${gb(Math.max(0.1 * 1073741824, x - room))} GB`;
  if (!s.comfy || !s.comfy.systemLimit) { note.className = "rp-note"; note.textContent = "The RAM limit is off (ComfyUI's RAM guard isn't running)."; }
  else if (room >= need) { note.className = "rp-note ok"; note.textContent = `The AI can use ${gb(room)} GB, enough for full speed.`; }
  else if (room >= RAM_MIN_START) { note.className = "rp-note warn"; note.textContent = `The AI can use ${gb(room)} GB. It works but runs slower; close about ${shortBy(need)} of apps for full speed.`; }
  else { note.className = "rp-note warn"; note.textContent = `Only ${gb(room)} GB left for the AI. Close about ${shortBy(RAM_MIN_START)} of apps so a generation can start.`; }
}

function renderApps() {
  const list = $("#appList"), rows = ramUi.apps.filter((a) => a.reason !== "Windows" && a.bytes >= 40 * 1048576).slice(0, 24);
  const max = Math.max(1, ...rows.map((a) => a.bytes));
  for (const name of [...ramUi.closing.keys()]) if (!ramUi.apps.some((a) => a.name === name)) { ramUi.closing.delete(name); toast(`${name} closed. Its RAM is free again.`); }
  list.innerHTML = rows.length ? "" : `<p class="hint">No apps are using much RAM.</p>`;
  for (const a of rows) {
    const el = document.createElement("div"), closing = ramUi.closing.get(a.name);
    el.className = "app-row" + (a.protected ? " me" : "") + (closing ? " closing" : "");
    el.innerHTML = `<span class="app-av"></span><div class="app-nm"><b></b><small>${gb(a.bytes)} GB${a.count > 1 ? ` · ${a.count} processes` : ""}</small></div>
      <span class="act-slot"></span><div class="app-bar"><i style="width:${(a.bytes / max) * 100}%"></i></div>`;
    el.querySelector(".app-av").textContent = (a.title || a.name).trim()[0].toUpperCase();
    el.querySelector(".app-nm b").textContent = a.title; el.querySelector(".app-nm b").title = `${a.name}.exe`;
    const slot = el.querySelector(".act-slot");
    if (a.protected) slot.innerHTML = `<span class="app-tag">${esc(a.reason)}</span>`;
    else {
      const stuck = closing && Date.now() - closing.at > 5000, force = !a.hasWindow || stuck;
      const b = document.createElement("button");
      b.className = "btn ghost" + (force ? " danger" : ""); b.textContent = closing && !stuck ? "Closing…" : force ? "Force close" : "Close";
      b.disabled = !!closing && !stuck;
      b.onclick = () => closeAppUi(a, force);
      slot.appendChild(b);
    }
    list.appendChild(el);
  }
}

async function closeAppUi(a, force) {
  const warn = a.caution ? `${a.caution}\n\n` : "";
  if (force) { if (!confirm(`${warn}Force close ${a.title}? Any unsaved work in it will be lost.`)) return; }
  else if (a.caution && !confirm(`${warn}Close ${a.title}?`)) return;
  try {
    await api("/api/apps/close", { method: "POST", body: { name: a.name, force } });
    ramUi.closing.set(a.name, { at: Date.now(), forced: force });
    toast(force ? `Ending ${a.title}…` : `Asked ${a.title} to close. If it has unsaved work, it may ask you first.`);
    renderApps(); setTimeout(refreshApps, 1500);
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------------ tuner (live chroma key)
const tuner = {
  jobId: null, raw: [], outImgs: [], outT: 0, outI: 0,
  refreshOut() {
    const j = state.jobs.get(this.jobId); if (!j) return;
    this.outImgs = Array.from({ length: j.frameCount }, (_, i) => { const im = new Image(); im.src = `/api/jobs/${j.id}/frame/${i}?v=${j.version}`; return im; });
  },
};
const K = { tol: $("#kTol"), soft: $("#kSoft"), spill: $("#kSpill"), clean: $("#kClean") };

function openTuner(id) {
  const j = state.jobs.get(id); tuner.jobId = id;
  $("#tTitle").textContent = `Tune · ${nice(j.action)}`;
  K.tol.value = j.key.tolerance; K.soft.value = j.key.softness; K.spill.value = j.key.despill; K.clean.value = j.key.cleanup;
  $("#tCount").value = j.frames; $("#tFps").value = j.fps;
  $("#tStart").value = j.range && j.range.start != null ? j.range.start : ""; $("#tEnd").value = j.range && j.range.end != null ? j.range.end : "";
  const fr = $("#tFrame"); fr.max = j.rawCount - 1; fr.value = (j.indices && Math.min(...j.indices)) || 0;
  tuner.raw = Array.from({ length: j.rawCount }, (_, i) => { const im = new Image(); im.src = `/api/jobs/${id}/raw/${i}`; return im; });
  tuner.refreshOut();
  $("#tuner").showModal();
  tuner.raw[+fr.value].onload = drawRaw; drawRaw(); syncOutputs();
}
function syncOutputs() { Object.values(K).forEach((i) => (i.nextElementSibling.value = i.value)); }
function drawRaw() {
  const j = state.jobs.get(tuner.jobId); if (!j) return;
  const n = +$("#tFrame").value; $("#tFrameN").textContent = `${n + 1}/${j.rawCount}`;
  const im = tuner.raw[n]; if (!im || !im.complete || !im.naturalWidth) { if (im) im.onload = drawRaw; return; }
  const c = $("#tRaw"); c.width = im.naturalWidth; c.height = im.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(im, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  Chroma.keyFrame(d.data, c.width, c.height, { key: j.settings.keyColor, tolerance: +K.tol.value, softness: +K.soft.value, despill: +K.spill.value, cleanup: +K.clean.value });
  ctx.putImageData(d, 0, 0);
}
Object.values(K).forEach((i) => (i.oninput = () => { syncOutputs(); drawRaw(); }));
$("#tFrame").oninput = drawRaw;
$("#tApply").onclick = async () => {
  const btn = $("#tApply"); btn.disabled = true; btn.textContent = "Applying…";
  const num = (v) => (v === "" ? null : +v);
  try {
    const j = await api(`/api/jobs/${tuner.jobId}/process`, { method: "POST", body: {
      key: { tolerance: +K.tol.value, softness: +K.soft.value, despill: +K.spill.value, cleanup: +K.clean.value },
      frames: +$("#tCount").value, fps: +$("#tFps").value, range: { start: num($("#tStart").value), end: num($("#tEnd").value) } } });
    const old = state.jobs.get(j.id); state.jobs.set(j.id, j); onJobChange(j, old); tuner.refreshOut(); toast("Applied.");
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = "Apply to sprite frames";
};
(function tunerLoop(ts) {
  if ($("#tuner").open && tuner.outImgs.length) {
    const j = state.jobs.get(tuner.jobId);
    if (ts - tuner.outT > 1000 / (+$("#tFps").value || j.fps || 10)) {
      tuner.outT = ts; tuner.outI = (tuner.outI + 1) % tuner.outImgs.length;
      const im = tuner.outImgs[tuner.outI];
      if (im.complete && im.naturalWidth) { const c = $("#tOut"); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext("2d").drawImage(im, 0, 0); }
    }
  }
  requestAnimationFrame(tunerLoop);
})(0);

// ------------------------------------------------------------------ dialogs & settings
$$("dialog [data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));
$("#tuner").addEventListener("close", () => { tuner.jobId = null; tuner.outImgs = []; });

$("#openSettings").onclick = async () => {
  await loadConfig();
  const f = $("#settingsForm"), c = state.config;
  const opts = (sel, withNone) => (sel.innerHTML = (withNone ? `<option value="">(none)</option>` : "") + state.workflows.map((w) => `<option>${esc(w)}</option>`).join(""));
  opts(f.workflow); opts(f.loopWorkflow, true);
  for (const el of f.elements) if (el.name && c[el.name] != null) el.value = c[el.name];
  $("#settings").showModal();
};
$("#settingsForm").onsubmit = async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try { const r = await api("/api/config", { method: "POST", body }); state.config = r.config; $("#settings").close(); toast("Settings saved (applies to new generations)."); checkComfy(); }
  catch (err) { toast(err.message, true); }
};
$("#wfUpload").onchange = async (e) => {
  const fd = new FormData(); fd.append("file", e.target.files[0]);
  try { const r = await api("/api/workflows", { method: "POST", body: fd }); await loadConfig(); $("#openSettings").click(); toast(`Workflow ${r.name} added.`); }
  catch (err) { toast(err.message, true); }
  e.target.value = "";
};
