// 上游元数据适配：不同网关的 /models 返回形状差别很大（OpenRouter / LiteLLM /
// NewAPI / Anthropic / 通用），这里统一抽成 pi 需要的字段，并做合理性校验。
// 原则：宁可缺字段回退，也不把明显不合理的值写进配置。

const CONTEXT_MIN = 1024;
const CONTEXT_MAX = 10_000_000;
const MAX_OUTPUT_LIMIT = 16_000_000;
const COST_MAX = 10_000; // USD / 百万 token

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstNum(...values) {
  for (const v of values) {
    const n = num(v);
    if (n !== null) return n;
  }
  return null;
}

function firstStr(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function saneContext(v) {
  const n = num(v);
  if (n === null || n < CONTEXT_MIN || n > CONTEXT_MAX) return null;
  return Math.round(n);
}

function saneMaxTokens(v, contextWindow) {
  const n = num(v);
  if (n === null || n < 1 || n > MAX_OUTPUT_LIMIT) return null;
  const rounded = Math.round(n);
  return contextWindow ? Math.min(rounded, contextWindow) : rounded;
}

function saneCost(v) {
  const n = num(v);
  if (n === null || n < 0 || n > COST_MAX) return null;
  return +n.toFixed(6);
}

function normalizeInput(list) {
  if (!Array.isArray(list)) return null;
  const allowed = new Set(["text", "image"]);
  const out = list.map((x) => String(x).toLowerCase()).filter((x) => allowed.has(x));
  const unique = [...new Set(out)];
  if (!unique.includes("text")) unique.unshift("text");
  return unique;
}

/** per_token 的值 ×1e6 转成 pi 的"每百万 token"；per_million 原样。 */
export function toPerMillion(value, unit) {
  const n = num(value);
  if (n === null) return null;
  const scaled = unit === "per_token" ? n * 1e6 : n;
  return saneCost(scaled);
}

function supportedParams(...sources) {
  for (const s of sources) {
    if (Array.isArray(s)) return s.map((x) => String(x).toLowerCase());
  }
  return [];
}

/**
 * 从一个 /models 条目里抽取元数据。返回 null 表示没有任何可用字段。
 * fields 记录哪些字段来自上游，便于 --verbose 展示与合并。
 */
export function extractUpstreamMeta(item) {
  if (!isObj(item)) return null;
  const info = isObj(item.model_info) ? item.model_info : {};
  const arch = isObj(item.architecture) ? item.architecture : {};
  const pricing = isObj(item.pricing) ? item.pricing : {};
  const caps = isObj(item.capabilities) ? item.capabilities : {};

  const fields = [];
  const out = {
    source: "generic",
    name: null,
    reasoning: null,
    supportsReasoningEffort: false,
    input: null,
    contextWindow: null,
    maxTokens: null,
    cost: null,
  };

  // 显示名
  const name = firstStr(item.display_name, item.name, info.name);
  if (name) {
    out.name = name.replace(/\s+/g, " ");
    fields.push("name");
  }

  // 上下文与最大输出
  const contextWindow = saneContext(
    firstNum(
      item.context_length,
      item.context_window,
      item.max_context_length,
      item.max_input_tokens,
      info.context_length,
      info.context_window,
      info.max_input_tokens,
      arch.context_length,
    ),
  );
  if (contextWindow) {
    out.contextWindow = contextWindow;
    fields.push("contextWindow");
  }
  const maxTokens = saneMaxTokens(
    firstNum(
      item.max_tokens,
      item.max_output_tokens,
      item.max_completion_tokens,
      info.max_tokens,
      info.max_output_tokens,
      info.max_completion_tokens,
    ),
    contextWindow ?? saneContext(item.context_window) ?? undefined,
  );
  if (maxTokens) {
    out.maxTokens = maxTokens;
    fields.push("maxTokens");
  }

  // 输入模态
  const declaredInput = normalizeInput(
    arch.input_modalities ?? item.input_modalities ?? info.input_modalities ?? (Array.isArray(item.modalities?.input) ? item.modalities.input : null),
  );
  const vision = item.supports_vision ?? info.supports_vision ?? caps.vision ?? caps.image_input;
  if (declaredInput) {
    out.input = declaredInput;
    fields.push("input");
  } else if (vision === true) {
    out.input = ["text", "image"];
    fields.push("input");
  }

  // 推理能力与 reasoning_effort 支持
  const params = supportedParams(item.supported_parameters, info.supported_parameters, arch.supported_parameters);
  const declaredReasoning = item.supports_reasoning ?? info.supports_reasoning ?? caps.reasoning ?? caps.thinking;
  if (typeof declaredReasoning === "boolean") {
    out.reasoning = declaredReasoning;
    fields.push("reasoning");
  } else if (typeof item.reasoning === "boolean") {
    out.reasoning = item.reasoning;
    fields.push("reasoning");
  } else if (params.includes("reasoning") || params.includes("reasoning_effort") || params.includes("thinking")) {
    out.reasoning = true;
    fields.push("reasoning");
  } else if (params.length) {
    out.reasoning = false;
    fields.push("reasoning");
  }
  out.supportsReasoningEffort =
    item.supports_reasoning_effort === true ||
    info.supports_reasoning_effort === true ||
    params.includes("reasoning_effort");

  // 价格：全部换算成 USD / 百万 token
  const inputCost = firstNum(
    toPerMillion(pricing.prompt, "per_token"),
    toPerMillion(pricing.input, "per_token"),
    toPerMillion(info.input_cost_per_token, "per_token"),
    toPerMillion(item.input_cost_per_token, "per_token"),
    toPerMillion(item.input_price_per_million, "per_million"),
    toPerMillion(item.input_cost_per_million, "per_million"),
    toPerMillion(item.prompt_price_per_million, "per_million"),
    toPerMillion(item.cost?.input, "per_million"),
  );
  const outputCost = firstNum(
    toPerMillion(pricing.completion, "per_token"),
    toPerMillion(pricing.output, "per_token"),
    toPerMillion(info.output_cost_per_token, "per_token"),
    toPerMillion(item.output_cost_per_token, "per_token"),
    toPerMillion(item.output_price_per_million, "per_million"),
    toPerMillion(item.output_cost_per_million, "per_million"),
    toPerMillion(item.completion_price_per_million, "per_million"),
    toPerMillion(item.cost?.output, "per_million"),
  );
  if (inputCost !== null && outputCost !== null) {
    out.cost = {
      input: inputCost,
      output: outputCost,
      cacheRead:
        firstNum(
          toPerMillion(pricing.input_cache_read, "per_token"),
          toPerMillion(info.cache_read_input_token_cost, "per_token"),
          toPerMillion(item.cache_read_price_per_million, "per_million"),
          toPerMillion(item.cost?.cacheRead, "per_million"),
        ) ?? 0,
      cacheWrite:
        firstNum(
          toPerMillion(pricing.input_cache_write, "per_token"),
          toPerMillion(info.cache_creation_input_token_cost, "per_token"),
          toPerMillion(item.cache_write_price_per_million, "per_million"),
          toPerMillion(item.cost?.cacheWrite, "per_million"),
        ) ?? 0,
    };
    fields.push("cost");
  }

  if (!fields.length) return null;
  if (isObj(item.model_info)) out.source = "litellm";
  else if (isObj(item.architecture) || isObj(item.pricing)) out.source = "openrouter";
  else if (isObj(item.capabilities) || typeof item.supports_reasoning === "boolean" || num(item.model_ratio) !== null) out.source = "newapi";
  else if (typeof item.display_name === "string" && item.type === "model") out.source = "anthropic";
  return out;
}

/** 价格策略：off 不写价；scaled 按倍率折算；ratio 由调用方另行计算。 */
export function scaleCost(cost, costMode, costMultiplier = 1) {
  if (!cost || costMode === "off") return null;
  const raw = Number(costMode === "scaled" ? costMultiplier : 1);
  const k = Number.isFinite(raw) && raw > 0 ? raw : 1; // 负数/0 倍率会把价格算成负值
  const out = {
    input: +(cost.input * k).toFixed(6),
    output: +(cost.output * k).toFixed(6),
    cacheRead: +((cost.cacheRead ?? 0) * k).toFixed(6),
    cacheWrite: +((cost.cacheWrite ?? 0) * k).toFixed(6),
  };
  return Object.values(out).every((v) => v <= COST_MAX) ? out : null;
}

/**
 * 合并元数据：上游 > pi 官方目录 > 启发式。
 * 返回的 sources 记录每个字段最终来自哪里。
 */
export function mergeMeta({ modelId, upstream, catalogMeta, heuristic, costMode = "official", costMultiplier = 1, includePromptCache = false }) {
  const sources = {};
  const pick = (field, upValue, catValue, heurValue) => {
    if (upValue !== null && upValue !== undefined) {
      sources[field] = "upstream";
      return upValue;
    }
    if (catValue !== null && catValue !== undefined) {
      sources[field] = "catalog";
      return catValue;
    }
    sources[field] = "heuristic";
    return heurValue;
  };

  const contextWindow = pick("contextWindow", upstream?.contextWindow ?? null, catalogMeta?.contextWindow ?? null, heuristic.contextWindow);
  const reasoning = pick("reasoning", upstream?.reasoning ?? null, catalogMeta?.reasoning ?? null, heuristic.reasoning);
  const input = pick("input", upstream?.input ?? null, catalogMeta?.input ?? null, heuristic.input);
  let maxTokens = pick("maxTokens", upstream?.maxTokens ?? null, catalogMeta?.maxTokens ?? null, heuristic.maxTokens);
  maxTokens = saneMaxTokens(maxTokens, contextWindow) ?? heuristic.maxTokens;

  const name = firstStr(upstream?.name, catalogMeta?.name) ?? String(modelId);

  let cost = null;
  if (costMode !== "off") {
    if (upstream?.cost) {
      cost = scaleCost(upstream.cost, costMode, costMultiplier);
      if (cost) sources.cost = "upstream";
    }
    if (!cost && catalogMeta?.cost) {
      cost = scaleCost(catalogMeta.cost, costMode, costMultiplier);
      if (cost) sources.cost = "catalog";
    }
  }

  const meta = { id: modelId, name, reasoning, input, contextWindow, maxTokens };
  if (cost) meta.cost = cost;
  // 缓存策略只在用户显式要求时透传，避免改变既有配置的默认形态
  if (includePromptCache && catalogMeta?.promptCache && typeof catalogMeta.promptCache === "object") {
    meta.promptCache = { ...catalogMeta.promptCache };
    sources.promptCache = "catalog";
  }

  const used = new Set(Object.values(sources));
  const primarySource = used.has("upstream") ? "upstream" : used.has("catalog") ? "catalog" : "heuristic";
  return { meta, sources, primarySource };
}

const OPENAI_REASONING_FAMILY = /(^|[-_/])(gpt-5|gpt5|o1|o3|o4|codex)([-_.]|\d|$)/i;

/**
 * 只在有把握时打开 reasoning_effort：
 *  - OpenAI 协议；
 *  - 模型判定为推理模型；
 *  - 上游明确声明支持 reasoning_effort，或属于 OpenAI 推理家族；
 *  - 用户没关掉。
 */
export function thinkingCompat(modelId, api, { reasoning, supportsReasoningEffort } = {}) {
  if (!reasoning) return null;
  if (!String(api ?? "").startsWith("openai")) return null;
  if (!supportsReasoningEffort && !OPENAI_REASONING_FAMILY.test(String(modelId))) return null;
  return {
    compat: { supportsReasoningEffort: true },
    thinkingLevelMap: {
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "high",
    },
  };
}

/**
 * NewAPI / one-api 倍率换算（opt-in）。
 *   input  USD/M = model_ratio × 2 × group_ratio
 *   output USD/M = model_ratio × completion_ratio × 2 × group_ratio
 * 字段不全或值不合理时返回 null（不猜）。
 */
export function ratioCosts(modelId, ratioConfig) {
  const data = ratioConfig?.data ?? ratioConfig;
  if (!isObj(data)) return null;
  const modelRatio = isObj(data.model_ratio) ? findRatioKey(data.model_ratio, modelId) : null;
  const ratio = num(modelRatio);
  if (ratio === null || ratio < 0) return null;

  let groupRatio = 1;
  if (isObj(data.group_ratio)) {
    const g = firstNum(data.group_ratio.default, ...Object.values(data.group_ratio));
    if (g !== null && g > 0) groupRatio = g;
  } else {
    const g = firstNum(data.group_ratio);
    if (g !== null && g > 0) groupRatio = g;
  }

  // completion_ratio 既可能是按模型查的表，也可能是一个数字（部分网关只给一个全局值）
  const completionRaw = isObj(data.completion_ratio)
    ? num(findRatioKey(data.completion_ratio, modelId))
    : num(data.completion_ratio);
  const completion = completionRaw !== null && completionRaw > 0 ? completionRaw : 1;
  const input = saneCost(ratio * 2 * groupRatio);
  const output = saneCost(ratio * (completion ?? 1) * 2 * groupRatio);
  if (input === null || output === null) return null;
  return { input, output, cacheRead: 0, cacheWrite: 0, estimated: true, groupRatio };
}

function findRatioKey(table, modelId) {
  if (Object.prototype.hasOwnProperty.call(table, modelId)) return table[modelId];
  const lower = String(modelId).toLowerCase();
  for (const [k, v] of Object.entries(table)) {
    if (k.toLowerCase() === lower) return v;
  }
  // 网关常把 vendor 前缀去掉，再做一次宽松匹配
  const hit = matchModelBySuffix(table, modelId);
  return hit;
}

function matchModelBySuffix(table, modelId) {
  const target = String(modelId).toLowerCase();
  for (const [k, v] of Object.entries(table)) {
    const key = k.toLowerCase();
    if (target.endsWith(`/${key}`) || target === key || target.replace(/^[^/]+\//, "") === key) return v;
  }
  return null;
}
