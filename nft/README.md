# NFT Collection Generator

Generate a collection of unique NFT images from one base character using FLUX Kontext (via ComfyUI), with OpenSea-compatible metadata.

## Setup

1. **ComfyUI** must be running (`start-spriteforge.bat` or however you launch it).
2. The SpriteForge server must be running (`npm start` from the project root).
3. Edit `nft/traits.json` to define your trait categories, values, weights and prompt phrases.
4. Edit `nft/config.json` for collection name, description, royalty settings and image parameters.

## Using the UI

1. Open `http://localhost:8000` and click the **NFT Forge** tab.
2. Upload your base character image.
3. Set count and seed, then click **Generate combinations**.
4. Click **Preview (10)** to generate the first 10 images and check quality.
5. Click **Generate all** to run the full collection (resumable — stop and restart anytime).
6. Reject bad images by clicking the X on their card, then generate again to redo them.
7. Click **Generate metadata** to create OpenSea-compatible JSON files.
8. Click **Finalize IDs** to renumber everything continuously.
9. Upload images to IPFS, paste the CID, click **Update metadata CID**.

## CLI Commands

All commands run from the project root.

### Generate combinations
```
node nft/cli.js combos --count 100 --seed 42
```

### Preview (first 10 only)
```
node nft/cli.js preview --base ./base.png
```

### Generate all images (resumable)
```
node nft/cli.js generate --base ./base.png
```

### Reject and regenerate
```
node nft/cli.js reject --ids 5,12,37 --base ./base.png
```

### Generate metadata
```
node nft/cli.js metadata
```

### Set IPFS CID
```
node nft/cli.js set-cid --cid QmYourCIDHere
```

### Finalize (renumber IDs)
```
node nft/cli.js finalize
```

### Rarity report
```
node nft/cli.js rarity
```

### AI descriptions (optional, requires Ollama)
```
node nft/cli.js describe
```

## Uploading to IPFS (Pinata)

1. Create a free account at [pinata.cloud](https://pinata.cloud).
2. Upload the `nft/output/images/` folder. Copy the resulting CID.
3. Run `node nft/cli.js set-cid --cid QmYourCIDHere` (or use the UI).
4. Upload the `nft/output/metadata/` folder to get the metadata CID.

## Creating the collection on OpenSea

1. Go to [opensea.io](https://opensea.io) and connect your wallet.
2. Create a new collection. Set the metadata base URI to `ipfs://YOUR_METADATA_CID/`.
3. Deploy your smart contract (ERC-721) pointing to the metadata URI.
4. The `collection.json` file in `nft/output/` has collection-level metadata.

## Output structure

```
nft/output/
  combos.json          # All combinations with traits, prompts, seeds
  base.png             # The uploaded base character
  images/              # Generated NFT images (1.png, 2.png, ...)
  metadata/            # OpenSea metadata (1, 1.json, 2, 2.json, ...)
  collection.json      # Collection-level metadata
  rarity.json          # Trait rarity breakdown
  errors.log           # Generation errors
```
