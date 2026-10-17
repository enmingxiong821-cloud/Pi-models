// pi 原生 models.json 的辅助逻辑：本机推理服务预设、内置 provider 索引、配置校验。
// 这里不读写密钥，也不发网络请求。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPiInstall } from "./paths.mjs";
import { listDir } from "./util.mjs";

/** 本机推理服务的默认端点；root 不带 /v1，和 pmh add 的 --base 语义一致。 */
export const LOCAL_PRESETS = {
  ollama: {
    id: "ollama",
    title: "Ollama",
    root: "http://127.0.0.1:11434",
    key: "ollama",
    hint: "先运行 ollama serve，并用 ollama pull <模型> 拉一个模型",
  },
  lmstudio: {
    id: "lmstudio",
    title: "LM Studio",
    root: "http://127.0.0.1:1234",
    key: "lmstudio",
    hint: "在 LM Studio 的 Developer 页启动 Local Server",
  },
  vllm: {
    id: "vllm",
    title: "vLLM",
    root: "http://127.0.0.1:8000",
    key: "vllm",
    hint: "确认 vLLM 以 OpenAI 兼容模式启动（--served-model-name）",
  },
  sglang: {
    id: "sglang",
    title: "SGLang",
    root: "http://127.0.0.1:30000",
    key: "sglang",
    hint: "确认 SGLang 的 OpenAI 兼容端点已启动",
  },
  "llama-cpp": {
    id: "llama-cpp",
    title: "llama.cpp",
    root: "http://127.0.0.1:8080",
    key: "llama-cpp",
    hint: "运行 llama-server 时会自动启动 OpenAI 兼容端点",
  },
};

const LOCAL_ALIASES = {
  ollama: "ollama",
  lmstudio: "lmstudio",
  "lm-studio": "lmstudio",
  lm_studio: "lmstudio",
  vllm: "vllm",
  sglang: "sglang",
  llamacpp: "llama-cpp",
  "llama-cpp": "llama-cpp",
  "llama.cpp": "llama-cpp",
  "llama-server": "llama-cpp",
};

export function listLocalPresets() {
  return Object.values(LOCAL_PRESETS);
}

/** 解析本机预设，支持 --port 覆盖端口、--base 覆盖整个地址。 */
export function resolveLocalPreset(name, { port, base } = {}) {
  const raw = String(name ?? "").trim();
  if (!raw) throw new Error(`缺少本机服务名（可选：${[...new Set(Object.values(LOCAL_ALIASES))].join(" / ")}）`);
  const id = LOCAL_ALIASES[raw.toLowerCase().replace(/\s+/g, "")];
  if (!id) throw new Error(`不认识的本机服务 "${raw}"（可选：ollama / lmstudio / vllm / sglang / llama-cpp）`);
  const preset = LOCAL_PRESETS[id];
  let root = base ? String(base) : preset.root;
  if (port !== undefined && port !== true) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port 需要 1-65535 的整数，收到：${port}`);
    const url = new URL(root);
    url.port = String(n);
    root = url.toString().replace(/\/+$/, "");
  }
  return { ...preset, root };
}

/** 把 "200k" / "1m" / "128000" 这类写法转成正整数。 */
export function parseCount(raw, label = "数值") {
  const text = String(raw ?? "").trim().toLowerCase().replace(/[_,]/g, "");
  const match = /^(\d+(?:\.\d+)?)\s*([kmg])?$/.exec(text);
  if (!match) throw new Error(`${label} 需要数字（可带 k/m），收到：${raw}`);
  const scale = { k: 1e3, m: 1e6, g: 1e9 }[match[2]] ?? 1;
  const value = Math.round(Number(match[1]) * scale);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} 必须大于 0，收到：${raw}`);
  return value;
}

