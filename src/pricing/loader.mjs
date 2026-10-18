// 内置价格快照：运行时只读本地 JSON，不联网。单位 USD / 百万 token。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SNAPSHOT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "snapshot.json");

/** 常见站点别名 → models.dev 的 provider id。 */
export const PROVIDER_ALIASES = {
  anthropic: "anthropic",
  claude: "anthropic",
  openai: "openai",
  azure: "azure",
  "azure-openai": "azure",
  google: "google",
  gemini: "google",
  "google-ai": "google",
  vertex: "google-vertex",
  "google-vertex": "google-vertex",
  xai: "xai",
  grok: "xai",
  deepseek: "deepseek",
  mistral: "mistral",
  moonshot: "moonshotai",
  moonshotai: "moonshotai",
  kimi: "moonshotai",
  qwen: "alibaba",
  dashscope: "alibaba",
  alibaba: "alibaba",
  zhipu: "zai",
  glm: "zai",
  zai: "zai",
  openrouter: "openrouter",
  groq: "groq",
  cerebras: "cerebras",
  perplexity: "perplexity",
  cohere: "cohere",
  together: "togetherai",
  togetherai: "togetherai",
  firework: "fireworks-ai",
  fireworks: "fireworks-ai",
  minimax: "minimax",
};

const PRIMARY_PROVIDERS = [
  "openai", "anthropic", "google", "google-vertex", "xai", "deepseek", "mistral",
  "alibaba", "moonshotai", "zai", "meta", "cohere", "amazon-bedrock", "azure", "openrouter",
];

let cache = null;

export function resetPricingCache() {
  cache = null;
}

export function loadPricing() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch {
    raw = null;
  }
  const exact = new Map();
  const flat = new Map();
  for (const [key, value] of Object.entries(raw?.models ?? {})) {
    const price = toPrice(value);
    if (!price) continue;
    const lower = key.toLowerCase();
    exact.set(lower, price);
    const slash = lower.indexOf("/");
    if (slash < 0) continue;
    const provider = lower.slice(0, slash);
    const model = lower.slice(slash + 1);
    const previous = flat.get(model);
    if (!previous || rank(provider) < rank(previous.provider)) {
      flat.set(model, { provider, price });
    }
  }
  cache = {
    version: Number(raw?.version) || 0,
    generatedAt: raw?.generatedAt ?? null,
    source: raw?.source ?? null,
    exact,
    flat,
  };
  return cache;
}

function toPrice(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const input = Number(value[0]);
  const output = Number(value[1]);
  const cacheRead = Number(value[2] ?? 0);
  const cacheWrite = Number(value[3] ?? 0);
  if (![input, output, cacheRead, cacheWrite].every(Number.isFinite)) return null;
  return { input, output, cacheRead, cacheWrite };
}

function rank(provider) {
  const index = PRIMARY_PROVIDERS.indexOf(provider);
  return index < 0 ? PRIMARY_PROVIDERS.length : index;
}

function normalizeProvider(provider) {
  const id = String(provider ?? "").trim().toLowerCase();
  return PROVIDER_ALIASES[id] ?? id;
}

/** 去掉日期后缀 / 站点前缀 / 常见的 latest 标记，便于匹配同一模型的不同命名。 */
export function normalizeModelId(model) {
  return String(model ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9._-]+\//, "")
    .replace(/[-_](\d{4}-\d{2}-\d{2}|\d{8})$/, "")
    .replace(/[-_:]latest$/, "")
    .replace(/:free$/, "");
}

/** 返回 {input, output, cacheRead, cacheWrite, source:"snapshot"} 或 null。 */
export function lookupPrice(provider, model) {
  const pricing = loadPricing();
  const providerId = normalizeProvider(provider);
  const modelId = String(model ?? "").trim().toLowerCase();
  if (!modelId) return null;

  const direct = [
    `${providerId}/${modelId}`,
    `${providerId}/${normalizeModelId(modelId)}`,
    `${String(provider ?? "").trim().toLowerCase()}/${modelId}`,
  ];
  for (const key of direct) {
    const price = pricing.exact.get(key);
    if (price) return { ...price, source: "snapshot" };
  }

  // 模型名里自带 provider 前缀时，按前缀再试一次。
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const prefixed = `${normalizeProvider(modelId.slice(0, slash))}/${modelId.slice(slash + 1)}`;
    const price = pricing.exact.get(prefixed);
    if (price) return { ...price, source: "snapshot" };
  }

  for (const candidate of [modelId, normalizeModelId(modelId)]) {
    const hit = pricing.flat.get(candidate);
    if (hit) return { ...hit.price, source: "snapshot" };
  }
  return null;
}

/** 按四类 token 计算费用；价格缺失的字段按 0 计。 */
export function computeCost(tokens, price) {
  if (!price) return null;
  const count = (value) => Number(value) || 0;
  return (
    (count(tokens?.input) * price.input
      + count(tokens?.output) * price.output
      + count(tokens?.cacheRead) * price.cacheRead
      + count(tokens?.cacheWrite) * price.cacheWrite) / 1_000_000
  );
}
