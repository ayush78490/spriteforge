const fs = require("fs");
const fsp = fs.promises;

const OLLAMA_URL = "http://127.0.0.1:11434";

async function isAvailable() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const data = await r.json();
    return (data.models || []).some(m => m.name.startsWith("qwen2.5"));
  } catch { return false; }
}

async function generateDescription(traits) {
  const prompt = `Write a short, creative, unique description (2-3 sentences max) for an NFT character with these traits:
- Background: ${traits.Background}
- Outfit: ${traits.Outfit}
- Headwear: ${traits.Headwear || "None"}
- Expression: ${traits.Expression}
- Accessory: ${traits.Accessory || "None"}

Write ONLY the description, no labels or prefixes. Make it sound like a collector's item.`;

  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen2.5:7b", prompt, stream: false, options: { temperature: 0.8, num_predict: 120 } }),
  });
  if (!r.ok) throw new Error(`Ollama error: ${r.status}`);
  const data = await r.json();
  return (data.response || "").trim();
}

async function addDescriptions({ combosPath, onProgress }) {
  const combos = JSON.parse(await fsp.readFile(combosPath, "utf8"));
  const available = await isAvailable();
  if (!available) throw new Error("Ollama is not running or qwen2.5:7b is not installed. Start Ollama and pull the model first.");

  for (let i = 0; i < combos.length; i++) {
    try {
      combos[i].description = await generateDescription(combos[i].traits);
      if (onProgress) onProgress({ current: i + 1, total: combos.length, id: combos[i].id });
    } catch (e) {
      combos[i].description = null;
      if (onProgress) onProgress({ current: i + 1, total: combos.length, id: combos[i].id, error: e.message });
    }
  }

  await fsp.writeFile(combosPath, JSON.stringify(combos, null, 2));
  return { total: combos.length, described: combos.filter(c => c.description).length };
}

module.exports = { isAvailable, generateDescription, addDescriptions };
