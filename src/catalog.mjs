import path from "node:path";
import { catalogDirs } from "./paths.mjs";
import { listDir, readJson } from "./util.mjs";
import { mergeMeta, thinkingCompat } from "./metadata.mjs";

/**
 * pi 自带一份完整模型目录（@earendil-works/pi-ai/dist/providers/data/*.json）。
 * 我们复用它来给中转站里那些"名字和官方一致"的模型补全元数据：
 * 上下文窗口、最大输出、是否支持推理、输入模态、官方参考价。
 */
export function loadCatalog(agentDir, explicitDir) {
  const dirs = catalogDirs(agentDir, explicitDir);
  const index = new Map();
  const providers = [];

  for (const dir of dirs) {
    for (const file of listDir(dir).filter((f) => f.endsWith(".json") && f !== "index.json")) {
      const providerId = path.basename(file, ".json");
      const data = readJson(path.join(dir, file), null);
      if (!data || typeof data !== "object") continue;
      providers.push(providerId);
      // 目录结构是两层的：{ "<api名>": { "chat:<模型id>": { ...元数据 } } }
      // 兼容处理，万一某天变成平铺也能吃下去。
      const groups = Object.values(data).every((v) => v && typeof v === "object" && !v.id)
        ? Object.values(data)
        : [data];
      for (const group of groups) {
        if (!group || typeof group !== "object") continue;
        for (const [key, value] of Object.entries(group)) {
          if (!value || typeof value !== "object" || !value.id) continue;
          const kind = key.split(":")[0];
          value.type ??= kind;
          // openrouter 的条目 id 带 vendor 前缀，优先级更低，避免抢占精确 id。
          const priority = providerId === "openrouter" ? 1 : 0;
          const existing = index.get(value.id);
          if (!existing || priority < existing.priority) {
            index.set(value.id, { ...value, priority, catalogProvider: providerId });
          }
        }
      }
    }
  }
  return { index, providers, dirs };
}

const VENDOR_PREFIXES = [
  "anthropic/", "openai/", "google/", "deepseek/", "moonshotai/", "moonshot/", "qwen/",
  "z-ai/", "zai/", "x-ai/", "xai/", "meta-llama/", "meta/", "mistralai/", "mistral/",
  "minimax/", "baidu/", "alibaba/", "bytedance/", "tencent/", "01-ai/", "amazon/", "cohere/",
];

function normalizeVariants(rawId) {
  const variants = new Set();
  let id = String(rawId).trim();
  variants.add(id);

  // 去掉 ":free" / ":nitro" 之类的路由后缀
  if (id.includes(":")) variants.add(id.split(":")[0]);

  for (const base of [...variants]) {
    const lower = base.toLowerCase();
    for (const prefix of VENDOR_PREFIXES) {
      if (lower.startsWith(prefix)) variants.add(base.slice(prefix.length));
    }
    variants.add(base.replace(/@.*$/, ""));
    variants.add(base.replace(/[-_.]?(latest|preview|beta|exp|thinking)$/i, ""));
    variants.add(base.replace(/[-_.]?(20\d{2})(-?\d{2}){1,2}$/i, ""));
  }
  return [...variants];
}

function dotVariants(id) {
  const out = new Set([id]);
  out.add(id.replace(/\./g, "-"));
  out.add(id.replace(/\./g, ""));
  out.add(id.replace(/-(\d)-/g, "-$1.")); // claude-sonnet-4-5 -> claude-sonnet-4.5
  return [...out];
}

function scoreCandidate(requested, candidate) {
  const a = requested.toLowerCase();
  const b = candidate.toLowerCase();
  if (a === b) return 1000;
  const prefix = b.startsWith(a) ? a.length : a.startsWith(b) ? b.length : 0;
  if (prefix >= 6) return 500 + prefix;
  const tokensA = new Set(a.split(/[-_.\/]/).filter(Boolean));
  const tokensB = new Set(b.split(/[-_.\/]/).filter(Boolean));
  let overlap = 0;
  for (const t of tokensA) if (tokensB.has(t)) overlap += 1;
  const ratio = overlap / Math.max(tokensA.size, tokensB.size);
  return ratio >= 0.6 ? 200 + Math.round(ratio * 100) : 0;
}

/** 在目录里为某个中转站模型 id 找最贴近的官方条目。 */
export function matchModel(catalog, modelId) {
  if (!catalog.index.size) return null;
  const tried = new Set();
  const attempts = [];
  for (const v of normalizeVariants(modelId)) {
    for (const d of dotVariants(v)) {
      if (!tried.has(d)) {
        tried.add(d);
        attempts.push(d);
      }
    }
  }
  for (const candidate of attempts) {
    const hit = catalog.index.get(candidate);
    if (hit) return { meta: hit, matchedId: candidate, method: candidate === modelId ? "exact" : "normalized" };
  }
  let best = null;
  for (const [id, meta] of catalog.index) {
    if (meta.type !== "chat") continue;
    const score = scoreCandidate(modelId, id);
    if (score && (!best || score > best.score)) best = { score, id, meta };
  }
  return best ? { meta: best.meta, matchedId: best.id, method: "fuzzy" } : null;
}

