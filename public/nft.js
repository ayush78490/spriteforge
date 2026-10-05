/* NFT Forge — front-end module (no build step, same patterns as app.js / scene.js). */
const NFT = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const dur = (s) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);

  const state = { combos: [], config: null, baseFile: null, baseUrl: null, running: false, generated: 0, selected: new Set(), traits: null };

  async function loadConfig() {
    try {
      state.config = await api("/api/nft/config");
      $("#nftName").value = state.config.collectionName || "";
      $("#nftDesc").value = state.config.collectionDescription || "";
      $("#nftUrl").value = state.config.externalUrl || "";
      $("#nftRoyalty").value = state.config.sellerFeeBasisPoints || 500;
      $("#nftFee").value = state.config.feeRecipient || "";
      $("#nftW").value = state.config.imageWidth || 768;
      $("#nftH").value = state.config.imageHeight || 768;
      $("#nftSteps").value = state.config.steps || 20;
      $("#nftGuidance").value = state.config.guidance || 2.5;
      $("#nftCid").value = state.config.imagesCid || "";
    } catch {}
  }

  async function loadCombos() {
    try {
      const r = await api("/api/nft/combos");
      state.combos = r.combos || [];
      updateComboHint();
      renderGrid();
    } catch {}
  }

  async function loadStatus() {
    try {
      const s = await api("/api/nft/status");
      state.generated = s.generated;
      state.running = s.running;
      updateButtons();
    } catch {}
  }

  async function loadTraits() {
    try {
      const traits = await api("/api/nft/traits");
      state.traits = traits;
      renderTraitPreview(traits);
      if ($("#nftTraitStatus")) $("#nftTraitStatus").textContent = `${Object.keys(traits).length} trait categories loaded.`;
    } catch { state.traits = null; }
  }

  function renderTraitPreview(traits) {
    const el = $("#nftTraitPreview");
    if (!el) return;
    el.innerHTML = "";
    for (const [cat, values] of Object.entries(traits)) {
      const div = document.createElement("div");
      div.className = "nft-trait-cat";
      div.innerHTML = `<b>${esc(cat)}</b><div class="nft-trait-tags">${values.map(v =>
        `<span class="nft-trait-tag">${esc(v.value)}<span class="tw">w${v.weight}</span></span>`
      ).join("")}</div>`;
      el.appendChild(div);
    }
  }

  function updateComboHint() {
    const h = $("#nftComboHint");
    if (state.combos.length) h.textContent = `${state.combos.length} combinations ready.`;
    else h.textContent = "";
  }

  function updateButtons() {
    const hasBase = !!state.baseUrl || state.generated > 0;
    const hasTraits = !!state.traits && Object.keys(state.traits).length > 0;
    const hasCombos = state.combos.length > 0;
    if ($("#nftGenCombos")) $("#nftGenCombos").disabled = !hasTraits;
    $("#nftPreview").disabled = !hasBase || !hasCombos || state.running;
    $("#nftGenerate").disabled = !hasBase || !hasCombos || state.running;
    $("#nftStop").hidden = !state.running;
    $("#nftMetadata").disabled = state.generated < 1;
    $("#nftFinalize").disabled = state.generated < 1;
    $("#nftRarity").disabled = !hasCombos;
    if (!hasBase) $("#nftGenStatus").textContent = "Upload a base image first.";
    else if (!hasTraits) $("#nftGenStatus").textContent = "Define traits first (step 2).";
    else if (!hasCombos) $("#nftGenStatus").textContent = "Generate combinations first (step 3).";
    else if (state.running) {}
    else if (state.generated) $("#nftGenStatus").textContent = `${state.generated} images generated. Ready to continue or finalize.`;
    else $("#nftGenStatus").textContent = "Ready. Preview first to check quality, then generate all.";
  }

  function renderGrid() {
    const grid = $("#nftGrid");
    const hint = $("#nftGridHint");
    grid.innerHTML = "";
    const withImage = state.combos.filter(c => state.generated > 0);
    if (!state.combos.length && !state.generated) { hint.hidden = false; return; }
    hint.hidden = true;

    const shown = state.combos.filter(c => !c.rejected).slice(0, 200);
    for (const c of shown) {
      const el = document.createElement("div");
      el.className = "nft-card" + (state.selected.has(c.id) ? " selected" : "");
      el.dataset.id = c.id;
      const imgSrc = `/api/nft/image/${c.id}`;
      el.innerHTML = `<div class="nft-img checker"><img src="${esc(imgSrc)}" alt="#${c.id}" loading="lazy" onerror="this.parentElement.classList.add('empty')"></div>`
        + `<div class="nft-label"><b>#${c.id}</b><small>${Object.values(c.traits).filter(v => v !== "None").join(" · ")}</small></div>`
        + `<div class="nft-card-btns"><button class="btn ghost sm nft-reject" title="Reject &amp; regenerate">✕</button></div>`;
      el.querySelector(".nft-reject").onclick = (e) => { e.stopPropagation(); rejectOne(c.id); };
      el.onclick = () => {
        if (state.selected.has(c.id)) state.selected.delete(c.id); else state.selected.add(c.id);
        el.classList.toggle("selected", state.selected.has(c.id));
      };
      grid.appendChild(el);
    }
    const activeCount = state.combos.filter(c => !c.rejected).length;
    if (activeCount > 200) {
      const more = document.createElement("p");
      more.className = "hint center";
      more.textContent = `Showing 200 of ${activeCount}. Use the CLI for the full list.`;
      grid.appendChild(more);
    }
  }

  async function rejectOne(id) {
    if (!confirm(`Reject NFT #${id}? It will get a new seed and can be regenerated.`)) return;
    try {
      await api("/api/nft/reject", { method: "POST", body: { ids: [id] } });
      toast(`#${id} rejected. Run generate again to recreate it.`);
      await loadCombos();
      await loadStatus();
    } catch (e) { toast(e.message, true); }
  }

  async function rejectSelected() {
    const ids = [...state.selected];
    if (!ids.length) return toast("Select images to reject first.", true);
    if (!confirm(`Reject ${ids.length} NFTs?`)) return;
    try {
      await api("/api/nft/reject", { method: "POST", body: { ids } });
      state.selected.clear();
      toast(`${ids.length} rejected.`);
      await loadCombos();
      await loadStatus();
    } catch (e) { toast(e.message, true); }
  }

  function onEvent(data) {
    if (data.type === "progress") {
      state.running = true;
      const pct = Math.round((data.current / data.total) * 100);
      $("#nftPbarFill").style.width = pct + "%";
      $("#nftPct").textContent = pct + "%";
      const eta = data.eta ? ` · ETA ${dur(data.eta)}` : "";
      const elapsed = data.elapsed ? ` · ${dur(data.elapsed)} elapsed` : "";
      $("#nftGenStatus").textContent = `${data.current}/${data.total} · #${data.id} ${data.status}${elapsed}${eta}`;
      if (data.status === "done") state.generated = data.current;
      updateButtons();
      if (data.status === "done") {
        const combo = state.combos.find(c => c.id === data.id);
        if (combo && combo.rejected) { delete combo.rejected; renderGrid(); }
        const card = $(`.nft-card[data-id="${data.id}"]`);
        if (card) {
          const img = card.querySelector("img");
          if (img) { img.src = `/api/nft/image/${data.id}?v=${Date.now()}`; img.parentElement.classList.remove("empty"); }
        }
      }
    } else if (data.type === "error") {
      toast(`NFT #${data.id} failed: ${data.error}`, true);
    } else if (data.type === "done") {
      state.running = false;
      $("#nftStop").hidden = true;
      if (data.error) { toast(`Generation stopped: ${data.error}`, true); }
      else { toast(`Generation complete: ${data.completed || 0} done, ${data.skipped || 0} skipped, ${data.failed || 0} failed.`); }
      loadStatus();
      loadCombos();
    }
  }

  function show() {
    loadConfig();
    loadTraits();
    loadCombos();
    loadStatus();
    // Check if we already have a base image
    const img = new Image();
    img.onload = () => {
      state.baseUrl = "/api/nft/base";
      const thumb = $("#nftBaseThumb");
      thumb.innerHTML = `<img src="/api/nft/base?v=${Date.now()}" alt="base">`;
      $("#nftBaseName").textContent = "Base image loaded";
      updateButtons();
    };
    img.onerror = () => {};
    img.src = "/api/nft/base";
  }

  // --- wire up events ---
  function init() {
    // Base upload — send to server immediately so it persists
    $("#nftBaseInput").onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      state.baseFile = file;
      state.baseUrl = URL.createObjectURL(file);
      const thumb = $("#nftBaseThumb");
      thumb.innerHTML = `<img src="${state.baseUrl}" alt="base">`;
      $("#nftBaseName").textContent = "Uploading…";
      e.target.value = "";
      try {
        const fd = new FormData();
        fd.append("base", file);
        await api("/api/nft/base", { method: "POST", body: fd });
        $("#nftBaseName").textContent = file.name;
        toast("Base image uploaded.");
      } catch (err) {
        $("#nftBaseName").textContent = "Upload failed";
        toast(err.message, true);
        state.baseUrl = null;
        state.baseFile = null;
        thumb.innerHTML = `<span class="hint">Click to upload base character</span>`;
      }
      updateButtons();
    };
    $("#nftBaseThumb").onclick = () => $("#nftBaseInput").click();

    // Auto-generate traits from description
    if ($("#nftAutoTraits")) $("#nftAutoTraits").onclick = async () => {
      const desc = ($("#nftCharDesc") || {}).value || "";
      if (!desc.trim() || desc.trim().length < 5) return toast("Describe your base character first.", true);
      if ($("#nftTraitStatus")) $("#nftTraitStatus").textContent = "Generating traits with Ollama… (this may take 30-60s)";
      $("#nftAutoTraits").disabled = true;
      try {
        const r = await api("/api/nft/analyze", { method: "POST", body: { description: desc.trim() } });
        state.traits = r.traits;
        renderTraitPreview(r.traits);
        if ($("#nftTraitStatus")) $("#nftTraitStatus").textContent = `${Object.keys(r.traits).length} categories generated. Review them, then generate combinations.`;
        toast("Traits generated! Review them below.");
        updateButtons();
      } catch (e) {
        if ($("#nftTraitStatus")) $("#nftTraitStatus").textContent = "Failed — " + e.message;
        toast(e.message, true);
      } finally { $("#nftAutoTraits").disabled = false; }
    };
    // Load existing traits
    if ($("#nftLoadTraits")) $("#nftLoadTraits").onclick = async () => {
      await loadTraits();
      if (state.traits) toast(`Loaded ${Object.keys(state.traits).length} trait categories.`);
      updateButtons();
    };

    // Generate combos
    $("#nftGenCombos").onclick = async () => {
      const count = +$("#nftCount").value || 100;
      const seed = +$("#nftSeed").value || 42;
      try {
        const r = await api("/api/nft/combos", { method: "POST", body: { count, seed } });
        state.combos = r.combos;
        updateComboHint();
        renderGrid();
        updateButtons();
        toast(`${r.combos.length} combinations generated (max ${r.max}).`);
      } catch (e) { toast(e.message, true); }
    };

    // Preview
    $("#nftPreview").onclick = () => startGenerate(true);
    // Generate all
    $("#nftGenerate").onclick = () => startGenerate(false);
    // Stop
    $("#nftStop").onclick = async () => {
      try { await api("/api/nft/stop", { method: "POST" }); } catch {}
    };

    // Save config
    $("#nftSaveConfig").onclick = async () => {
      try {
        await api("/api/nft/config", { method: "POST", body: {
          collectionName: $("#nftName").value, collectionDescription: $("#nftDesc").value,
          externalUrl: $("#nftUrl").value, sellerFeeBasisPoints: +$("#nftRoyalty").value,
          feeRecipient: $("#nftFee").value,
          imageWidth: +$("#nftW").value, imageHeight: +$("#nftH").value,
          steps: +$("#nftSteps").value, guidance: +$("#nftGuidance").value,
        }});
        toast("Settings saved.");
      } catch (e) { toast(e.message, true); }
    };

    // Metadata
    $("#nftMetadata").onclick = async () => {
      try {
        const r = await api("/api/nft/metadata", { method: "POST" });
        toast(`Metadata generated for ${r.count} NFTs.`);
        if (r.rarity) renderRarity(r.rarity);
      } catch (e) { toast(e.message, true); }
    };

    // Finalize
    $("#nftFinalize").onclick = async () => {
      if (!confirm("Finalize? This renumbers all IDs continuously and regenerates metadata.")) return;
      try {
        const r = await api("/api/nft/finalize", { method: "POST" });
        toast(`Finalized: ${r.total} NFTs.`);
        await loadCombos();
        await loadStatus();
      } catch (e) { toast(e.message, true); }
    };

    // Rarity
    $("#nftRarity").onclick = async () => {
      try {
        const rarity = await api("/api/nft/rarity");
        renderRarity(rarity);
        toast("Rarity report generated.");
      } catch (e) { toast(e.message, true); }
    };

    // Set CID
    $("#nftSetCid").onclick = async () => {
      const cid = $("#nftCid").value.trim();
      if (!cid) return toast("Enter the IPFS CID first.", true);
      try {
        const r = await api("/api/nft/set-cid", { method: "POST", body: { cid } });
        toast(`CID updated in ${r.count} metadata files.`);
        $("#nftCidHint").textContent = `Set to ${cid}`;
      } catch (e) { toast(e.message, true); }
    };
  }

  async function startGenerate(preview) {
    try {
      state.running = true;
      updateButtons();
      $("#nftPbarFill").style.width = "0%";
      $("#nftPct").textContent = "0%";
      $("#nftGenStatus").textContent = preview ? "Starting preview (10 images)…" : "Starting generation…";
      const fd = new FormData();
      fd.append("preview", preview ? "true" : "false");
      await api("/api/nft/generate", { method: "POST", body: fd });
    } catch (e) {
      state.running = false;
      updateButtons();
      toast(e.message, true);
    }
  }

  function renderRarity(rarity) {
    const panel = $("#nftRarityPanel");
    panel.innerHTML = "";
    for (const [cat, vals] of Object.entries(rarity)) {
      const sec = document.createElement("div");
      sec.className = "nft-rarity-cat";
      sec.innerHTML = `<b>${esc(cat)}</b>`;
      for (const v of vals) {
        const row = document.createElement("div");
        row.className = "nft-rarity-row";
        row.innerHTML = `<span>${esc(v.value)}</span><span class="nft-rbar"><i style="width:${v.percent}%"></i></span><span>${v.count} (${v.percent}%)</span>`;
        sec.appendChild(row);
      }
      panel.appendChild(sec);
    }
  }

  init();
  return { show, onEvent };
})();
