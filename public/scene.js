/* SpriteForge Scene Kit page: a landscape broken into sprites, AI completion and variations,
   painting new scenes with the sprites, and exporting the kit. Uses app.js helpers ($, api, toast...). */
const Scene = (() => {
  const S = {
    list: [], id: store.get("sf.scene"), catalog: [], hints: {}, tab: "parts", show: "parts", hover: null, addMode: false, drag: null,
    find: new Set(JSON.parse(store.get("sf.sceneFind") || "null") || []), custom: JSON.parse(store.get("sf.sceneCustom") || "[]"),
    fmt: store.get("sf.sceneFmt") || "unity", lastLabel: "", sig: "", imgs: new Map(), alphas: new Map(),
  };
  const cur = () => S.list.find((s) => s.id === S.id);
  const busy = (s) => s && (s.status === "queued" || s.status === "analyzing");
  const plural = (w) => (/(grass|water|sky|snow|fog|mist|sand|ice|lava|foliage|ground|terrain|smoke|moss|scenery)$/.test(w) ? w
    : /(s|sh|ch|x)$/.test(w) ? w + "es" : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : w + "s");
  const catName = (label) => cap(plural(label));
  const picUrl = (s) => `/api/scenes/${s.id}/image`;
  const spriteUrl = (s, key, v) => `/api/scenes/${s.id}/sprite/${key}?v=${v || 1}`;
  const pivotOf = (p) => (/(cloud|sky)s?$/.test(p.label) ? [0.5, 0.5] : [0.5, 0]); // same rule as the server: clouds hang, the rest stands
  const byDepth = (a, b) => a.depth - b.depth || a.y + a.h - (b.y + b.h);
  const COLORS = ["#a78bfa", "#22d3ee", "#34d399", "#fbbf24", "#fb7185", "#60a5fa", "#f472b6", "#a3e635", "#f97316", "#e879f9"];
  const colorOf = (label) => COLORS[[...label].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
  const FMT_HINT = {
    unity: "Sliced sprites, a Tile per sprite plus a Tile Palette to paint with, prefabs, and the scene rebuilt as a prefab. Extract into your Unity project.",
    sheet: "Packed sprite sheet(s) + JSON with every sprite's rect, pivot and scale. Works with any engine.",
    png: "One transparent PNG per sprite, in a folder per kind (Trees, Rocks…), plus a JSON with sizes and positions.",
    psd: "Photoshop / Krita / GIMP file with one layer per sprite, where it was in the picture (AI versions as hidden layers).",
    svg: "Layered SVG for Figma, Inkscape, Illustrator or Affinity: one layer group per kind of object.",
  };

  /** Mean time of the last few finished image jobs (FLUX Kontext), for estimates. */
  function imageSeconds() {
    const done = [...state.jobs.values()].filter((j) => j.kind === "image" && j.status === "done" && j.started && j.finished).sort((a, b) => b.finished - a.finished).slice(0, 5);
    return done.length ? done.reduce((a, j) => a + (j.finished - j.started) / 1000, 0) / done.length : 240;
  }

  function loadImg(url, onload) {
    let im = S.imgs.get(url);
    if (!im) { im = new Image(); im.src = url; S.imgs.set(url, im); }
    if (onload && !im.complete) im.addEventListener("load", onload, { once: true });
    return im;
  }
  /** Alpha of an image pixel (natural size), for clicking on sprites through their transparent parts. */
  function alphaAt(im, x, y) {
    let a = S.alphas.get(im.src);
    if (!a) {
      const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(im, 0, 0);
      a = { w: c.width, data: ctx.getImageData(0, 0, c.width, c.height).data }; S.alphas.set(im.src, a);
    }
    x = Math.floor(x); y = Math.floor(y);
    return x < 0 || y < 0 || x >= a.w ? 0 : a.data[(y * a.w + x) * 4 + 3] || 0;
  }

  /** Everything that can be painted with, back to front: cut-outs and finished AI versions. */
  function spritesOf(s) {
    const out = [];
    for (const p of [...s.parts].sort(byDepth)) {
      const base = { part: p, label: p.label, depth: p.depth, pivot: pivotOf(p) };
      out.push({ ...base, key: p.id, name: nice(p.name), w: p.w, h: p.h, x: p.x, y: p.y, url: spriteUrl(s, p.id, p.version) });
      let n = 0;
      for (const v of p.variants) if (v.file) out.push({ ...base, key: `${p.id}.${v.id}`, variant: v, name: v.mode === "complete" ? `${nice(p.name)} full` : `${nice(p.name)} var ${++n}`,
        w: v.place.w, h: v.place.h, x: v.place.x, y: v.place.y, url: spriteUrl(s, `${p.id}.${v.id}`, v.version) });
    }
    return out;
  }

  // ------------------------------------------------------------------ data
  /** Never breaks the rest of the app: a server started before Scene Kit existed just gets a message. */
  async function init() {
    try { await load(); } catch (e) { S.offline = e.message || "Not Found"; }
  }
  async function load() {
    const [lab, list] = await Promise.all([api("/api/scene-labels"), api("/api/scenes")]);
    S.catalog = lab.labels; S.hints = lab.hints; S.list = list;
    if (!store.get("sf.sceneFind")) S.find = new Set(S.catalog.filter((l) => l.on).map((l) => l.id));
    if (!S.list.some((s) => s.id === S.id)) S.id = S.list.length ? S.list[S.list.length - 1].id : null;
  }
  function onScene(s) {
    const i = S.list.findIndex((x) => x.id === s.id);
    if (i >= 0) S.list[i] = s; else S.list.push(s);
    if (state.view !== "scene") return;
    renderList();
    if (s.id === S.id) render();
  }
  function onDeleted(id) {
    S.list = S.list.filter((s) => s.id !== id);
    if (S.id === id) S.id = S.list.length ? S.list[S.list.length - 1].id : null;
    if (state.view === "scene") show();
  }
  function onJob(j, finished) {
    const s = S.list.find((x) => x.id === j.part.sceneId);
    if (finished) {
      const p = s && s.parts.find((x) => x.id === j.part.partId);
      const what = j.part.mode === "plate" ? "Clean background" : j.part.mode === "complete" ? `${p ? nice(p.name) : "Sprite"} completed` : `${p ? cap(p.label) : "Sprite"} variation`;
      addNote(j.status === "done" ? `${what} is ready` : `${what} failed`, j.status === "error", { scene: j.part.sceneId, part: j.part.partId }, s ? nice(s.name) : "");
      if (j.status === "error") toast(`${what}: ${j.error}`, true);
    }
    if (state.view !== "scene" || !s || s.id !== S.id) return;
    if (j.part.mode === "plate") return renderCard();
    const card = $(`#part-${CSS.escape(j.part.partId)}`), p = s.parts.find((x) => x.id === j.part.partId);
    if (card && p) fillVariants(card, s, p);
  }
  function jobTitle(j) { return j.part.mode === "plate" ? "Clean background" : j.part.mode === "complete" ? "Complete sprite" : "Sprite variation"; }

  // ------------------------------------------------------------------ page
  function show() {
    if (!cur() && S.list.length) S.id = S.list[S.list.length - 1].id;
    S.sig = ""; render();
  }
  function select(id, partId) {
    if (!S.list.some((s) => s.id === id)) return;
    if (S.id !== id) { S.id = id; store.set("sf.scene", id); S.sig = ""; S.hover = null; P.sid = null; }
    if (state.view === "scene") render();
    if (partId) { setTab("parts"); setTimeout(() => flashPart(partId), 60); }
  }
  /** The server predates Scene Kit (or is down): say how to fix it instead of failing on every click. */
  function renderOffline() {
    $("#sceneEmpty").hidden = false; $("#scenePane").hidden = true;
    $("#sceneEmpty h2").textContent = "Restart SpriteForge to use Scene Kit";
    $("#sceneEmpty p").textContent = `The SpriteForge server that is running was started before Scene Kit was added (it answered “${S.offline}”). `
      + "Close its window, run start-spriteforge.bat again, then reload this page.";
    $("#sceneList").innerHTML = `<div class="side-empty">Restart SpriteForge to load scenes.</div>`;
    $("#scFind").disabled = $("#scPlateBtn").disabled = $("#scExport").disabled = true;
    $("#scFindHint").textContent = "Needs a restart of SpriteForge.";
  }
  function render() {
    if (S.offline) return renderOffline();
    renderList(); renderCard();
    const s = cur();
    $("#sceneEmpty").hidden = !!s; $("#scenePane").hidden = !s;
    if (!s) return;
    $("#scName").textContent = nice(s.name);
    const kits = s.parts.filter((p) => p.inKit).length;
    $("#scCount").textContent = s.parts.length;
    $("#scHint").textContent = busy(s) ? "Looking for objects…" : s.status === "error" ? `Couldn't finish: ${s.error}`
      : s.parts.length ? `${kits} of ${s.parts.length} sprites in the kit · ${s.w}×${s.h}` : "No sprites yet. Pick what to look for on the right, or add objects by hand.";
    $$("#scTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
    $("#scPartsTab").hidden = S.tab !== "parts"; $("#scPaintTab").hidden = S.tab !== "paint";
    if (S.tab === "parts") {
      renderBusy(s); drawStage();
      const sig = JSON.stringify(s.parts.map((p) => [p.id, p.version, p.inKit, p.label, p.variants.map((v) => [v.id, v.version, v.inKit, v.file])]));
      if (sig !== S.sig) { S.sig = sig; renderGroups(s); }
    } else openPaint(s);
  }
  function setTab(t) { S.tab = t; render(); }
  $$("#scTabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

  function renderList() {
    const box = $("#sceneList"); box.innerHTML = "";
    if (!S.list.length) { box.innerHTML = `<div class="side-empty">No scenes yet.</div>`; return; }
    for (const s of [...S.list].reverse()) {
      const el = document.createElement("div");
      el.className = "char-item scene-item" + (s.id === S.id ? " on" : "");
      el.innerHTML = `<img src="${picUrl(s)}" alt=""><div><b></b><small></small></div>`;
      el.querySelector("b").textContent = nice(s.name);
      el.querySelector("small").innerHTML = busy(s) ? `<span class="busy-dot"></span>${esc(s.stage && /RAM/.test(s.stage) ? "waiting for RAM" : `finding objects ${Math.round((s.progress || 0) * 100)}%`)}`
        : s.status === "error" && !s.parts.length ? "failed" : `${s.parts.length} sprite${s.parts.length === 1 ? "" : "s"}`;
      el.onclick = () => select(s.id);
      box.appendChild(el);
    }
  }

  // ------------------------------------------------------------------ upload
  async function upload(file) {
    if (!file || !/^image\//.test(file.type)) return toast("Please choose an image file (PNG or JPG).", true);
    if (S.offline) { // maybe it was restarted since this page loaded
      try { await load(); S.offline = null; show(); }
      catch { return toast("Restart SpriteForge first (close its window, run start-spriteforge.bat), then reload this page.", true); }
    }
    const tile = $("#sceneUploadTile"); tile.classList.add("busy");
    try {
      const fd = new FormData(); fd.append("image", file); fd.append("labels", JSON.stringify([...S.find]));
      const s = await api("/api/scenes", { method: "POST", body: fd });
      if (!S.list.some((x) => x.id === s.id)) S.list.push(s);
      S.tab = "parts"; select(s.id); setView("scene");
      toast(`${nice(s.name)} added. Finding its objects (about ${Math.max(10, S.find.size * 2)} s on your CPU)…`);
    } catch (e) { toast(e.message, true); }
    tile.classList.remove("busy");
  }
  $("#sceneUploadInput").onchange = (e) => { upload(e.target.files[0]); e.target.value = ""; };
  $(".scene-upload").onchange = (e) => { upload(e.target.files[0]); e.target.value = ""; };
  $("#addScene").onclick = () => $("#sceneUploadInput").click();

  $("#scMore").onclick = (e) => {
    e.stopPropagation();
    const s = cur(); if (!s) return;
    openMenu($("#scMore"), [
      ["Rename…", async () => { const n = prompt("Scene name", nice(s.name)); if (n) await api(`/api/scenes/${s.id}`, { method: "PATCH", body: { name: n } }).catch((er) => toast(er.message, true)); }],
      ["Find everything again (start over)", async () => {
        if (!confirm("Delete every sprite of this scene (and its AI versions) and look for objects again?")) return;
        await api(`/api/scenes/${s.id}/find`, { method: "POST", body: { labels: [...S.find], replace: true } }).catch((er) => toast(er.message, true));
      }],
      ["Download the picture", () => { const a = document.createElement("a"); a.href = picUrl(s); a.download = `${s.name}.png`; a.click(); }],
      "-",
      ["Delete scene", async () => { if (confirm(`Delete ${nice(s.name)} and all its sprites?`)) await api(`/api/scenes/${s.id}`, { method: "DELETE" }).catch((er) => toast(er.message, true)); }, "danger"],
    ]);
  };

  // ------------------------------------------------------------------ stage (the picture with its sprites)
  function renderBusy(s) {
    const box = $("#scBusy"), on = busy(s) || !!s.stage;
    box.hidden = !on;
    if (!on) return;
    const pct = Math.round((s.progress || 0) * 100), ram = /RAM/.test(s.stage || "");
    $("#scRing").style.setProperty("--p", busy(s) ? pct : 0);
    $("#scRing").textContent = busy(s) && !ram ? `${pct}%` : "…";
    $("#scBusyText").textContent = s.stage || (s.status === "queued" ? "Waiting to start…" : "Working…");
    $("#scBusyRam").hidden = !ram;
  }
  $("#scBusyRam").onclick = () => setApps(true);

  function tinted(im, color) {
    const key = im.src + color; let c = S.imgs.get(key);
    if (!c) {
      c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const x = c.getContext("2d"); x.drawImage(im, 0, 0); x.globalCompositeOperation = "source-in"; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
      S.imgs.set(key, c);
    }
    return c;
  }

  function drawStage() {
    const s = cur(), cv = $("#scCanvas"); if (!s || S.tab !== "parts") return;
    if (cv.width !== s.w || cv.height !== s.h) { cv.width = s.w; cv.height = s.h; }
    const ctx = cv.getContext("2d"); ctx.clearRect(0, 0, s.w, s.h);
    const pic = loadImg(picUrl(s), drawStage); if (!pic.complete) return;
    ctx.drawImage(pic, 0, 0);
    const hov = S.hover && s.parts.find((p) => p.id === S.hover);
    if (S.show === "parts" || hov) {
      ctx.fillStyle = hov ? "rgba(8,9,23,.62)" : "rgba(8,9,23,.35)"; ctx.fillRect(0, 0, s.w, s.h);
      for (const p of [...s.parts].sort(byDepth)) {
        if (hov && p !== hov) continue;
        const im = loadImg(spriteUrl(s, p.id, p.version), drawStage); if (!im.complete || !im.naturalWidth) continue;
        const col = colorOf(p.label);
        ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = hov ? 18 : 6;
        ctx.drawImage(im, p.x, p.y, p.w, p.h); ctx.restore();
        if (!hov) { ctx.globalAlpha = 0.28; ctx.drawImage(tinted(im, col), p.x, p.y, p.w, p.h); ctx.globalAlpha = 1; }
      }
    }
    if (S.drag) {
      const d = S.drag, lw = Math.max(2, s.w / 500);
      ctx.lineWidth = lw; ctx.setLineDash([lw * 4, lw * 3]); ctx.strokeStyle = "#fff";
      ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); ctx.setLineDash([]);
    }
  }
  $$("#scShow button").forEach((b) => (b.onclick = () => { S.show = b.dataset.show; $$("#scShow button").forEach((x) => x.classList.toggle("on", x === b)); drawStage(); }));

  const stagePt = (e) => { const cv = $("#scCanvas"), r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) * cv.width) / r.width, y: ((e.clientY - r.top) * cv.height) / r.height, cx: e.clientX, cy: e.clientY }; };
  /** The front-most sprite under a point of the picture. */
  function partAt(s, pt) {
    for (const p of [...s.parts].sort(byDepth).reverse()) {
      if (pt.x < p.x || pt.y < p.y || pt.x >= p.x + p.w || pt.y >= p.y + p.h) continue;
      const im = loadImg(spriteUrl(s, p.id, p.version));
      if (im.complete && im.naturalWidth && alphaAt(im, ((pt.x - p.x) * im.naturalWidth) / p.w, ((pt.y - p.y) * im.naturalHeight) / p.h) > 40) return p;
    }
    return null;
  }
  function setAddMode(on) {
    S.addMode = on; $("#scAddMode").classList.toggle("soft", on); $("#scAddMode").classList.toggle("ghost", !on);
    $("#scStage").classList.toggle("adding", on);
    $("#scStageHint").textContent = on ? "Click on an object, or drag a box around it. Esc to stop." : "Hover to see a sprite, click it to jump to it.";
  }
  $("#scAddMode").onclick = () => setAddMode(!S.addMode);
  const cv0 = $("#scCanvas");
  cv0.onpointerdown = (e) => {
    const s = cur(); if (!s) return;
    const pt = stagePt(e);
    if (!S.addMode) { const p = partAt(s, pt); if (p) flashPart(p.id); return; }
    cv0.setPointerCapture(e.pointerId);
    S.drag = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, cx: pt.cx, cy: pt.cy };
  };
  cv0.onpointermove = (e) => {
    const s = cur(); if (!s) return;
    const pt = stagePt(e);
    if (S.drag) { S.drag.x1 = pt.x; S.drag.y1 = pt.y; return drawStage(); }
    if (S.addMode) return;
    const p = partAt(s, pt), id = p ? p.id : null;
    cv0.style.cursor = p ? "pointer" : "";
    if (id !== S.hover) { S.hover = id; drawStage(); $("#scStageHint").textContent = p ? `${nice(p.name)} · ${p.w}×${p.h}` : "Hover to see a sprite, click it to jump to it."; }
  };
  cv0.onpointerleave = () => { if (!S.drag && S.hover) { S.hover = null; drawStage(); } };
  cv0.onpointerup = async (e) => {
    const d = S.drag, s = cur(); S.drag = null; if (!d || !s) return;
    drawStage();
    const moved = Math.hypot(e.clientX - d.cx, e.clientY - d.cy) > 6;
    const label = prompt("What is it? (for example: tree, rock, mountain, cloud, waterfall)", S.lastLabel || "");
    if (!label || !label.trim()) return;
    S.lastLabel = label.trim();
    const body = { label: S.lastLabel };
    if (moved) body.box = [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.x0, d.x1), Math.max(d.y0, d.y1)].map(Math.round);
    else body.points = [[Math.round(d.x0), Math.round(d.y0)]];
    $("#scStageHint").textContent = "Cutting it out…";
    try { const p = await api(`/api/scenes/${s.id}/parts`, { method: "POST", body }); toast(`${nice(p.name)} added.`); setTimeout(() => flashPart(p.id), 100); }
    catch (er) { toast(er.message, true); }
    setAddMode(S.addMode);
  };

  function flashPart(id) {
    const el = $(`#part-${CSS.escape(id)}`); if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }

  // ------------------------------------------------------------------ sprite cards
  function renderGroups(s) {
    const box = $("#scGroups"); box.innerHTML = "";
    if (!s.parts.length) {
      if (!busy(s)) box.innerHTML = `<div class="empty-note">No sprites yet. Choose what to look for on the right and press <b>Find these objects</b>, or use <b>Add an object by hand</b> above.</div>`;
      return;
    }
    const groups = new Map();
    for (const p of [...s.parts].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      if (!groups.has(p.label)) groups.set(p.label, []);
      groups.get(p.label).push(p);
    }
    const order = [...groups.entries()].sort((a, b) => b[1][0].depth - a[1][0].depth || b[1].length - a[1].length);
    for (const [label, parts] of order) {
      const g = document.createElement("section"); g.className = "sc-group";
      const layer = parts.every((p) => p.kind === "layer");
      g.innerHTML = `<div class="sc-group-head"><i style="background:${colorOf(label)}"></i><h3></h3><span class="count">${parts.length}</span><span class="hint">${layer ? "background layer" : "objects"}</span></div><div class="part-grid"></div>`;
      g.querySelector("h3").textContent = catName(label);
      const grid = g.querySelector(".part-grid");
      for (const p of parts) grid.appendChild(partCard(s, p));
      box.appendChild(g);
    }
  }

  function partCard(s, p) {
    const el = document.createElement("div");
    el.className = "part-card" + (p.inKit ? " kit" : ""); el.id = "part-" + p.id;
    el.innerHTML = `<div class="part-view checker"><img alt=""></div>
      <button class="tick" type="button" title="In the kit (exported). Untick to leave it out.">${svgUse("i-check")}</button>
      <div class="part-info"><div class="anim-name"><b></b><small></small></div><div class="tags"></div><div class="variants"></div><div class="anim-btns"></div></div>`;
    el.querySelector("img").src = spriteUrl(s, p.id, p.version);
    el.querySelector(".anim-name b").textContent = nice(p.name);
    el.querySelector(".anim-name small").textContent = `${p.w}×${p.h}`;
    const tags = [];
    if (p.kind === "layer") tags.push(`<span class="tag loop">Layer</span>`);
    if (p.hidden >= 0.03) tags.push(`<span class="tag warn" title="Part of it is behind other objects. Complete redraws it whole.">${Math.round(p.hidden * 100)}% hidden</span>`);
    if (p.cut && p.cut.length) tags.push(`<span class="tag warn" title="It runs off the picture. Complete draws the missing side.">cut off ${esc(p.cut.join(", "))}</span>`);
    if (p.source === "manual") tags.push(`<span class="tag state">added by hand</span>`);
    el.querySelector(".tags").innerHTML = tags.join("");
    const view = el.querySelector(".part-view");
    view.onmouseenter = () => { S.hover = p.id; drawStage(); };
    view.onmouseleave = () => { S.hover = null; drawStage(); };
    view.onclick = () => window.open(spriteUrl(s, p.id, p.version), "_blank");
    el.querySelector(".tick").onclick = () => patchPart(s, p, { inKit: !p.inKit });
    fillVariants(el, s, p);
    const b = el.querySelector(".anim-btns");
    const hasFull = p.variants.some((v) => v.mode === "complete");
    const complete = document.createElement("button"); complete.className = "btn ghost";
    complete.innerHTML = `${svgUse("i-spark")}${hasFull ? "Again" : "Complete"}`;
    complete.title = `FLUX Kontext redraws the whole ${p.label}, filling in hidden or cut-off parts (about ${dur(imageSeconds())} on your GPU)`;
    complete.onclick = () => makeAI(s, p, "complete");
    const vars = document.createElement("button"); vars.className = "btn ghost";
    vars.innerHTML = `${svgUse("i-spark")}Variations`;
    vars.title = `New ${plural(p.label)} in the same style, with a different shape`;
    vars.onclick = (e) => { e.stopPropagation(); openMenu(vars, variationMenu(s, p)); };
    const more = document.createElement("button"); more.className = "btn ghost more"; more.innerHTML = svgUse("i-dots"); more.title = "More"; more.setAttribute("aria-label", "More");
    more.onclick = (e) => { e.stopPropagation(); openMenu(more, partMenu(s, p)); };
    b.append(complete, vars, more);
    return el;
  }

  function fillVariants(el, s, p) {
    const box = el.querySelector(".variants"); box.innerHTML = "";
    box.hidden = !p.variants.length;
    for (const v of p.variants) {
      const j = v.jobId && state.jobs.get(v.jobId), active = j && isActive(j), pct = j ? Math.round((j.progress || 0) * 100) : 0;
      const t = document.createElement("button"); t.type = "button";
      t.className = "var-thumb checker" + (v.file && !v.inKit ? " off" : "") + (!v.file && !active ? " err" : "");
      const tag = v.mode === "complete" ? "Full" : "Var";
      if (v.file) t.innerHTML = `<img src="${spriteUrl(s, `${p.id}.${v.id}`, v.version)}" alt=""><i>${tag}</i>${active ? `<span class="var-busy">${pct}%</span>` : ""}`;
      else if (active) t.innerHTML = `<span class="ring sm" style="--p:${pct}">${j.status === "queued" ? "…" : pct}</span><i>${tag}</i>`;
      else t.innerHTML = `<span class="var-err">!</span><i>${tag}</i>`;
      t.title = v.file ? `${v.mode === "complete" ? "Completed" : "Variation"}${v.hint ? `: ${v.hint}` : ""}${v.inKit ? "" : " (not in the kit)"}`
        : active ? (j.status === "queued" ? "Queued" : j.stage || "Making it…") : `Failed${j && j.error ? `: ${j.error}` : ""}`;
      t.onclick = (e) => { e.stopPropagation(); openMenu(t, variantMenu(s, p, v, j)); };
      box.appendChild(t);
    }
  }

  async function patchPart(s, p, body) {
    try { await api(`/api/scenes/${s.id}/parts/${p.id}`, { method: "PATCH", body }); } catch (e) { toast(e.message, true); }
  }
  async function makeAI(s, p, mode, hint, quiet) {
    try {
      const made = await api(`/api/scenes/${s.id}/parts/${p.id}/ai`, { method: "POST", body: { mode, hint, count: 1 } });
      made.forEach((j) => state.jobs.set(j.id, j)); renderNow();
      if (!quiet) toast(`${mode === "complete" ? `Completing ${nice(p.name)}` : `New ${p.label} variation`} queued, about ${dur(imageSeconds())} on your GPU. It shows up on the card.`);
    } catch (e) { toast(e.message, true); }
  }
  function variationMenu(s, p) {
    const hints = S.hints[p.label] || S.hints.default || [];
    return [
      ...hints.map((h) => [cap(h), () => makeAI(s, p, "variation", h)]),
      "-",
      [`${Math.min(4, hints.length)} different ones (one of each above)`, async () => { for (const h of hints.slice(0, 4)) await makeAI(s, p, "variation", h, true); toast(`${Math.min(4, hints.length)} variations queued, about ${dur(imageSeconds() * Math.min(4, hints.length))} in all.`); }],
      [`Describe your own…`, () => { const h = prompt(`What should the new ${p.label} look like?`, ""); if (h && h.trim()) makeAI(s, p, "variation", h.trim()); }],
    ];
  }
  function partMenu(s, p) {
    return [
      ["Open full size", () => window.open(spriteUrl(s, p.id, p.version), "_blank")],
      ["Download PNG", () => { const a = document.createElement("a"); a.href = spriteUrl(s, p.id, p.version); a.download = `${p.name}.png`; a.click(); }],
      ["Change what it is…", () => { const l = prompt("What is it? (tree, rock, mountain…)", p.label); if (l && l.trim()) patchPart(s, p, { label: l.trim() }); }],
      [p.inKit ? "Leave out of the kit" : "Put in the kit", () => patchPart(s, p, { inKit: !p.inKit })],
      "-",
      ["Delete sprite", async () => { if (confirm(`Delete ${nice(p.name)}${p.variants.length ? " and its AI versions" : ""}?`)) await api(`/api/scenes/${s.id}/parts/${p.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true)); }, "danger"],
    ];
  }
  function variantMenu(s, p, v, j) {
    const url = spriteUrl(s, `${p.id}.${v.id}`, v.version), items = [];
    const retry = ["Make again (new take)", async () => { try { const r = await api(`/api/jobs/${v.jobId}/retry`, { method: "POST", body: {} }); state.jobs.set(r.id, r); renderNow(); toast("Queued again."); } catch (e) { toast(e.message, true); } }];
    const del = ["Delete", async () => { await api(`/api/scenes/${s.id}/parts/${p.id}/variants/${v.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true)); }, "danger"];
    if (v.file) {
      items.push(["Open full size", () => window.open(url, "_blank")],
        ["Download PNG", () => { const a = document.createElement("a"); a.href = url; a.download = `${p.name}_${v.mode === "complete" ? "full" : "variation"}.png`; a.click(); }],
        [v.inKit ? "Leave out of the kit" : "Put in the kit", () => patchPart(s, p, { variant: { id: v.id, inKit: !v.inKit } })]);
      if (!(j && isActive(j))) items.push(retry);
      if (v.hint) items.push(["-"], [`“${v.hint}”`, () => {}]);
    } else if (j && isActive(j)) items.push([j.status === "queued" ? "Queued" : `Making it… ${Math.round((j.progress || 0) * 100)}%`, () => {}]);
    else items.push(["Show error", () => alert((j && j.error) || "The job was removed.")], ...(j ? [retry] : []));
    if (!(j && j.status === "running")) items.push("-", del);
    return items.map((it) => (Array.isArray(it) && it[0] === "-" ? "-" : it));
  }

  // ------------------------------------------------------------------ right card
  function allLabels(s) {
    const seen = new Set(), out = [];
    for (const l of [...S.catalog.map((c) => c.id), ...S.custom, ...((s && s.labels) || []), ...S.find]) if (!seen.has(l)) { seen.add(l); out.push(l); }
    return out;
  }
  function renderCard() {
    const s = cur(), chips = $("#scLabels"); chips.innerHTML = "";
    const searched = new Set((s && s.labels) || []);
    for (const l of allLabels(s)) {
      const b = document.createElement("button"); b.type = "button";
      b.className = "chip" + (S.find.has(l) ? " on" : "") + (searched.has(l) ? " done" : "");
      b.textContent = l; b.title = searched.has(l) ? `Already looked for in this picture (looking again only adds new finds)` : `Look for ${plural(l)}`;
      b.onclick = () => { S.find.has(l) ? S.find.delete(l) : S.find.add(l); store.set("sf.sceneFind", JSON.stringify([...S.find])); renderCard(); };
      chips.appendChild(b);
    }
    const fb = $("#scFind");
    fb.disabled = !s || busy(s) || !S.find.size;
    fb.querySelector("span").textContent = s && busy(s) ? "Looking…" : `Find ${S.find.size ? S.find.size + " " : ""}thing${S.find.size === 1 ? "" : "s"}`;
    $("#scFindHint").textContent = !s ? "Upload a landscape first." : busy(s) ? (s.stage || "") : s.lastFind ? `Last search added ${s.lastFind.added} sprite${s.lastFind.added === 1 ? "" : "s"}. About 2 s per thing on your CPU.` : "About 2 s per thing on your CPU.";

    // clean background
    const plateJob = s && s.plate && s.plate.jobId && state.jobs.get(s.plate.jobId), making = plateJob && isActive(plateJob);
    const img = $("#scPlateImg"), has = s && s.plate && s.plate.version;
    img.src = !s ? "" : has ? `/api/scenes/${s.id}/plate?v=${s.plate.version}` : picUrl(s);
    img.classList.toggle("dim", !has);
    $("#scPlateHint").textContent = !s ? "The picture with its objects removed, to paint new scenes on."
      : making ? (plateJob.status === "queued" ? "Queued…" : `Making it… ${Math.round((plateJob.progress || 0) * 100)}%`)
      : plateJob && plateJob.status === "error" ? `Failed: ${plateJob.error}`
      : has ? "Ready. Pick it as the background when painting; it's also a layer in PSD/SVG exports." : "The picture with its objects removed, to paint new scenes on.";
    const pb = $("#scPlateBtn");
    pb.disabled = !s || making || !s.parts.some((p) => p.kind === "prop");
    pb.textContent = has ? "Make again" : `Make it (~${dur(imageSeconds())})`;

    // export
    $$("#scFmt button").forEach((b) => b.classList.toggle("on", b.dataset.fmt === S.fmt));
    $("#scFmtHint").textContent = FMT_HINT[S.fmt];
    const n = s ? s.parts.filter((p) => p.inKit).length + s.parts.reduce((a, p) => a + p.variants.filter((v) => v.file && v.inKit).length, 0) : 0;
    $("#scExport").disabled = !n;
    $("#scExportHint").textContent = n ? `${n} sprite${n === 1 ? "" : "s"} in the kit${s.layoutCount ? ` · painted scene with ${s.layoutCount}` : ""}` : "Tick sprites to put them in the kit.";
  }
  $("#scLabelForm").onsubmit = (e) => {
    e.preventDefault();
    const l = $("#scLabelIn").value.toLowerCase().replace(/[^a-z \-]/g, "").replace(/\s+/g, " ").trim();
    if (!l) return;
    if (!S.custom.includes(l) && !S.catalog.some((c) => c.id === l)) { S.custom.push(l); store.set("sf.sceneCustom", JSON.stringify(S.custom)); }
    S.find.add(l); store.set("sf.sceneFind", JSON.stringify([...S.find]));
    $("#scLabelIn").value = ""; renderCard();
  };
  $("#scFind").onclick = async () => {
    const s = cur(); if (!s) return;
    try { const r = await api(`/api/scenes/${s.id}/find`, { method: "POST", body: { labels: [...S.find] } }); onScene(r); }
    catch (e) { toast(e.message, true); }
  };
  $("#scPlateBtn").onclick = async () => {
    const s = cur(); if (!s) return;
    try { const j = await api(`/api/scenes/${s.id}/plate`, { method: "POST", body: {} }); state.jobs.set(j.id, j); renderNow(); renderCard(); toast("Clean background queued. It runs after any jobs ahead of it."); }
    catch (e) { toast(e.message, true); }
  };
  $$("#scFmt button").forEach((b) => (b.onclick = () => { S.fmt = b.dataset.fmt; store.set("sf.sceneFmt", S.fmt); renderCard(); }));
  $("#scExport").onclick = async () => {
    const s = cur(); if (!s) return;
    await flushPaint();
    const a = document.createElement("a"); a.href = `/api/scenes/${s.id}/export?format=${S.fmt}`; a.click();
    toast("Preparing the kit… the download starts in a moment.");
  };

  // ------------------------------------------------------------------ painter
  const P = { sid: null, items: [], sel: -1, tool: "brush", brush: null, undo: [], redo: [], bg: "sky", down: false, last: null, hover: null, saveT: null, wheelAt: 0, raf: 0 };
  const pcv = $("#pCanvas");

  async function openPaint(s) {
    if (P.sid !== s.id) {
      P.sid = s.id; P.items = []; P.sel = -1; P.undo = []; P.redo = []; P.brush = null;
      try {
        const l = await api(`/api/scenes/${s.id}/layout`);
        if (P.sid !== s.id) return;
        P.items = l.items || []; P.bg = l.bg || (s.plate && s.plate.version ? "plate" : "sky");
        $("#pSaved").textContent = l.saved ? "Saved" : "";
      } catch (e) { toast(e.message, true); }
    }
    $("#pBg").value = P.bg;
    $("#pBg option[value=plate]").disabled = !(s.plate && s.plate.version);
    const sprites = spritesOf(s);
    if (!sprites.some((sp) => sp.key === P.brush)) P.brush = (sprites.find((sp) => sp.part.kind === "prop") || sprites[0] || {}).key || null;
    renderPalette(s, sprites); draw();
  }

  function renderPalette(s, sprites) {
    const box = $("#pPalette"); box.innerHTML = `<div class="gs-label">Sprites <small>pick one, then paint</small></div>`;
    if (!sprites.length) { box.insertAdjacentHTML("beforeend", `<p class="hint">No sprites yet. Find objects on the Sprites tab first.</p>`); return; }
    const groups = new Map();
    for (const sp of sprites) { if (!groups.has(sp.label)) groups.set(sp.label, []); groups.get(sp.label).push(sp); }
    for (const [label, list] of [...groups.entries()].sort((a, b) => b[1][0].depth - a[1][0].depth)) {
      const h = document.createElement("div"); h.className = "pal-head"; h.innerHTML = `<i style="background:${colorOf(label)}"></i>${esc(catName(label))}`;
      const grid = document.createElement("div"); grid.className = "pal-grid";
      for (const sp of list) {
        const b = document.createElement("button"); b.type = "button"; b.className = "pal-item checker" + (sp.key === P.brush ? " on" : "");
        b.title = sp.name + (sp.variant ? (sp.variant.mode === "complete" ? " (completed by AI)" : ` (AI variation${sp.variant.hint ? `: ${sp.variant.hint}` : ""})`) : "");
        b.innerHTML = `<img src="${sp.url}" alt="">${sp.variant ? `<i>${sp.variant.mode === "complete" ? "Full" : "Var"}</i>` : ""}`;
        b.onclick = () => { P.brush = sp.key; setTool("brush"); $$("#pPalette .pal-item").forEach((x) => x.classList.toggle("on", x === b)); };
        grid.appendChild(b);
      }
      box.append(h, grid);
    }
  }

  const spriteMap = () => { const s = cur(); return new Map(s ? spritesOf(s).map((sp) => [sp.key, sp]) : []); };
  /** Draw order: by hand, or (auto depth) mountains behind trees and lower = nearer. */
  function drawOrder(map) {
    const idx = P.items.map((_, i) => i).filter((i) => map.has(P.items[i].k));
    if (!$("#pAuto").checked) return idx;
    const key = (i) => { const it = P.items[i], sp = map.get(it.k); return sp.depth * 1e6 + it.y + sp.h * it.s; };
    return idx.sort((a, b) => key(a) - key(b) || a - b);
  }
  function box(it, sp) { return { x: it.x, y: it.y, w: sp.w * it.s, h: sp.h * it.s }; }

  function drawItems(ctx, map, withUi) {
    const s = cur();
    ctx.clearRect(0, 0, s.w, s.h);
    if (P.bg === "sky") {
      const g = ctx.createLinearGradient(0, 0, 0, s.h); g.addColorStop(0, "#6fa8ef"); g.addColorStop(0.65, "#cfe4fb"); g.addColorStop(1, "#eef5fc");
      ctx.fillStyle = g; ctx.fillRect(0, 0, s.w, s.h);
    } else if (P.bg === "picture" || (P.bg === "plate" && s.plate && s.plate.version)) {
      const im = loadImg(P.bg === "picture" ? picUrl(s) : `/api/scenes/${s.id}/plate?v=${s.plate.version}`, draw);
      if (im.complete) ctx.drawImage(im, 0, 0, s.w, s.h);
    }
    for (const i of drawOrder(map)) {
      const it = P.items[i], sp = map.get(it.k), im = loadImg(sp.url, draw);
      if (!im.complete || !im.naturalWidth) continue;
      const b = box(it, sp);
      if (it.f) { ctx.save(); ctx.translate(b.x + b.w, b.y); ctx.scale(-1, 1); ctx.drawImage(im, 0, 0, b.w, b.h); ctx.restore(); }
      else ctx.drawImage(im, b.x, b.y, b.w, b.h);
    }
    if (!withUi) return;
    const lw = Math.max(1.5, s.w / 600);
    if (P.sel >= 0 && P.items[P.sel] && map.has(P.items[P.sel].k)) {
      const b = box(P.items[P.sel], map.get(P.items[P.sel].k));
      ctx.lineWidth = lw; ctx.strokeStyle = "#fff"; ctx.setLineDash([lw * 4, lw * 3]); ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = "#8b5cf6"; ctx.lineDashOffset = lw * 3.5; ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
    if (P.tool === "brush" && P.hover && !P.down && map.has(P.brush)) { // ghost of the next stamp
      const sp = map.get(P.brush), im = loadImg(sp.url, draw), sc = +$("#pSize").value;
      if (im.complete) { ctx.globalAlpha = 0.45; ctx.drawImage(im, P.hover.x - sp.w * sc * sp.pivot[0], P.hover.y - sp.h * sc * (1 - sp.pivot[1]), sp.w * sc, sp.h * sc); ctx.globalAlpha = 1; }
    }
    if (P.tool === "erase" && P.hover) { ctx.lineWidth = lw; ctx.strokeStyle = "#fb7185"; ctx.beginPath(); ctx.arc(P.hover.x, P.hover.y, lw * 6, 0, Math.PI * 2); ctx.stroke(); }
  }
  function draw() {
    const s = cur(); if (!s || S.tab !== "paint") return;
    if (pcv.width !== s.w || pcv.height !== s.h) { pcv.width = s.w; pcv.height = s.h; }
    drawItems(pcv.getContext("2d"), spriteMap(), true);
    $("#pUndo").disabled = !P.undo.length; $("#pRedo").disabled = !P.redo.length;
  }
  const queueDraw = () => { if (!P.raf) P.raf = requestAnimationFrame(() => { P.raf = 0; draw(); }); };

  function hit(pt, map) {
    const order = drawOrder(map);
    for (let n = order.length - 1; n >= 0; n--) {
      const i = order[n], it = P.items[i], sp = map.get(it.k), b = box(it, sp);
      if (pt.x < b.x || pt.y < b.y || pt.x >= b.x + b.w || pt.y >= b.y + b.h) continue;
      const im = loadImg(sp.url); if (!im.complete || !im.naturalWidth) continue;
      let lx = ((pt.x - b.x) / b.w) * im.naturalWidth; if (it.f) lx = im.naturalWidth - 1 - lx;
      if (alphaAt(im, lx, ((pt.y - b.y) / b.h) * im.naturalHeight) > 30) return i;
    }
    return -1;
  }
  function pushUndo() { P.undo.push(JSON.stringify(P.items)); if (P.undo.length > 80) P.undo.shift(); P.redo = []; }
  function changed() { queueDraw(); $("#pSaved").textContent = "Saving…"; clearTimeout(P.saveT); P.saveT = setTimeout(savePaint, 900); }
  async function savePaint() {
    clearTimeout(P.saveT); P.saveT = null;
    const s = cur(); if (!s || P.sid !== s.id) return;
    try { await api(`/api/scenes/${s.id}/layout`, { method: "PUT", body: { w: s.w, h: s.h, bg: P.bg, items: P.items } }); $("#pSaved").textContent = "Saved"; }
    catch (e) { $("#pSaved").textContent = "Not saved"; toast(e.message, true); }
  }
  async function flushPaint() { if (P.saveT) await savePaint(); }

  function stamp(pt, map) {
    const sp = map.get(P.brush); if (!sp) return 0;
    const j = +$("#pJitter").value, sc = +$("#pSize").value * (1 + (Math.random() * 2 - 1) * j);
    const w = sp.w * sc, h = sp.h * sc;
    P.items.push({ k: sp.key, x: +(pt.x - w * sp.pivot[0]).toFixed(1), y: +(pt.y - h * (1 - sp.pivot[1])).toFixed(1), s: +sc.toFixed(3), f: $("#pFlip").checked && Math.random() < 0.5 });
    return Math.max(8, w * 0.6); // spacing to the next stamp while dragging
  }
  const paintPt = (e) => { const r = pcv.getBoundingClientRect(); return { x: ((e.clientX - r.left) * pcv.width) / r.width, y: ((e.clientY - r.top) * pcv.height) / r.height }; };

  pcv.onpointerdown = (e) => {
    const s = cur(); if (!s) return;
    const map = spriteMap(), pt = paintPt(e);
    pcv.setPointerCapture(e.pointerId); P.down = true;
    if (P.tool === "brush") {
      if (!map.has(P.brush)) { P.down = false; return toast("Pick a sprite from the list on the right first.", true); }
      pushUndo(); P.last = { ...pt, gap: stamp(pt, map) }; changed();
    } else if (P.tool === "erase") {
      pushUndo(); const i = hit(pt, map); if (i >= 0) { P.items.splice(i, 1); P.sel = -1; changed(); }
    } else {
      P.sel = hit(pt, map);
      if (P.sel >= 0) { pushUndo(); const it = P.items[P.sel]; P.last = { dx: pt.x - it.x, dy: pt.y - it.y, moved: false }; }
      queueDraw();
    }
  };
  pcv.onpointermove = (e) => {
    const pt = paintPt(e); P.hover = pt;
    if (!P.down) return queueDraw();
    const map = spriteMap();
    if (P.tool === "brush" && P.last) {
      if (Math.hypot(pt.x - P.last.x, pt.y - P.last.y) >= P.last.gap) { P.last = { ...pt, gap: stamp(pt, map) }; changed(); }
    } else if (P.tool === "erase") {
      const i = hit(pt, map); if (i >= 0) { P.items.splice(i, 1); changed(); }
    } else if (P.sel >= 0 && P.last) {
      const it = P.items[P.sel]; it.x = +(pt.x - P.last.dx).toFixed(1); it.y = +(pt.y - P.last.dy).toFixed(1); P.last.moved = true; queueDraw();
    }
  };
  pcv.onpointerup = () => {
    if (P.tool === "select" && P.last && P.sel >= 0) { if (P.last.moved) changed(); else P.undo.pop(); }
    P.down = false; P.last = null; queueDraw();
  };
  pcv.onpointerleave = () => { P.hover = null; queueDraw(); };
  pcv.addEventListener("wheel", (e) => {
    if (P.tool !== "select" || P.sel < 0) return;
    e.preventDefault();
    const map = spriteMap(), it = P.items[P.sel], sp = map.get(it.k); if (!sp) return;
    if (Date.now() - P.wheelAt > 700) pushUndo();
    P.wheelAt = Date.now();
    const b = box(it, sp), px = b.x + b.w * sp.pivot[0], py = b.y + b.h * (1 - sp.pivot[1]); // keep the pivot (its foot) in place
    it.s = Math.max(0.05, Math.min(20, it.s * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    it.x = +(px - sp.w * it.s * sp.pivot[0]).toFixed(1); it.y = +(py - sp.h * it.s * (1 - sp.pivot[1])).toFixed(1);
    changed();
  }, { passive: false });

  function setTool(t) {
    P.tool = t; $$("#pTools button").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
    pcv.style.cursor = t === "select" ? "default" : t === "erase" ? "cell" : "crosshair";
    if (t !== "select") P.sel = -1;
    queueDraw();
  }
  $$("#pTools button").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  $("#pSize").oninput = (e) => { $("#pSizeOut").value = `${Math.round(e.target.value * 100)}%`; };
  $("#pJitter").oninput = (e) => { $("#pJitterOut").value = `±${Math.round(e.target.value * 100)}%`; };
  $("#pAuto").onchange = () => queueDraw();
  $("#pBg").onchange = (e) => { P.bg = e.target.value; changed(); };
  function undo() { if (!P.undo.length) return; P.redo.push(JSON.stringify(P.items)); P.items = JSON.parse(P.undo.pop()); P.sel = -1; changed(); }
  function redo() { if (!P.redo.length) return; P.undo.push(JSON.stringify(P.items)); P.items = JSON.parse(P.redo.pop()); P.sel = -1; changed(); }
  $("#pUndo").onclick = undo; $("#pRedo").onclick = redo;
  $("#pClear").onclick = () => { if (!P.items.length || !confirm("Remove every sprite from the painted scene?")) return; pushUndo(); P.items = []; P.sel = -1; changed(); };
  $("#pRebuild").onclick = () => {
    const s = cur(); if (!s) return;
    if (P.items.length && !confirm("Replace the painted scene with every sprite where it was in the picture?")) return;
    pushUndo();
    P.items = [...s.parts].sort(byDepth).map((p) => ({ k: p.id, x: p.x, y: p.y, s: 1, f: false }));
    P.sel = -1; changed();
  };
  $("#pPng").onclick = () => {
    const s = cur(); if (!s) return;
    const c = document.createElement("canvas"); c.width = s.w; c.height = s.h;
    drawItems(c.getContext("2d"), spriteMap(), false);
    c.toBlob((b) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${s.name}_painted.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
  };

  document.addEventListener("keydown", (e) => {
    if (state.view !== "scene" || document.querySelector("dialog[open]") || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === "Escape" && S.addMode) return setAddMode(false);
    if (S.tab !== "paint") return;
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, it = P.items[P.sel];
    if (ctrl && k === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (ctrl && k === "y") { e.preventDefault(); return redo(); }
    if (ctrl && k === "d" && it) { e.preventDefault(); pushUndo(); P.items.push({ ...it, x: it.x + 24, y: it.y }); P.sel = P.items.length - 1; return changed(); }
    if (ctrl) return;
    if (k === "b") return setTool("brush");
    if (k === "v") return setTool("select");
    if (k === "e") return setTool("erase");
    if (k === "escape") { P.sel = -1; return queueDraw(); }
    if (!it) return;
    if (k === "delete" || k === "backspace") { e.preventDefault(); pushUndo(); P.items.splice(P.sel, 1); P.sel = -1; return changed(); }
    if (k === "f") { pushUndo(); it.f = !it.f; return changed(); }
    if (k === "[" || k === "]") {
      if ($("#pAuto").checked) return toast("Turn off Auto depth to put sprites in front or behind by hand.");
      const to = k === "]" ? P.items.length - 1 : 0;
      pushUndo(); P.items.splice(P.sel, 1); P.items.splice(to, 0, it); P.sel = to; return changed();
    }
  });

  return { init, show, upload, select, onScene, onDeleted, onJob, jobTitle };
})();