/** 官方目录里没有的模型（中转站自造名 / 新兴模型），按名字猜一份保守元数据。 */
export function heuristicMeta(modelId) {
  const id = String(modelId).toLowerCase();
  const guess = {
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 32000,
    source: "heuristic",
  };
  const has = (...words) => words.some((w) => id.includes(w));

  if (has("claude", "opus", "sonnet", "haiku")) {
    Object.assign(guess, { contextWindow: 200000, maxTokens: 64000, input: ["text", "image"], family: "claude" });
  } else if (has("gpt-5", "gpt5", "o3", "o4", "codex")) {
    Object.assign(guess, { contextWindow: 400000, maxTokens: 128000, input: ["text", "image"], family: "openai" });
  } else if (has("gpt-4", "gpt4")) {
    Object.assign(guess, { contextWindow: 128000, maxTokens: 16384, input: ["text", "image"], family: "openai" });
  } else if (has("gemini")) {
    Object.assign(guess, { contextWindow: 1000000, maxTokens: 65536, input: ["text", "image"], family: "gemini" });
  } else if (has("deepseek")) {
    Object.assign(guess, { contextWindow: 128000, maxTokens: 64000, family: "deepseek" });
  } else if (has("qwen", "qwq")) {
    Object.assign(guess, { contextWindow: 128000, maxTokens: 32768, family: "qwen" });
  } else if (has("kimi", "moonshot")) {
    Object.assign(guess, { contextWindow: 256000, maxTokens: 32768, family: "kimi" });
  } else if (has("glm", "z-ai", "zhipu")) {
    Object.assign(guess, { contextWindow: 200000, maxTokens: 32768, family: "glm" });
  } else if (has("grok")) {
    Object.assign(guess, { contextWindow: 256000, maxTokens: 32000, input: ["text", "image"], family: "grok" });
  } else if (has("llama", "mistral", "mixtral")) {
    Object.assign(guess, { contextWindow: 128000, maxTokens: 16384, family: "oss" });
  }
  if (has("-mini", "flash", "haiku", "small", "lite", "nano")) guess.maxTokens = Math.min(guess.maxTokens, 32000);
  if (has("coder", "code")) guess.input = ["text"];
  if (has("vl", "vision", "-v", "omni")) guess.input = ["text", "image"];
  return guess;
}

export function titleize(modelId) {
  return String(modelId)
    .split("/")
    .pop()
    .replace(/[-_]/g, " ")
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Gpt|Api|Ai|Vl|Llm)\b/g, (m) => m.toUpperCase())
    .trim();
}

/**
 * 生成写入 models.json 的模型条目。
 * 元数据优先级：中转站 /models > pi 官方目录 > 启发式（见 metadata.mergeMeta）。
 */
export function buildModelEntry(modelId, {
  catalog, providerApi, providerBaseUrl, modelApi, modelBaseUrl,
  costMode, costMultiplier, upstream, ratioCost, supportsReasoningEffort, noReasoningCompat,
  includePromptCache = false,
}) {
  const match = catalog ? matchModel(catalog, modelId) : null;
  const guess = heuristicMeta(modelId);
  const merged = mergeMeta({
    modelId,
    upstream,
    catalogMeta: match?.meta,
    heuristic: guess,
    costMode,
    costMultiplier,
    includePromptCache,
  });
  const entry = { ...merged.meta, id: modelId };

  // 倍率价来自中转站自己的配置，优先级最高（仅在 --ratio 时传入）
  if (ratioCost && costMode !== "off") {
    entry.cost = {
      input: ratioCost.input,
      output: ratioCost.output,
      cacheRead: ratioCost.cacheRead ?? 0,
      cacheWrite: ratioCost.cacheWrite ?? 0,
    };
    merged.sources.cost = "ratio";
  }

  const effectiveApi = modelApi ?? providerApi;
  const compat = noReasoningCompat
    ? null
    : thinkingCompat(modelId, effectiveApi, {
        reasoning: merged.meta.reasoning,
        supportsReasoningEffort,
      });
  if (compat) {
    entry.compat = { ...(entry.compat ?? {}), ...compat.compat };
    entry.thinkingLevelMap = compat.thinkingLevelMap;
  }

  if (modelApi && modelApi !== providerApi) entry.api = modelApi;
  const needsBase = modelApi && modelApi !== providerApi;
  if (needsBase && modelBaseUrl && modelBaseUrl !== providerBaseUrl) entry.baseUrl = modelBaseUrl;

  const sourceLabel =
    merged.sources.cost === "ratio"
      ? "中转站倍率"
      : { upstream: "中转站 /models", catalog: "pi 官方目录", heuristic: "启发式推断" }[merged.primarySource];

  return {
    entry,
    match: match ? { matchedId: match.matchedId, method: match.method } : null,
    source: sourceLabel,
    sources: merged.sources,
    upstreamSource: upstream?.source ?? null,
  };
}
