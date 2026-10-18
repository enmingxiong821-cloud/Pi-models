// 桌面端复用的数据与动作服务：不依赖 electron，界面只拿到脱敏后的 DTO。
import { cmdUse, formatContext, loadRegistryState } from "./commands.mjs";
import {
  deleteModel, getProviderDetail, getThinking, listProviders, purgeProviderKey, removeProvider,
  saveModel, saveProvider, setThinking, updateProviderKey,
} from "./admin-service.mjs";
import { getAutoState, previewRoute, updateAuto } from "./auto-service.mjs";
import { entryKey, filterEntries, formatDetail, loadConsoleState, scopeOptions } from "./console.mjs";
import { redact } from "./feedback.mjs";
import { saveRegistry, toggleFavorite } from "./registry.mjs";
import { collectUsage } from "./usage-service.mjs";

const MAX_QUERY = 128;
const GROUP_SCOPE = /^group:[A-Za-z0-9_.-]{1,32}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isValidScope(scopeId, scopes = []) {
  if (scopeId === "all" || scopeId === "fav" || scopeId === "recent") return true;
  if (typeof scopeId !== "string" || !GROUP_SCOPE.test(scopeId)) return false;
  return scopes.some((scope) => scope.id === scopeId);
}

export function sanitizeQuery(query) {
  return String(query ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, MAX_QUERY);
}

function safeName(value, max) {
  if (typeof value !== "string" || !value || value.length > max) return null;
  if (UNSAFE_KEYS.has(value)) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export function validateTarget(provider, model) {
  const p = safeName(provider, 64);
  const m = safeName(model, 128);
  if (!p || !m) throw new Error("模型参数无效");
  return { provider: p, model: m };
}

function findEntry(session, provider, model) {
  return session.state.entries.find((entry) => entry.provider === provider && entry.model === model) ?? null;
}

function sanitizeEntry(entry, currentKey) {
  return {
    provider: entry.provider,
    model: entry.model,
    name: entry.name ?? entry.model,
    contextWindow: entry.contextWindow ?? null,
    contextLabel: formatContext(entry.contextWindow),
    maxTokens: entry.maxTokens ?? null,
    maxTokensLabel: formatContext(entry.maxTokens),
    reasoning: Boolean(entry.reasoning),
    image: Array.isArray(entry.input) && entry.input.includes("image"),
    cost: entry.cost ?? null,
    costTier: entry.costTier ?? null,
    thinking: entry.thinking ?? null,
    thinkingSource: entry.thinkingSource ?? "default",
    group: entry.group ?? null,
    favorite: Boolean(entry.favorite),
    current: entryKey(entry) === currentKey,
    recentRank: entry.recentRank ?? null,
    credentialKind: entry.credential ?? "无",
    keyAlias: entry.keyAlias ?? null,
    api: entry.api ?? null,
    detailLines: formatDetail(entry),
  };
}

function buildScopes(state) {
  return scopeOptions(state.registry).map((scope) => ({
    ...scope,
    count: filterEntries(state, scope.id, "").length,
  }));
}

function reload(session) {
  session.state = loadConsoleState(session.ctx);
  session.scopes = buildScopes(session.state);
}

function enqueue(session, task) {
  const run = session.tail.then(task, task);
  session.tail = run.catch(() => {});
  return run;
}

export function createSession(ctx) {
  const session = { ctx, state: null, scopes: [], tail: Promise.resolve() };
  reload(session);
  return session;
}

export function refresh(session) {
  reload(session);
  return session;
}

export function buildView(session, { scopeId = "all", query = "", selectedKey = null } = {}) {
  if (!isValidScope(scopeId, session.scopes)) throw new Error("筛选范围无效");
  const text = sanitizeQuery(query);
  const entries = filterEntries(session.state, scopeId, text);
  const currentKey = session.state.currentKey;
  const selected =
    (selectedKey ? entries.find((entry) => entryKey(entry) === selectedKey) : null) ??
    entries[0] ??
    null;
  return {
    agentDir: session.ctx.agentDir,
    currentKey,
    scopes: session.scopes,
    scopeId,
    query: text,
    entries: entries.map((entry) => sanitizeEntry(entry, currentKey)),
    selectedKey: selected ? entryKey(selected) : null,
  };
}

export function switchModel(session, provider, model) {
  const target = validateTarget(provider, model);
  return enqueue(session, async () => {
    const entry = findEntry(session, target.provider, target.model);
    if (!entry) throw new Error("模型不存在或已被移除，请刷新后再试");
    await cmdUse(session.ctx, entryKey(entry), { quiet: true });
    reload(session);
    return { key: entryKey(entry), provider: entry.provider, model: entry.model };
  });
}

export function favoriteModel(session, provider, model) {
  const target = validateTarget(provider, model);
  return enqueue(session, async () => {
    const entry = findEntry(session, target.provider, target.model);
    if (!entry) throw new Error("模型不存在或已被移除，请刷新后再试");
    const { registry } = loadRegistryState(session.ctx);
    const added = toggleFavorite(registry, entry.provider, entry.model);
    saveRegistry(session.ctx, registry);
    reload(session);
    return { key: entryKey(entry), added };
  });
}

export function providerList(session) {
  return enqueue(session, async () => listProviders(session.ctx));
}

export function providerDetail(session, provider) {
  return enqueue(session, async () => getProviderDetail(session.ctx, provider));
}

export function providerSave(session, input) {
  return enqueue(session, async () => {
    const result = await saveProvider(session.ctx, input);
    reload(session);
    return result;
  });
}

export function providerDelete(session, provider, params) {
  return enqueue(session, async () => {
    const result = removeProvider(session.ctx, provider, params);
    reload(session);
    return result;
  });
}

export function providerKeySet(session, provider, key) {
  return enqueue(session, async () => {
    const result = updateProviderKey(session.ctx, provider, key);
    reload(session);
    return result;
  });
}

export function providerKeyClear(session, provider, params) {
  return enqueue(session, async () => {
    const result = purgeProviderKey(session.ctx, provider, params);
    reload(session);
    return result;
  });
}

export function modelSave(session, input) {
  return enqueue(session, async () => {
    const result = saveModel(session.ctx, input);
    reload(session);
    return result;
  });
}

export function modelDelete(session, input) {
  return enqueue(session, async () => {
    const result = deleteModel(session.ctx, input);
    reload(session);
    return result;
  });
}

export function thinkingGet(session, params) {
  return enqueue(session, async () => ({ state: getThinking(session.ctx, params ?? {}) }));
}

export function thinkingSet(session, params) {
  return enqueue(session, async () => {
    const result = setThinking(session.ctx, params ?? {});
    reload(session);
    return result;
  });
}

export function autoGet(session) {
  return enqueue(session, async () => ({ auto: getAutoState(session.ctx) }));
}

export function autoSet(session, patch) {
  return enqueue(session, async () => ({ auto: updateAuto(session.ctx, patch) }));
}

export function autoPreview(session, params) {
  return enqueue(session, async () => ({ preview: previewRoute(session.ctx, params ?? {}) }));
}

export function usageGet(session, params = {}) {
  return enqueue(session, async () => ({ usage: await collectUsage(session.ctx, params) }));
}

export function safeError(err) {
  const message = err instanceof Error ? err.message : String(err ?? "未知错误");
  return redact(message, { max: 500 });
}
