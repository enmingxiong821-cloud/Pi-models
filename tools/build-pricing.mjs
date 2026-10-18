#!/usr/bin/env node
// 手动生成内置价格快照：默认取 models.dev，可加 --litellm 合并 LiteLLM 数据。
// 只在开发时运行；pmh 运行时不会联网。单位统一为 USD / 百万 token。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const MODELS_DEV = "https://models.dev/api.json";
const LITELLM = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MAX_BYTES = 32 * 1024 * 1024;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const outFile = path.resolve(arg("out", path.join(ROOT, "src", "pricing", "snapshot.json")));
const withLiteLlm = process.argv.includes("--litellm");

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} 返回 ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`${url} 响应过大（${text.length} 字节）`);
  return JSON.parse(text);
}

function clean(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function pack(input, output, cacheRead, cacheWrite) {
  const head = [input, output];
  const tail = [cacheRead ?? 0, cacheWrite ?? 0];
  while (tail.length && tail.at(-1) === 0) tail.pop();
  return [...head, ...tail];
}

const models = new Map();
const dev = await fetchJson(MODELS_DEV);
for (const [providerId, provider] of Object.entries(dev)) {
  const providerName = String(providerId).trim().toLowerCase();
  for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
    const cost = model?.cost;
    if (!cost) continue;
    const input = clean(cost.input);
    const output = clean(cost.output);
    if (input === null || output === null) continue;
    const key = `${providerName}/${String(modelId).trim().toLowerCase()}`;
    if (!models.has(key)) {
      models.set(key, pack(input, output, clean(cost.cache_read), clean(cost.cache_write)));
    }
  }
}
const devCount = models.size;

let liteCount = 0;
if (withLiteLlm) {
  const litellm = await fetchJson(LITELLM);
  for (const [rawKey, row] of Object.entries(litellm)) {
    if (!row || typeof row !== "object") continue;
    const input = clean(row.input_cost_per_token);
    const output = clean(row.output_cost_per_token);
    if (input === null || output === null) continue;
    const cacheRead = clean(row.cache_read_input_token_cost);
    const cacheWrite = clean(row.cache_creation_input_token_cost);
    const key = String(rawKey).trim().toLowerCase();
    if (!key || models.has(key)) continue;
    models.set(key, pack(
      input * 1_000_000,
      output * 1_000_000,
      cacheRead === null ? null : cacheRead * 1_000_000,
      cacheWrite === null ? null : cacheWrite * 1_000_000,
    ));
    liteCount += 1;
  }
}

const sorted = {};
for (const key of [...models.keys()].sort()) sorted[key] = models.get(key);
const snapshot = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: withLiteLlm ? "models.dev+litellm" : "models.dev",
  models: sorted,
};
const text = `${JSON.stringify(snapshot)}\n`;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, text);
console.log(`写入 ${outFile}`);
console.log(`模型 ${models.size} 个（models.dev ${devCount}${withLiteLlm ? `，LiteLLM 新增 ${liteCount}` : ""}），${(text.length / 1024).toFixed(0)} KB`);
