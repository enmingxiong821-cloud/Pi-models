import { rootOf } from "./util.mjs";

export const API_KINDS = ["openai-completions", "openai-responses", "anthropic-messages"];

export function apiFamily(api) {
  return String(api || "").startsWith("anthropic") ? "anthropic" : "openai";
}

export function baseUrlFor(root, api) {
  const base = rootOf(root);
  return apiFamily(api) === "anthropic" ? base : `${base}/v1`;
}

function authHeaders(api, key) {
  if (!key) return {};
  return apiFamily(api) === "anthropic"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${key}` };
}

async function request(url, { method = "GET", headers = {}, body, timeout = 20000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "user-agent": "pi-model-hub", ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应，保留原文 */
  }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 400) };
}

/** 拉取中转站的模型列表。/v1/models 是最通用的探测端点，NewAPI/one-api 都支持。 */
export async function fetchModels({ root, api, key, timeout = 20000 }) {
  const url = `${rootOf(root)}/v1/models`;
  const res = await request(url, { headers: authHeaders(api, key), timeout });
  const data = res.json?.data ?? res.json?.models ?? res.json?.result ?? null;
  const ids = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "string") ids.push(item);
      else if (item?.id) ids.push(String(item.id));
      else if (item?.name) ids.push(String(item.name));
    }
  } else if (data && typeof data === "object") {
    ids.push(...Object.keys(data));
  }
  return { status: res.status, ok: res.ok, ids: [...new Set(ids)].sort(), raw: res.text, url };
}

/** 真发一条最小请求，验证 key 在这个端点上确实能用。 */
export async function probeChat({ root, api, key, model, timeout = 45000 }) {
  const family = apiFamily(api);
  const base = rootOf(root);
  let url;
  let body;
  let headers = authHeaders(api, key);

  if (family === "anthropic") {
    url = `${base}/v1/messages`;
    body = { model, max_tokens: 8, messages: [{ role: "user", content: "ping, reply with pong" }] };
  } else if (api === "openai-responses") {
    url = `${base}/v1/responses`;
    body = { model, input: "ping, reply with pong", max_output_tokens: 16 };
  } else {
    url = `${base}/v1/chat/completions`;
    body = { model, max_tokens: 8, stream: false, messages: [{ role: "user", content: "ping, reply with pong" }] };
  }

  const started = Date.now();
  const res = await request(url, { method: "POST", headers, body, timeout });
  const ms = Date.now() - started;
  const text =
    res.json?.content?.[0]?.text ??
    res.json?.choices?.[0]?.message?.content ??
    res.json?.output_text ??
    res.json?.output?.[0]?.content?.[0]?.text ??
    null;
  const errMsg = res.json?.error?.message ?? res.json?.message ?? (res.ok ? null : res.text);
  return { status: res.status, ok: res.ok, ms, text, error: errMsg, url };
}

/** NewAPI / one-api 会暴露倍率配置，可用于估算中转站真实价格。 */
export async function fetchRatioConfig({ root, timeout = 10000 }) {
  for (const path of ["/api/ratio_config"]) {
    try {
      const res = await request(`${rootOf(root)}${path}`, { timeout });
      if (res.ok && res.json?.data) return { ok: true, data: res.json.data, url: `${rootOf(root)}${path}` };
    } catch {
      /* 可选端点，失败就跳过 */
    }
  }
  return { ok: false };
}

export function isLocal(url) {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * 从地址猜一个 provider 名称：tbyunyi-router.crow5.com -> crow5，
 * api.openai.com -> openai，localhost -> localhost。
 */
export function suggestName(url) {
  let host;
  try {
    host = new URL(String(url).includes("://") ? url : `https://${url}`).hostname;
  } catch {
    return "relay";
  }
  const tlds = new Set(["com", "cn", "net", "org", "io", "co", "ai", "dev", "app", "xyz", "top", "vip", "cc", "me", "info", "tech", "site", "online", "local", "internal", "lan"]);
  const drop = new Set(["www", "api", "openai", "proxy", "router", "gateway", "gw"]);
  const labels = host.split(".").filter(Boolean);
  let parts = labels;
  if (parts.length > 1 && tlds.has(parts.at(-1))) parts = parts.slice(0, -1);
  while (parts.length > 1 && drop.has(parts[0])) parts = parts.slice(1);
  const name = (parts.at(-1) ?? labels[0] ?? "relay").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return name || "relay";
}
