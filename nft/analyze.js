const fs = require("fs");
const fsp = fs.promises;

const OLLAMA_URL = "http://127.0.0.1:11434";

async function ollamaAvailable() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const data = await r.json();
    return (data.models || []).some(m => m.name.startsWith("qwen2.5"));
  } catch { return false; }
}

async function ollamaGenerate(prompt, opts = {}) {
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:7b", prompt, stream: false,
      options: { temperature: opts.temperature || 0.7, num_predict: opts.maxTokens || 2000 },
      format: "json",
    }),
  });
  if (!r.ok) throw new Error(`Ollama error: ${r.status}`);
  const data = await r.json();
  return JSON.parse(data.response);
}

async function generateTraitsFromDescription(description) {
  const available = await ollamaAvailable();
  if (!available) throw new Error("Ollama is not running or qwen2.5:7b is not installed.");

  const prompt = `You are an NFT collection designer. Given a description of a base character image, generate exactly 5 trait categories with 4-6 values each. The traits must be visual modifications that an AI image editor can apply to the character.

BASE CHARACTER: ${description}

Rules:
1. Each category must be a distinct visual aspect (e.g. Background, Outfit, Headwear, Eyes, Weapon, Skin Color, Aura, Wings, etc.)
2. Choose categories that make sense for THIS specific character
3. Each value needs a "prompt" field — a short, clear instruction for an AI to edit the image (e.g. "Change the background to a fiery volcano landscape")
4. Include a "weight" (1-40) for rarity. Lower weight = rarer. Weights in a category should sum to roughly 100.
5. One value per category can be "None" (meaning keep the original) — give it a moderate weight
6. Make values visually distinctive from each other so each NFT looks unique
7. The prompts should be specific and descriptive enough for an AI image editor

Return ONLY valid JSON in this exact format:
{
  "categories": {
    "Background": [
      {"value": "Cosmic Void", "weight": 25, "prompt": "Change the background to a deep cosmic void with distant stars and purple nebulae"},
      {"value": "Lava Pit", "weight": 15, "prompt": "Change the background to a bubbling lava pit with orange glow and volcanic rocks"}
    ],
    "Outfit": [
      {"value": "Golden Armor", "weight": 10, "prompt": "Dress the character in shining golden plate armor with ornate engravings"},
      {"value": "None", "weight": 30, "prompt": ""}
    ]
  },
  "baseDescription": "one line summary of what the character looks like"
}

Generate 5 categories with 4-6 values each. Be creative but stay visually coherent with the character.`;

  const result = await ollamaGenerate(prompt, { temperature: 0.8, maxTokens: 3000 });

  if (!result.categories || typeof result.categories !== "object") {
    throw new Error("Ollama returned invalid trait structure");
  }

  const cats = result.categories;
  for (const [name, values] of Object.entries(cats)) {
    if (!Array.isArray(values) || values.length < 2) {
      throw new Error(`Category "${name}" needs at least 2 values`);
    }
    for (const v of values) {
      if (!v.value) throw new Error(`Missing value in category "${name}"`);
      v.weight = Math.max(1, Math.min(50, v.weight || 20));
      v.prompt = v.prompt || "";
    }
  }

  return {
    traits: cats,
    baseDescription: result.baseDescription || description,
  };
}

async function saveTraits(traits, traitsPath) {
  await fsp.writeFile(traitsPath, JSON.stringify(traits, null, 2));
}

module.exports = { ollamaAvailable, generateTraitsFromDescription, saveTraits };