/** 价格单位是 USD / 百万 token；允许 0，不允许负数。 */
export function parseCost(raw, label = "价格") {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} 需要非负数字，收到：${raw}`);
  return +value.toFixed(6);
}

const API_BY_CALL = {
  openAICompletionsApi: "openai-completions",
  openAIResponsesApi: "openai-responses",
  anthropicMessagesApi: "anthropic-messages",
  googleGenerativeAIApi: "google-generative-ai",
  azureOpenAIResponsesApi: "azure-openai-responses",
  openrouterImagesApi: "openrouter-images",
};

/**
 * 从 pi 安装目录里读内置 provider 的 id / baseUrl / 默认 api。
 * 只做静态解析，不 import pi-ai（避免把整棵依赖树带进 CLI），解析失败就当作未知。
 */
export function loadBuiltinProviders(agentDir, { providersDir } = {}) {
  let dir = providersDir;
  if (!dir) {
    // 与 catalogDirs 一致：--agent-dir 指向测试/多份配置时，仍去默认位置找一次 pi 安装。
    const candidates = [...new Set([agentDir, path.join(os.homedir(), ".pi", "agent")].filter(Boolean))];
    for (const candidate of candidates) {
      const install = findPiInstall(candidate);
      if (!install.root) continue;
      const candidateDir = path.join(install.root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers");
      if (fs.existsSync(candidateDir)) {
        dir = candidateDir;
        break;
      }
    }
    if (!dir) return { providers: new Map(), dir: null };
  }
  const providers = new Map();
  for (const file of listDir(dir)) {
    if (!file.endsWith(".js") || file.endsWith(".models.js")) continue;
    if (file === "all.js" || file === "index.js") continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const idMatch = /\bid:\s*"([^"]+)"/.exec(text);
    if (!idMatch) continue;
    const tail = text.slice(idMatch.index);
    const name = /\bname:\s*"([^"]+)"/.exec(tail)?.[1] ?? idMatch[1];
    const baseUrl = /\b(?:baseUrl|[A-Z0-9_]*BASE_URL)\s*[:=]\s*"([^"]+)"/.exec(text)?.[1] ?? null;
    const apiCall = /\bapi:\s*([A-Za-z0-9_]+)\(/.exec(tail)?.[1] ?? null;
    providers.set(idMatch[1], { id: idMatch[1], name, baseUrl, api: API_BY_CALL[apiCall] ?? null, file });
  }
  return { providers, dir };
}

const PROVIDER_FIELDS = new Set([
  "name", "baseUrl", "apiKey", "api", "oauth", "headers", "compat", "authHeader", "models", "modelOverrides",
]);
const MODEL_FIELDS = new Set([
  "id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "inputLimits", "cost",
  "promptCache", "contextWindow", "maxTokens", "samplingParams", "samplingParamsByThinkingLevel",
  "headers", "compat",
]);
const OVERRIDE_FIELDS = new Set([
  "name", "reasoning", "thinkingLevelMap", "input", "inputLimits", "cost", "promptCache",
  "contextWindow", "maxTokens", "samplingParams", "samplingParamsByThinkingLevel", "compat",
]);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** pi 对 provider 配置的最低要求：至少有一项能落地。 */
export function providerHasContent(config) {
  if (!isObj(config)) return false;
  const overrides = isObj(config.modelOverrides) && Object.keys(config.modelOverrides).length > 0;
  return Boolean(
    (Array.isArray(config.models) && config.models.length > 0) ||
    config.baseUrl || config.headers || config.compat || overrides ||
    config.apiKey || config.oauth || config.authHeader !== undefined,
  );
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function credentialProblem(providerId, config, auth) {
  const stored = auth?.[providerId];
  if (isObj(stored) && (stored.key || stored.type === "oauth" || stored.access)) return null;
  if (isObj(config) && config.oauth) return null;
  const raw = config?.apiKey;
  if (typeof raw === "string" && raw.trim()) {
    const env = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw.trim());
    if (env && !process.env[env[1]]) return `apiKey 引用环境变量 ${env[1]}，但它当前未设置`;
    return null;
  }
  return "没有可解析的凭据（auth.json 无记录、models.json 无 apiKey），pi 会隐藏这个 provider 的模型";
}

/**
 * 校验 models.json 里 pi 会读取的部分。返回 { errors, warnings }，每条带 path。
 * 目的：把 pi 会静默忽略/启动时报错的配置提前说清楚。
 */
export function validateModelsConfig({ models, auth = {}, settings = {}, builtins = new Map() } = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });
  const providers = models?.providers;
  if (!isObj(providers)) {
    err("providers", "缺少 providers 对象");
    return { errors, warnings };
  }

  for (const [id, config] of Object.entries(providers)) {
    const at = `providers.${id}`;
    const builtin = builtins.get?.(id) ?? null;
    if (!isObj(config)) {
      err(at, "provider 配置必须是对象");
      continue;
    }
    for (const key of Object.keys(config)) {
      if (!PROVIDER_FIELDS.has(key)) warn(`${at}.${key}`, "pi 不认识这个字段，会被忽略");
    }
    if (!providerHasContent(config)) {
      err(at, "空 provider：至少要有 baseUrl / models / modelOverrides / apiKey / headers / compat 之一");
      continue;
    }
    if (config.baseUrl !== undefined && !isHttpUrl(config.baseUrl)) {
      err(`${at}.baseUrl`, `不是合法的 http(s) 地址：${config.baseUrl}`);
    }
    if (config.api !== undefined && (typeof config.api !== "string" || !config.api.trim())) {
      err(`${at}.api`, "api 必须是非空字符串");
    }
    if (config.models !== undefined && !Array.isArray(config.models)) {
      err(`${at}.models`, "models 必须是数组");
    }
    const modelIds = new Set();
    for (const [index, model] of (Array.isArray(config.models) ? config.models : []).entries()) {
      const mp = `${at}.models[${index}]`;
      if (!isObj(model)) { err(mp, "模型条目必须是对象"); continue; }
      if (typeof model.id !== "string" || !model.id.trim()) {
        err(`${mp}.id`, "模型必须有非空 id");
      } else if (modelIds.has(model.id)) {
        err(`${mp}.id`, `模型 id 重复：${model.id}（后一条会覆盖前一条）`);
      } else {
        modelIds.add(model.id);
      }
      for (const key of Object.keys(model)) {
        if (!MODEL_FIELDS.has(key)) warn(`${mp}.${key}`, "pi 不认识这个字段，会被忽略");
      }
      if (model.baseUrl !== undefined && !isHttpUrl(model.baseUrl)) {
        err(`${mp}.baseUrl`, `不是合法的 http(s) 地址：${model.baseUrl}`);
      }
      for (const field of ["contextWindow", "maxTokens"]) {
        if (model[field] !== undefined && (!Number.isFinite(model[field]) || model[field] <= 0)) {
          err(`${mp}.${field}`, "必须大于 0");
        }
      }
      if (model.input !== undefined) {
        if (!Array.isArray(model.input) || model.input.some((x) => !["text", "image"].includes(x))) {
          warn(`${mp}.input`, 'input 只认 "text" / "image"');
        }
      }
      if (model.cost !== undefined) {
        if (!isObj(model.cost)) {
          err(`${mp}.cost`, "cost 必须是对象");
        } else {
          for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
            if (!Number.isFinite(model.cost[key]) || model.cost[key] < 0) {
              warn(`${mp}.cost.${key}`, "价格应为非负数字（USD / 百万 token）");
            }
          }
        }
      }
      if (!model.api && !config.api && !builtin) {
        err(`${mp}.api`, "自定义 provider 的模型必须有 api（provider 级或模型级）");
      }
      if (!model.baseUrl && !config.baseUrl && !builtin) {
        err(`${mp}.baseUrl`, "自定义 provider 的模型必须有 baseUrl（provider 级或模型级）");
      }
    }
    if (config.modelOverrides !== undefined && !isObj(config.modelOverrides)) {
      err(`${at}.modelOverrides`, "modelOverrides 必须是对象");
    }
    for (const [modelId, override] of Object.entries(isObj(config.modelOverrides) ? config.modelOverrides : {})) {
      const op = `${at}.modelOverrides.${modelId}`;
      if (!isObj(override)) { err(op, "override 必须是对象"); continue; }
      for (const key of Object.keys(override)) {
        if (!OVERRIDE_FIELDS.has(key)) warn(`${op}.${key}`, "pi 不认识这个 override 字段，会被忽略");
      }
      if (!builtin && modelIds.size && !modelIds.has(modelId)) {
        warn(op, "这个 id 不在本 provider 的 models 里，pi 会忽略这条 override");
      }
      if (override.contextWindow !== undefined && (!Number.isFinite(override.contextWindow) || override.contextWindow <= 0)) {
        err(`${op}.contextWindow`, "必须大于 0");
      }
      if (override.maxTokens !== undefined && (!Number.isFinite(override.maxTokens) || override.maxTokens <= 0)) {
        err(`${op}.maxTokens`, "必须大于 0");
      }
    }
    if (!builtin) {
      const problem = credentialProblem(id, config, auth);
      if (problem) warn(at, problem);
    }
  }

  const defaultProvider = settings?.defaultProvider;
  if (defaultProvider) {
    const known = Object.hasOwn(providers, defaultProvider) || builtins.has?.(defaultProvider);
    if (!known) {
      warn("settings.defaultProvider", `默认 provider "${defaultProvider}" 不在 models.json，也不是 pi 内置 provider`);
    } else if (settings.defaultModel && Object.hasOwn(providers, defaultProvider)) {
      const ids = new Set((providers[defaultProvider].models ?? []).map((m) => m?.id).filter(Boolean));
      if (ids.size && !ids.has(settings.defaultModel)) {
        warn("settings.defaultModel", `默认模型 "${settings.defaultModel}" 不在 ${defaultProvider} 的模型列表里`);
      }
    }
  }
  return { errors, warnings };
}
