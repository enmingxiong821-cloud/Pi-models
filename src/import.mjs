// 批量导入：把用户手头的各种"地址 + Key"文本/文件/订阅链接/已有工具配置
// 解析成统一条目。纯函数 + 少量白名单文件读取，方便离线测试。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTextCapped, suggestName } from "./relay.mjs";
import { fileExists, rootOf } from "./util.mjs";

const MAX_RESPONSE_BYTES = 1024 * 1024;

const API_ALIASES = {
  openai: "openai-completions",
  "openai-compatible": "openai-completions",
  "openai-completions": "openai-completions",
  completions: "openai-completions",
  chat: "openai-completions",
  responses: "openai-responses",
  "openai-responses": "openai-responses",
  response: "openai-responses",
  anthropic: "anthropic-messages",
  "anthropic-messages": "anthropic-messages",
  claude: "anthropic-messages",
  messages: "anthropic-messages",
};

const BASE_FIELDS = [
  "baseUrl", "base_url", "baseURL", "base", "url", "endpoint", "apiBase", "api_base",
  "apiBaseUrl", "api_base_url", "OPENAI_BASE_URL", "OPENAI_API_BASE", "ANTHROPIC_BASE_URL",
  "OPENROUTER_BASE_URL", "API_BASE_URL",
];
const KEY_FIELDS = [
  "key", "apiKey", "api_key", "apiKEY", "token", "authToken", "auth_token", "apiToken",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY",
  "API_KEY", "AUTH_TOKEN",
];
const NAME_FIELDS = ["name", "id", "provider", "label", "slug", "NAME"];
const ENV_BASE_KEYS = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENROUTER_BASE_URL", "API_BASE_URL", "BASE_URL"];
const ENV_KEY_KEYS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "API_KEY", "AUTH_TOKEN"];

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function pick(obj, names) {
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null && obj[name] !== "") return obj[name];
  }
  // 大小写不敏感兜底
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const name of names) {
    const k = lower.get(name.toLowerCase());
    if (k !== undefined && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function unquote(s) {
  return String(s ?? "").trim().replace(/^["'`]|["'`]$/g, "").trim();
}

/** 归一化地址：补 https、去掉已知的端点后缀与尾部斜杠。 */
export function normalizeBaseUrl(value) {
  let s = unquote(value);
  if (!s) return null;
  s = s.replace(/^<|>$/g, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
  } catch {
    return null;
  }
  s = s.replace(/\/+(v1\/)?(chat\/completions|completions|messages|responses|models)\/?$/i, "");
  return rootOf(s.replace(/[),;]+$/, ""));
}

export function normalizeApi(value, { baseUrl, key } = {}) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (API_ALIASES[raw]) return API_ALIASES[raw];
  const url = String(baseUrl ?? "").toLowerCase();
  if (url.includes("anthropic") || String(key ?? "").startsWith("sk-ant-")) return "anthropic-messages";
  return "openai-completions";
}

function normalizeName(value, baseUrl) {
  const raw = unquote(value);
  if (raw) {
    const cleaned = raw.replace(/\s+/g, "-").replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
    if (cleaned && /^[A-Za-z0-9]/.test(cleaned)) return cleaned.slice(0, 64);
  }
  return suggestName(baseUrl);
}

/** 从一个普通对象里抽一条记录；不是 provider 形状就返回 null。 */
function itemFromObject(obj, { source = "text", nameHint } = {}) {
  if (!isObj(obj)) return null;
  const baseRaw = pick(obj, BASE_FIELDS);
  if (!baseRaw) return null;
  const baseUrl = normalizeBaseUrl(baseRaw);
  if (!baseUrl) return null;
  const keyRaw = pick(obj, KEY_FIELDS);
  const key = typeof keyRaw === "string" ? unquote(keyRaw) : keyRaw ? String(keyRaw) : null;
  const name = pick(obj, NAME_FIELDS) ?? nameHint;
  const api = pick(obj, ["api", "API", "type", "protocol", "wire_api", "provider_type"]);
  const group = pick(obj, ["group", "GROUP", "category"]);
  const tagsRaw = pick(obj, ["tags", "TAGS"]);
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.map(String)
    : typeof tagsRaw === "string" && tagsRaw.trim()
      ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
      : [];
  const item = {
    name: normalizeName(name, baseUrl),
    baseUrl,
    key: key || null,
    api: normalizeApi(api, { baseUrl, key }),
    group: typeof group === "string" && group.trim() ? group.trim() : null,
    tags,
    source,
  };
  if (pick(obj, ["depth"]) !== undefined) item.depth = Number(pick(obj, ["depth"]));
  return item;
}

/** 从 env 形状里抽条目（Claude Code settings / .env 都走这里）。 */
export function itemsFromEnv(env, { source = "env", nameHint } = {}) {
  if (!isObj(env)) return [];
  const items = [];
  const anthropicBase = unquote(env.ANTHROPIC_BASE_URL);
  const openaiBase = unquote(env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE);
  if (anthropicBase) {
    items.push({
      name: normalizeName(nameHint, normalizeBaseUrl(anthropicBase)),
      baseUrl: normalizeBaseUrl(anthropicBase),
      key: unquote(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY) || null,
      api: "anthropic-messages",
      group: null,
      tags: [],
      source,
    });
  }
  if (openaiBase) {
    items.push({
      name: normalizeName(nameHint, normalizeBaseUrl(openaiBase)),
      baseUrl: normalizeBaseUrl(openaiBase),
      key: unquote(env.OPENAI_API_KEY ?? env.API_KEY) || null,
      api: normalizeApi(env.OPENAI_API_TYPE, { baseUrl: openaiBase }),
      group: null,
      tags: [],
      source,
    });
  }
  if (!items.length) {
    const base = ENV_BASE_KEYS.map((k) => unquote(env[k])).find(Boolean);
    if (base) {
      const key = ENV_KEY_KEYS.map((k) => unquote(env[k])).find(Boolean) || null;
      items.push({
        name: normalizeName(nameHint, base),
        baseUrl: normalizeBaseUrl(base),
        key,
        api: normalizeApi(env.API_TYPE, { baseUrl: base, key }),
        group: null,
        tags: [],
        source,
      });
    }
  }
  return items.filter((i) => i.baseUrl);
}

/** JSON/JS 对象 → 条目列表，兼容数组、{relays}、{providers}、pi models.json、单对象。 */
export function itemsFromJson(value, { source = "json", depth = 0 } = {}) {
  if (depth > 3) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => (typeof v === "string" ? parsePlainLine(v, { source }) : itemsFromJson(v, { source, depth: depth + 1 })));
  }
  if (!isObj(value)) return [];

  if (isObj(value.env)) return itemsFromEnv(value.env, { source });
  if (isObj(value.model_providers)) return itemsFromProviderMap(value.model_providers, { source });

  for (const key of ["relays", "providers", "endpoints", "accounts", "items"]) {
    const list = value[key];
    if (Array.isArray(list)) return list.flatMap((v) => itemsFromJson(v, { source, depth: depth + 1 }));
    if (isObj(list)) return itemsFromProviderMap(list, { source });
  }

  const direct = itemFromObject(value, { source });
  if (direct) return [direct];

  // 形如 { "crow5": { baseUrl, key }, "kimi": {...} }
  const entries = Object.entries(value);
  if (entries.length && entries.every(([, v]) => isObj(v))) {
    const nested = entries.flatMap(([id, v]) => {
      const item = itemFromObject(v, { source, nameHint: v.name ?? id });
      return item ? [item] : [];
    });
    if (nested.length) return nested;
  }
  return [];
}

