# SpriteForge

A local AI creative toolkit that runs entirely on your machine. No per-generation cost, only your GPU time.

**Four tools in one:**

| Tool | What it does |
|---|---|
| **Animate** | Upload a character image, pick actions, get sprite sheets (PNG/GIF/Unity) with green-screen keying, loop detection, and alignment |
| **Image Studio** | FLUX Kontext image editing: restyle, repose, combine references, text-to-image, video clips with speech and sound |
| **Scene Kit** | Break a landscape into reusable sprites (auto-detect objects, cut out, AI-complete hidden parts, paint scenes, export to Unity/PSD/SVG) |
| **NFT Forge** | Generate a collection of unique NFT images from one base character using trait-based AI editing, with OpenSea-compatible metadata |

---

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Models](#models)
- [Features](#features)
  - [Animate (Sprite Generation)](#1-animate-sprite-generation)
  - [Image Studio](#2-image-studio)
  - [Scene Kit](#3-scene-kit)
  - [NFT Forge](#4-nft-forge)
- [NFT Forge - Detailed Guide](#nft-forge---detailed-guide)
  - [UI Workflow](#ui-workflow)
  - [CLI Reference](#cli-reference)
  - [Traits System](#traits-system)
  - [Output Structure](#output-structure)
  - [Deploying to OpenSea](#deploying-to-opensea)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [RAM Management](#ram-management)
- [Tips for Good Results](#tips-for-good-results)
- [Testing Without a GPU](#testing-without-a-gpu)
- [License](#license)

---

## Requirements

- **NVIDIA GPU**, 6 GB VRAM or more (tuned for RTX 4050 Laptop 6 GB)
- **24 GB system RAM** or more (whole-PC usage kept under 22 GB by default)
- **ComfyUI** portable build with [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) custom node
- **Node.js 18+**
- **Ollama** (optional, for NFT Forge auto-trait generation) with `qwen2.5:7b` model

## Installation

```bash
git clone <repo-url>
cd spriteforge
npm install
```

### ComfyUI Setup

SpriteForge expects ComfyUI at `D:\ComfyUI_windows_portable`. Edit `start-spriteforge.bat` if yours is elsewhere.

Required custom nodes (in `ComfyUI/custom_nodes/`):
- `ComfyUI-GGUF` — GGUF model loading
- `ComfyUI-VideoHelperSuite` — video encoding
- `ComfyUI-MMAudio` (kijai) — audio generation
- `ComfyUI-Qwen-TTS` (flybirdxx) — text-to-speech
- `spriteforge_nodes` — low-VRAM MMAudio sampler (ships with SpriteForge)
- `spriteforge_ram_guard` — whole-PC RAM limiter (ships with SpriteForge)

### Ollama Setup (for NFT Forge trait generation)

```bash
# Install Ollama from https://ollama.com
ollama pull qwen2.5:7b
```

## Quick Start

**Option A — One-click (Windows):**
```
Double-click start-spriteforge.bat
```
This starts ComfyUI, waits for it, installs dependencies if needed, and opens the browser.

**Option B — Manual:**
```bash
# Terminal 1: Start ComfyUI
cd D:\ComfyUI_windows_portable
python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --listen 127.0.0.1 --port 8188

# Terminal 2: Start SpriteForge
cd spriteforge
npm start          # http://localhost:8000
```

Set the ComfyUI URL in **Settings** if it's not `http://127.0.0.1:8188`.

## Models

| Feature | Model files (in `ComfyUI/models/`) |
|---|---|
| **Animation** (Wan 2.2 14B I2V, GGUF Q3_K_M + 4-step Lightning) | `diffusion_models/Wan2.2-I2V-A14B-HighNoise-Q3_K_M.gguf`, `diffusion_models/Wan2.2-I2V-A14B-LowNoise-Q3_K_M.gguf`, `loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors`, `loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors`, `text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`, `vae/wan_2.1_vae.safetensors` |
| **Image Studio / NFT Forge** (FLUX.1 Kontext [dev], GGUF Q4_K_M) | `diffusion_models/flux1-kontext-dev-Q4_K_M.gguf`, `text_encoders/clip_l.safetensors`, `text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors`, `vae/ae.safetensors` |
| **Sound** (MMAudio large 44k, fp16) | `mmaudio/` folder (large_44k_v2, vae_44k, synchformer, DFN5B-CLIP, bigvgan_v2) |
| **Speech** (Qwen3-TTS 0.6B) | `qwen-tts/` folder (Qwen3-TTS-12Hz-0.6B-CustomVoice, tokenizer) |
| **Scene Kit** (CPU, auto-downloaded) | Grounding DINO tiny + SAM 2.1 tiny (int8 ONNX, ~260 MB in `data/models`) |

> FLUX.1 Kontext [dev] is released under the FLUX.1 [dev] Non-Commercial License. Check its terms before using outputs commercially.

---

## Features

### 1. Animate (Sprite Generation)

Upload a character image, pick animation actions, and get production-ready sprite sheets.

**Workflow:**
1. **Upload** a full-body character image (side-view works best; flat backgrounds are removed automatically)
2. **Tick actions** — 47 fighter presets (Idle, Walk, Jab, Roundhouse Kick, Special Projectile...) + 14 general actions
3. **Generate** — jobs run through ComfyUI one at a time with live progress
4. **Preview & Tune** — hover to play, open large preview, adjust green-key, frame count, FPS, frame range
5. **Download** — PNG sequence, GIF, sprite sheet, or Unity pack (with `SpriteForgeSceneKit.cs` editor script)

**Key features:**
- Green-screen keying with despill, auto-loop detection, scale/floor-line alignment
- **View Angle**: FLUX Kontext generates side/front/back views, each animated separately
- **Walk Backward** reuses Walk Forward played in reverse (no extra generation)
- **Perfect loops**: use a first-last-frame workflow for seamless looping actions
- Custom ComfyUI workflows: export your own Wan I2V workflow (API format) and upload it in Settings

### 2. Image Studio

FLUX Kontext-powered image editing:
- Edit character appearance, restyle, repose
- Combine multiple reference images into one scene (up to 3)
- Text-to-image generation
- **Video clips with sound** (up to 30s): Wan 2.2 video + MMAudio sound + Qwen3-TTS speech, with multi-part chaining for long clips

### 3. Scene Kit

Turn a landscape into a kit of reusable sprites:
1. **Upload a landscape** — auto-detects objects (trees, bushes, rocks, clouds, etc.) using Grounding DINO + SAM 2.1
2. **Cut out** each object as a transparent sprite, with depth-aware overlap handling
3. **AI Complete** — FLUX Kontext fills in hidden/cut-off parts of sprites
4. **Variations** — generate new sprites in the same style
5. **Paint a scene** — drag and drop sprites to compose new scenes
6. **Export** — Unity (with tile palette), sprite sheet, PNG sprites, PSD layers, SVG layers

### 4. NFT Forge

Generate a collection of unique NFT images from one base character. Uses FLUX Kontext to apply trait-based visual edits, producing genuinely unique variations with OpenSea-compatible metadata.

See the [detailed guide below](#nft-forge---detailed-guide).

---

## NFT Forge - Detailed Guide

### Overview

NFT Forge takes ONE base character image and generates a collection of unique NFTs by:
1. Analyzing your character to generate fitting trait categories (via Ollama)
2. Creating weighted random combinations of traits
3. Using FLUX Kontext to edit the base image with each unique trait combination
4. Producing OpenSea/ERC-721 compatible metadata

### UI Workflow

Open `http://localhost:8000` and click the **NFT Forge** tab.

#### Step 1: Upload Base Character
- Click **Choose image** and upload your base character image
- The image is uploaded to the server immediately and persists across sessions
- Best results with clear, well-lit character art on a simple background

#### Step 2: Define Traits
Two options:

**A. Auto-generate (recommended):**
1. Describe your character in the text field (e.g. "A pixel art knight with blue armor, holding a sword, standing on grass")
2. Click **Auto-generate traits (Ollama)** — requires Ollama running with `qwen2.5:7b`
3. Review the generated trait categories and values
4. Traits are saved to `nft/traits.json` and can be edited manually

**B. Manual:**
- Edit `nft/traits.json` directly (see [Traits System](#traits-system))
- Click **Load current traits** in the UI

#### Step 3: Generate Combinations
- Set **Count** (how many NFTs to generate, max = product of all trait value counts)
- Set **Seed** for reproducibility (same seed = same combinations)
- Click **Generate combinations**

#### Step 4: Generate Images
- **Preview (10)** — generates the first 10 images to check quality before committing to the full run
- **Generate all** — generates all remaining images (resumable: stop and restart anytime, existing images are skipped)
- **Stop** — stops generation gracefully (resume later with Generate all)
- Progress bar shows current/total, elapsed time, and ETA
- Each image takes ~4 minutes on an RTX 4050 (6 GB VRAM)

#### Step 5: Results
- Browse generated NFTs in the grid (click to select, X to reject)
- **Reject** — removes the image and assigns a new seed; the combo will be regenerated on the next Generate run
- **Generate metadata** — creates OpenSea-compatible JSON files
- **Finalize IDs** — renumbers all NFTs continuously (fills gaps from rejected images)
- **Rarity report** — shows trait distribution across the collection

#### Right Panel
- **Collection Settings** — name, description, royalty (basis points), fee recipient, image dimensions, generation steps, guidance scale
- **IPFS & Deploy** — paste the IPFS CID after uploading images, updates all metadata files
- **Rarity** — visual breakdown of trait frequency

### CLI Reference

All commands run from the project root.

```bash
# Auto-generate traits from a character description (requires Ollama)
node nft/cli.js analyze --desc "A pixel art knight with blue armor"

# Generate 100 unique trait combinations with seed 42
node nft/cli.js combos --count 100 --seed 42

# Preview: generate first 10 images
node nft/cli.js preview --base ./my-character.png

# Generate all images (resumable — safe to stop and restart)
node nft/cli.js generate --base ./my-character.png

# Reject bad images and regenerate with new seeds
node nft/cli.js reject --ids 5,12,37 --base ./my-character.png

# Generate OpenSea-compatible metadata
node nft/cli.js metadata

# Set the real IPFS CID after uploading images
node nft/cli.js set-cid --cid QmYourCIDHere

# Renumber IDs to be continuous (after rejecting some)
node nft/cli.js finalize

# Show trait rarity breakdown
node nft/cli.js rarity

# Add AI-generated descriptions via Ollama (optional)
node nft/cli.js describe
```

### Traits System

Traits are defined in `nft/traits.json`. Each category contains values with weights and Kontext editing prompts.

**Format:**
```json
{
  "Background": [
    {
      "value": "Cosmic Void",
      "weight": 25,
      "prompt": "Change the background to a deep cosmic void with distant stars and purple nebulae"
    },
    {
      "value": "Lava Pit",
      "weight": 10,
      "prompt": "Change the background to a bubbling lava pit with orange glow"
    }
  ],
  "Outfit": [
    {
      "value": "None",
      "weight": 30,
      "prompt": ""
    },
    {
      "value": "Golden Armor",
      "weight": 10,
      "prompt": "Dress the character in shining golden plate armor"
    }
  ]
}
```

**Rules:**
- Each category needs at least 2 values
- **weight** controls rarity (lower = rarer). Weights within a category should roughly sum to 100
- **prompt** is the instruction sent to FLUX Kontext. Must be clear and specific about what to change visually
- A value of `"None"` with an empty prompt means "keep the original" for that category
- Max unique combinations = product of value counts across all categories (e.g. 5 x 5 x 4 x 5 x 5 = 2500)

**Auto-generation:** The `analyze` command / UI button uses Ollama `qwen2.5:7b` to generate 5 categories with 4-6 values each, tailored to your specific character description. Review and edit the result before generating combos.

### Configuration

Edit `nft/config.json`:

```json
{
  "collectionName": "My NFT Collection",
  "collectionDescription": "A unique collection of AI-generated character NFTs.",
  "externalUrl": "https://example.com",
  "imagesCid": "PLACEHOLDER_CID",
  "sellerFeeBasisPoints": 500,
  "feeRecipient": "0x0000000000000000000000000000000000000000",
  "comfyUrl": "http://127.0.0.1:8188",
  "imageWidth": 768,
  "imageHeight": 768,
  "steps": 20,
  "guidance": 2.5,
  "outputDir": "nft/output"
}
```

| Field | Description |
|---|---|
| `sellerFeeBasisPoints` | Royalty in basis points (500 = 5%) |
| `feeRecipient` | Wallet address that receives royalties |
| `imageWidth` / `imageHeight` | Output image dimensions (768x768 recommended) |
| `steps` | Kontext sampling steps (20 is a good balance of quality/speed) |
| `guidance` | Kontext guidance scale (2.5 default; higher = more literal prompt following) |

### Output Structure

```
nft/output/
  base.png             # Uploaded base character (resized to target dimensions)
  combos.json          # All combinations with traits, prompts, seeds, status
  images/              # Generated NFT images (1.png, 2.png, ...)
  metadata/            # OpenSea-compatible metadata (1, 1.json, 2, 2.json, ...)
  collection.json      # Collection-level metadata
  rarity.json          # Trait rarity breakdown
  errors.log           # Generation error log
```

**Metadata format (per NFT):**
```json
{
  "name": "My NFT Collection #1",
  "description": "A unique collection of AI-generated character NFTs.",
  "image": "ipfs://QmYourCID/1.png",
  "external_url": "https://example.com",
  "attributes": [
    { "trait_type": "Background", "value": "Cosmic Void" },
    { "trait_type": "Outfit", "value": "Golden Armor" }
  ]
}
```

### Deploying to OpenSea

1. **Upload images to IPFS** (e.g. [Pinata](https://pinata.cloud), free tier):
   - Upload the `nft/output/images/` folder
   - Copy the resulting CID
2. **Update metadata**: run `node nft/cli.js set-cid --cid QmYourCID` or use the UI
3. **Upload metadata to IPFS**: upload the `nft/output/metadata/` folder, copy the metadata CID
4. **Create collection on OpenSea**:
   - Go to [opensea.io](https://opensea.io), connect your wallet
   - Create a new collection
   - Deploy an ERC-721 smart contract with the metadata base URI set to `ipfs://YOUR_METADATA_CID/`
   - The `collection.json` file has collection-level metadata

---

## API Reference

### Sprite Animation
Jobs are queued through the web UI. Progress is streamed via SSE at `/events`.

### Video Clips
```bash
# Queue a video clip (multipart or JSON)
curl -F prompt="camera pushes in as waves crash" \
     -F seconds=3 -F shape=landscape \
     -F 'sound={"prompt":"waves crashing, seagulls"}' \
     -F 'speech={"text":"Welcome.","speaker":"Serena","start":0.4}' \
     -F image=@shore.png \
     http://localhost:8000/api/clips

# Poll status
curl http://localhost:8000/api/clips/<id>

# Download final MP4
curl -o clip.mp4 http://localhost:8000/api/clips/<id>/video
# Silent version (no audio)
curl -o clip.mp4 http://localhost:8000/api/clips/<id>/video?silent=1
```

**Clip fields:** `prompt` (motion, required), `scene` (first-frame text), `image` | `imageJobId` | `characterId`, `images` + `imagesMode` (`keyframes` up to 7 or `combine` up to 3), `seconds` (1-30), `shape` (landscape|portrait|square), `sound` ({prompt, negative, volume}), `speech` ({text, speaker, language, instruct, start, volume}), `fitSpeech`, `seed`, `tile` (VAE tile, default 128).

**Voices:** Ryan, Aiden, Dylan, Eric, Serena, Vivian, Sohee, Ono_anna, Uncle_fu.

### NFT Forge API

All endpoints are under `/api/nft/`. Body is JSON unless noted.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/config` | Get collection config |
| `POST` | `/config` | Update collection config (merge) |
| `GET` | `/traits` | Get current traits |
| `POST` | `/traits` | Replace traits |
| `GET` | `/analyze/status` | Check if Ollama is available |
| `POST` | `/analyze` | Auto-generate traits from description (`{description}`) |
| `POST` | `/combos` | Generate combinations (`{count, seed}`) |
| `GET` | `/combos` | Get current combinations |
| `POST` | `/base` | Upload base image (multipart, field: `base`) |
| `GET` | `/base` | Get saved base image |
| `POST` | `/generate` | Start generation (multipart, optional `base` file, `preview=true` for first 10) |
| `POST` | `/stop` | Stop current generation |
| `GET` | `/status` | Get generation status (`{running, generated}`) |
| `POST` | `/reject` | Reject combos (`{ids: [1,2,3]}`) |
| `POST` | `/metadata` | Generate metadata files |
| `POST` | `/set-cid` | Update IPFS CID in metadata (`{cid}`) |
| `POST` | `/finalize` | Renumber IDs continuously |
| `GET` | `/rarity` | Get rarity report |
| `GET` | `/image/:id` | Get generated image |

---

## Project Structure

```
spriteforge/
  server.js              Express server: API, job queue, SSE, NFT routes
  start-spriteforge.bat  One-click launcher (ComfyUI + SpriteForge)
  package.json           Dependencies and scripts

  lib/
    comfy.js             ComfyUI client (WebSocket, upload, queue, progress)
    workflow.js          Graph-tracing workflow patcher
    imagegen.js          FLUX Kontext workflows (single/multi-reference, text-to-image)
    pipeline.js          Green-screen prep, keying, alignment, sheets, GIF, zip, Unity pack
    actions.js           47 fighter + 14 general action presets and prompt builder
    clip.js              Video clips: Wan video, MMAudio, Qwen3-TTS, ffmpeg mix
    scene.js             Scene Kit: object detection, masking, sprite extraction
    sceneWorker.js       Child process for Scene Kit models (keeps server responsive)
    sysstats.js          CPU / RAM / GPU sampling for live system monitor
    apps.js / apps.ps1   Per-app RAM list and app closing (RAM panel)
    unity/
      SpriteForgeSceneKit.cs  Unity editor script (shipped in exports)

  nft/
    analyze.js           Ollama-powered trait generation from character descriptions
    cli.js               CLI interface for all NFT operations
    combos.js            Seeded PRNG combination generator, prompt builder
    generate.js          Image generation via ComfyUI/Kontext (sequential, resumable)
    metadata.js          OpenSea/ERC-721 metadata and rarity report generator
    finalize.js          ID renumbering (fills gaps from rejected combos)
    ollama.js            AI descriptions for NFTs via Ollama
    config.json          Collection settings
    traits.json          Trait categories, values, weights, and Kontext prompts

  public/
    index.html           Main page (all views: Animate, Image Studio, Scene Kit, NFT Forge)
    app.js               Core UI logic, SSE event stream, navigation
    scene.js             Scene Kit UI (painter, sprites, export)
    nft.js               NFT Forge UI (trait generation, combos, generation, grid, rarity)
    chroma.js            Chroma key logic (shared with server for consistent preview/export)
    style.css            Full UI styles

  workflows/             Wan 2.2 14B GGUF + Lightning API workflow JSON
  tools/mock_comfy.js    Mock ComfyUI server for testing without a GPU
  data/                  Characters, jobs, frames, models (created on first run)
```

---

## RAM Management

SpriteForge enforces a whole-PC RAM limit (default: 22 GB, set via `SPRITEFORGE_SYSTEM_RAM_GB`).

- `spriteforge_ram_guard` (ComfyUI custom node) measures total system RAM every second and caps ComfyUI's physical RAM to whatever remains under the limit
- If ComfyUI needs more, Windows pages to disk (slower, but doesn't crash)
- If less than 6 GB is left for AI, jobs wait with a message until there's room
- Models are freed after the last queued job, so idle RAM goes back to your apps
- The **RAM** button in the top bar shows per-app RAM usage with close/force-close options

**Measured:** RTX 4050 Laptop (6 GB), 480x832x49 frames: Wan 14B Q3_K_M runs at full speed with ~11 GB for ComfyUI, ~5.7 min per clip.

## Tips for Good Results

### Animation
- Keep video settings consistent across characters (size, length, char height, feet line)
- `480x832` with length `49` is a good balance (length must be 4k+1: 33, 49, 81...)
- If your character has a lot of green, switch screen colour to magenta or blue
- Lower char height (e.g. 0.5) for big moves (jumps, kicks) to avoid clipping
- The 4-step Lightning setup uses CFG 1, so negative prompts have no effect

### NFT Forge
- Start with **Preview (10)** to check quality before generating the full collection
- Use `guidance: 2.5` for natural edits, increase to 4-5 for more dramatic trait changes
- Write specific trait prompts: "Change the background to a fiery volcano with flowing lava" is better than "volcano background"
- Reject and regenerate any images that don't look right — each gets a fresh seed
- Keep image dimensions at 768x768 for consistent results and reasonable generation time

### Scene Kit
- Photos and painted scenes work; flat game art with clear shapes cuts out best
- CPU-based detection (~2s per object on idle PC, slower under RAM pressure)
- The worker process exits after 3 idle minutes to free RAM

## Testing Without a GPU

```bash
npm run mock         # Terminal 1: mock ComfyUI on :8188
npm start            # Terminal 2: SpriteForge on :8000
```

The mock server returns a swayed version of the input image instead of real generation. Useful for testing the UI and pipeline without a GPU.

## License

MIT (SpriteForge code). Model licenses apply to their respective outputs — check FLUX.1 [dev] Non-Commercial License terms before commercial use.