function itemsFromProviderMap(map, { source }) {
  return Object.entries(map).flatMap(([id, provider]) => {
    if (!isObj(provider)) return [];
    // pi models.json 的 provider 可能把 key 放在 apiKey；解析逻辑同普通对象
    const item = itemFromObject(provider, { source, nameHint: provider.name ?? id });
    return item ? [item] : [];
  });
}

// ---- 行式格式 ----

function blocksOf(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let cur = [];
  const flush = () => {
    if (cur.length) blocks.push(cur);
    cur = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^-{3,}$/.test(t)) flush();
    else cur.push(line);
  }
  flush();
  return blocks;
}

function parseEnvLines(lines) {
  const env = {};
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    env[m[1]] = unquote(m[2]);
  }
  return env;
}

function looksLikeUrl(token) {
  if (/^https?:\/\/[^\s/?#]+/i.test(token)) return true;
  // 裸域名必须有字母 TLD 或显式端口；这样 "20.10.2" 这类版本号不会被当成地址
  if (/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i.test(token)) return true;
  return /^(?:\d{1,3}\.){3}\d{1,3}:\d+(?:[/?#]\S*)?$/.test(token);
}

function looksLikeKey(token) {
  return typeof token === "string" && token.length >= 8 && /^[A-Za-z0-9_.:@\/+-]+$/.test(token) && !looksLikeUrl(token);
}

/** 单行：url key / name|url|key / url,key / name url key。 */
export function parsePlainLine(line, { source = "text" } = {}) {
  const text = String(line ?? "").trim();
  if (!text || /^(#|\/\/|;)/.test(text)) return [];
  if (text.includes("|")) {
    const parts = text.split("|").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      if (!looksLikeUrl(parts[1])) return [];
      return [{
        name: normalizeName(parts[0], normalizeBaseUrl(parts[1])),
        baseUrl: normalizeBaseUrl(parts[1]),
        key: parts[2] || null,
        api: normalizeApi(null, { baseUrl: parts[1], key: parts[2] }),
        group: null,
        tags: [],
        source,
      }].filter((i) => i.baseUrl);
    }
    if (parts.length === 2) {
      if (!looksLikeUrl(parts[0])) return [];
      const baseUrl = normalizeBaseUrl(parts[0]);
      if (!baseUrl) return [];
      return [{ name: normalizeName(null, baseUrl), baseUrl, key: parts[1] || null, api: normalizeApi(null, { baseUrl, key: parts[1] }), group: null, tags: [], source }];
    }
  }
  const comma = text.lastIndexOf(",");
  if (comma > 0) {
    const left = text.slice(0, comma).trim();
    const right = text.slice(comma + 1).trim();
    if (looksLikeUrl(left) && looksLikeKey(right)) {
      const baseUrl = normalizeBaseUrl(left);
      return [{ name: normalizeName(null, baseUrl), baseUrl, key: right, api: normalizeApi(null, { baseUrl, key: right }), group: null, tags: [], source }];
    }
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  const urlIdx = tokens.findIndex(looksLikeUrl);
  if (urlIdx < 0) return [];
  const baseUrl = normalizeBaseUrl(tokens[urlIdx]);
  if (!baseUrl) return [];
  const keyIdx = tokens.findIndex((t, i) => i > urlIdx && looksLikeKey(t));
  const key = keyIdx >= 0 ? tokens[keyIdx] : null;
  const nameHint = urlIdx > 0 ? tokens.slice(0, urlIdx).join("-") : null;
  return [{
    name: normalizeName(nameHint, baseUrl),
    baseUrl,
    key,
    api: normalizeApi(null, { baseUrl, key }),
    group: null,
    tags: [],
    source,
  }];
}

function parseYamlBlock(lines, { source }) {
  const obj = {};
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    obj[m[1]] = unquote(m[2].replace(/\s+#.*$/, ""));
  }
  const item = itemFromObject(obj, { source });
  return item ? [item] : [];
}

/** curl 命令：从 URL 与 Authorization / x-api-key 头里抽。 */
export function parseCurl(text, { source = "curl" } = {}) {
  const items = [];
  for (const chunk of String(text).split(/\n(?=\s*\$?\s*curl\b)/i)) {
    if (!/\bcurl\b/i.test(chunk)) continue;
    const urlMatch = chunk.match(/https?:\/\/[^\s"'`\\]+/i);
    if (!urlMatch) continue;
    const baseUrl = normalizeBaseUrl(urlMatch[0]);
    if (!baseUrl) continue;
    const bearer = chunk.match(/(?:authorization\s*:\s*bearer|--oauth2-bearer)\s+([^"'\s\\]+)/i);
    const xApiKey = chunk.match(/(?:x-api-key|api-key)\s*:\s*([^"'\s\\]+)/i);
    const key = bearer?.[1] ?? xApiKey?.[1] ?? null;
    const isAnthropic = Boolean(xApiKey) || /anthropic|\/v1\/messages/i.test(chunk);
    const isResponses = /"input"\s*:/.test(chunk) && !/"messages"\s*:/.test(chunk);
    items.push({
      name: normalizeName(null, baseUrl),
      baseUrl,
      key,
      api: isAnthropic ? "anthropic-messages" : isResponses ? "openai-responses" : normalizeApi(null, { baseUrl, key }),
      group: null,
      tags: [],
      source,
    });
  }
  return items;
}

const PMH_URI_RE = /pmh:\/\/(?:import|add)\?([^\s"'`<>]+)/gi;
const CCSWITCH_URI_RE = /ccswitch:\/\/v1\/import\?([^\s"'`<>]+)/gi;

const CCSWITCH_API_FORMATS = {
  anthropic: "anthropic-messages",
  "anthropic-messages": "anthropic-messages",
  openai_chat: "openai-completions",
  openai_completions: "openai-completions",
  "openai-completions": "openai-completions",
  openai_responses: "openai-responses",
  "openai-responses": "openai-responses",
};

function decodeBase64Text(value) {
  try {
    return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * cc-switch 的分享深链：
 * ccswitch://v1/import?resource=provider&app=pi&name=…&endpoint=…&apiKey=…&model=…&apiFormat=…
 * `config` / `content` 是 Base64 + URL 转义后的整段配置，其余参数是普通 URL 编码明文。
 */
export function parseCcswitchUris(text, { source = "ccswitch" } = {}) {
  const items = [];
  const errors = [];
  for (const match of String(text).matchAll(CCSWITCH_URI_RE)) {
    const params = new URLSearchParams(match[1]);
    const resource = String(params.get("resource") ?? "provider").toLowerCase();
    if (resource !== "provider") continue;

    const encoded = params.get("config") ?? params.get("content");
    if (encoded) {
      const decoded = decodeBase64Text(encoded);
      const parsed = decoded ? parseImportText(decoded, { source, depth: 1 }) : { items: [], errors: ["内容不是合法的 Base64"] };
      items.push(...parsed.items);
      errors.push(...parsed.errors);
      continue;
    }

    const baseRaw = params.get("endpoint") ?? params.get("baseUrl") ?? params.get("url");
    const baseUrl = normalizeBaseUrl(baseRaw);
    if (!baseUrl) {
      errors.push(`ccswitch 链接缺少有效 endpoint：${baseRaw ? "地址格式不对" : "参数为空"}`);
      continue;
    }
    const key = params.get("apiKey") ?? params.get("key") ?? null;
    const apiFormat = String(params.get("apiFormat") ?? "").toLowerCase();
    if (apiFormat === "gemini_native" || apiFormat === "google-generative-ai") {
      errors.push(`暂不支持 Gemini 原生协议（apiFormat=${params.get("apiFormat")}），请用 OpenAI 兼容端点接入：${baseUrl}`);
      continue;
    }
    const api = CCSWITCH_API_FORMATS[apiFormat] ?? normalizeApi(params.get("api"), { baseUrl, key });
    const item = {
      name: normalizeName(params.get("name"), baseUrl),
      baseUrl,
      key: key ? String(key) : null,
      api,
      group: null,
      tags: [],
      source,
    };
    // pi 专用链接必带 model；记下来，导入时直接作为该站的模型清单
    const models = String(params.get("model") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (models.length) item.models = models;
    items.push(item);
  }
  return { items, errors };
}

export function parsePmhUris(text, { source = "pmh" } = {}) {
  const items = [];
  for (const match of String(text).matchAll(PMH_URI_RE)) {
    const params = new URLSearchParams(match[1]);
    const baseUrl = normalizeBaseUrl(params.get("base") ?? params.get("baseUrl") ?? params.get("url"));
    if (!baseUrl) continue;
    const key = params.get("key") ?? params.get("apiKey") ?? null;
    items.push({
      name: normalizeName(params.get("name"), baseUrl),
      baseUrl,
      key,
      api: normalizeApi(params.get("api"), { baseUrl, key }),
      group: params.get("group") ?? null,
      tags: params.get("tag") ? params.get("tag").split(",").filter(Boolean) : [],
      source,
    });
  }
  return items;
}

function maybeBase64(text) {
  const compact = String(text).replace(/\s+/g, "");
  if (compact.length < 16 || compact.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) return null;
  try {
    const decoded = Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    if (!/https?:\/\/|\{/.test(decoded)) return null;
    // 解出来必须是可打印文本，避免把随机 Key 当订阅内容
    if (/[\u0000-\u0008\u000e-\u001f]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isJsonLines(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  let ok = 0;
  for (const line of lines) {
    if (!/^[\[{]/.test(line)) return false;
    try {
      JSON.parse(line);
      ok += 1;
    } catch {
      return false;
    }
  }
  return ok === lines.length;
}

/**
 * 主入口：把任意文本解析成条目。
 * 返回 { items, errors, format }，items 已做基本清洗（未去重）。
 */
export function parseImportText(text, { source = "text", depth = 0 } = {}) {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  const errors = [];
  if (!trimmed) return { items: [], errors: ["内容为空"], format: "empty" };

  if (/ccswitch:\/\//i.test(trimmed)) {
    const cc = parseCcswitchUris(trimmed, { source: source === "text" ? "ccswitch" : source });
    return { items: cc.items, errors: cc.errors, format: cc.items.length ? "ccswitch" : "ccswitch-error" };
  }

  const uriItems = parsePmhUris(trimmed, { source });
  if (uriItems.length) return { items: uriItems, errors, format: "pmh-uri" };

  if (/^[\[{]/.test(trimmed)) {
    try {
      const value = JSON.parse(trimmed);
      const items = itemsFromJson(value, { source: source === "text" ? "json" : source });
      if (items.length) return { items, errors, format: "json" };
      errors.push("JSON 里没有找到可用的地址");
    } catch {
      // 不要把原始输入拼进错误信息：里面可能有 Key
      errors.push("JSON 解析失败：请检查引号、逗号等语法");
    }
  }

  if (isJsonLines(trimmed)) {
    const items = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((l) => itemsFromJson(JSON.parse(l), { source }));
    if (items.length) return { items, errors, format: "jsonl" };
  }

  if (depth < 2) {
    const decoded = maybeBase64(trimmed);
    if (decoded) {
      const inner = parseImportText(decoded, { source, depth: depth + 1 });
      if (inner.items.length) return { items: inner.items, errors: [...errors, ...inner.errors], format: `base64/${inner.format}` };
    }
  }

  const items = [];
  const formats = new Set();
  for (const lines of blocksOf(trimmed)) {
    const joined = lines.join("\n");
    if (/^\s*\$?\s*curl\b/i.test(joined)) {
      const parsed = parseCurl(joined, { source });
      if (parsed.length) {
        items.push(...parsed);
        formats.add("curl");
        continue;
      }
    }
    const env = parseEnvLines(lines);
    if (ENV_BASE_KEYS.some((k) => env[k]) || ENV_KEY_KEYS.some((k) => env[k])) {
      const parsed = itemsFromEnv(env, { source });
      if (parsed.length) {
        items.push(...parsed);
        formats.add("env");
        continue;
      }
    }
    if (lines.some((l) => /^\s*[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(l))) {
      const parsed = parseYamlBlock(lines, { source });
      if (parsed.length) {
        items.push(...parsed);
        formats.add("yaml");
        continue;
      }
    }
    for (const line of lines) {
      const parsed = parsePlainLine(line, { source });
      if (parsed.length) {
        items.push(...parsed);
        formats.add("plain");
      }
    }
  }

  if (!items.length && !errors.length) {
    errors.push("没解析出任何地址。支持的格式：URL+Key、JSON、env 块、YAML 块、curl、pmh:// 链接。");
  }
  return { items, errors, format: [...formats].join("+") || "unknown" };
}

/**
 * 去重：同地址同 Key 合并；同地址不同 Key 标记为该站的 Key 别名；
 * 重名但不同站自动加后缀。返回条目已带 root。
 */
export function dedupeItems(items, { providers = {}, force = false } = {}) {
  const out = [];
  const seen = new Map();
  const usedNames = new Set(Object.keys(providers ?? {}));
  const existingRoots = new Map(
    Object.entries(providers ?? {}).map(([name, provider]) => [name, rootOf(provider?.baseUrl ?? "")]),
  );

  for (const raw of items) {
    if (!raw?.baseUrl) {
      out.push({ ...raw, error: "缺少地址" });
      continue;
    }
    const root = rootOf(raw.baseUrl);
    const sig = `${root}|${raw.key ?? ""}`;
    const duplicate = seen.get(sig);
    if (duplicate) {
      duplicate.group ??= raw.group;
      duplicate.tags = [...new Set([...(duplicate.tags ?? []), ...(raw.tags ?? [])])];
      duplicate.duplicate = true;
      continue;
    }

    const sameRoot = out.filter((x) => x.root === root && !x.error);
    const item = { ...raw, root };
    if (sameRoot.length) {
      item.aliasOf = sameRoot[0].name;
      item.note = "同站不同 Key";
    }

    let name = normalizeName(item.name, item.baseUrl);
    const existingRoot = existingRoots.get(name);
    const sameSite = existingRoot !== undefined && (!existingRoot || existingRoot === root);
    // 同名但不是同一个站：默认自动加后缀，别把别的站覆盖掉；--force 才按用户意图接管
    if (existingRoot !== undefined && !sameSite && !force) {
      item.renamedFrom = name;
      let n = 2;
      while (usedNames.has(`${name}-${n}`)) n += 1;
      name = `${name}-${n}`;
    } else if (existingRoot === undefined && usedNames.has(name)) {
      // 同一批导入内部重名
      item.renamedFrom = name;
      let n = 2;
      while (usedNames.has(`${name}-${n}`)) n += 1;
      name = `${name}-${n}`;
    }
    usedNames.add(name);
    item.name = name;
    seen.set(sig, item);
    out.push(item);
  }
  return out;
}

// ---- 从已有工具配置读取 ----

/** 解析 Codex 的 config.toml（只认 [model_providers.*]）。 */
export function parseCodexToml(text, { source = "codex" } = {}) {
  const items = [];
  let section = null;
  let current = null;

  const flush = () => {
    if (!current) return;
    const baseUrl = normalizeBaseUrl(current.base_url);
    if (baseUrl) {
      const key = current.api_key || (current.env_key && process.env[current.env_key]) || null;
      items.push({
        name: normalizeName(current.name ?? current.id, baseUrl),
        baseUrl,
        key,
        api: current.wire_api === "responses" ? "openai-responses" : normalizeApi(current.wire_api, { baseUrl, key }),
        group: null,
        tags: [],
        source,
        envKey: !current.api_key && current.env_key && !process.env[current.env_key] ? current.env_key : undefined,
      });
    }
    current = null;
  };

  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(t);
    if (header) {
      flush();
      section = header[1].replace(/^"|"$/g, "");
      if (section.startsWith("model_providers.")) {
        current = { id: section.slice("model_providers.".length).replace(/^"|"$/g, "") };
      }
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/.exec(t);
    if (!kv) continue;
    let value = kv[2].replace(/\s+#.*$/, "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    current[kv[1]] = value;
  }
  flush();
  return items.filter((i) => i.baseUrl);
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 白名单扫描 Claude Code 的配置文件，不递归目录。 */
export function collectFromClaude({ home = os.homedir() } = {}) {
  const dir = path.join(home, ".claude");
  const files = [path.join(dir, "settings.json"), path.join(dir, "settings.local.json"), path.join(home, ".claude.json")];
  const items = [];
  const found = [];
  for (const file of files) {
    const text = readIfExists(file);
    if (!text) continue;
    try {
      const json = JSON.parse(text);
      const env = json?.env ?? json?.settings?.env;
      if (!isObj(env)) continue;
      const parsed = itemsFromEnv(env, { source: "claude" });
      if (parsed.length) {
        items.push(...parsed);
        found.push(file);
      }
    } catch {
      /* 坏文件跳过，scan 会提示 */
    }
  }
  return { items, files: found };
}

/** 白名单扫描 Codex 配置。 */
export function collectFromCodex({ home = os.homedir() } = {}) {
  const file = path.join(home, ".codex", "config.toml");
  const text = readIfExists(file);
  if (!text) return { items: [], files: [] };
  const items = parseCodexToml(text);
  return { items, files: items.length ? [file] : [] };
}

/** cc-switch 单个 provider → 条目（兼容 claude 的 env、codex 的 TOML 字符串与直填字段）。 */
function itemsFromCcswitchProvider(provider, { source, nameHint }) {
  if (!isObj(provider)) return [];
  const label = provider.name ?? nameHint;
  const settings = provider.settingsConfig ?? provider.settings_config ?? provider.config;

  if (typeof settings === "string") {
    if (/\[model_providers\./.test(settings)) {
      return parseCodexToml(settings, { source }).map((item) => ({ ...item, name: normalizeName(label, item.baseUrl) }));
    }
    try {
      const parsed = JSON.parse(settings);
      const items = itemsFromEnv(parsed?.env ?? parsed?.settings?.env, { source, nameHint: label });
      if (items.length) return items;
    } catch {
      /* 不是 JSON，继续尝试其它形状 */
    }
  }

  const env = isObj(settings) ? settings.env ?? (isObj(settings.settings) ? settings.settings.env : null) : null;
  if (isObj(env)) {
    return itemsFromEnv(env, { source, nameHint: label }).map((item) => ({
      ...item,
      name: normalizeName(label, item.baseUrl),
    }));
  }

  const direct = itemFromObject(
    isObj(settings) ? { ...settings, name: label } : provider,
    { source, nameHint: label },
  );
  return direct ? [direct] : [];
}

/**
 * 读取 cc-switch 的旧版 JSON 配置（v4 起改用 SQLite，这里只提示不解析）。
 * 结构：{ claude: { providers: { id: {...} } }, codex: {...}, gemini: {...} }
 * 以及更早的 { providers: {...} }。
 */
export function collectFromCcswitch({ home = os.homedir() } = {}) {
  const dir = path.join(home, ".cc-switch");
  const file = path.join(dir, "config.json");
  const items = [];
  const files = [];
  const hasDatabase = fileExists(path.join(dir, "cc-switch.db"));
  const text = readIfExists(file);
  if (text) {
    try {
      const json = JSON.parse(text);
      const maps = [];
      if (isObj(json.providers)) maps.push(json.providers);
      for (const app of ["claude", "codex", "gemini"]) {
        if (isObj(json[app]?.providers)) maps.push(json[app].providers);
      }
      for (const map of maps) {
        for (const [id, provider] of Object.entries(map)) {
          items.push(...itemsFromCcswitchProvider(provider, { source: "ccswitch", nameHint: id }));
        }
      }
      if (items.length) files.push(file);
    } catch {
      /* 坏文件交给 scan 提示 */
    }
  }
  return { items, files, hasDatabase };
}

/** 拉订阅链接内容；只允许同域重定向，限制 1MB。 */
export async function fetchText(url, { timeout = 15000, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  let current = String(url);
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
      headers: { "user-agent": "pmh-cli" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`订阅链接返回 ${res.status} 但没给跳转地址`);
      const next = new URL(location, current);
      if (next.host !== new URL(current).host) throw new Error("订阅链接跳转到了其他域名，已停止（避免把请求带到未知站点）");
      if (!/^https?:$/.test(next.protocol)) throw new Error(`不支持的跳转协议：${next.protocol}`);
      current = next.href;
      continue;
    }
    if (!res.ok) throw new Error(`订阅链接返回 HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error(`订阅内容超过 ${Math.round(maxBytes / 1024)} KB，已停止`);
    return await readTextCapped(res, maxBytes);
  }
  throw new Error("订阅链接重定向次数过多");
}

export function isUrl(value) {
  const text = String(value ?? "").trim();
  // 含空白的多半是"URL + Key"或整段粘贴文本，交给 parsePlainLine 处理
  if (!text || /\s/.test(text)) return false;
  return /^https?:\/\//i.test(text);
}
