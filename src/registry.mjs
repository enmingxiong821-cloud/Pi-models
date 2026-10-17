// 多站注册表：分组、标签、收藏、最近使用、Key 别名、元数据来源。
// 只存运维元数据，不含任何密钥；丢了可以从 models.json + auth.json 重建。
import fs from "node:fs";
import { keyAliasesOf } from "./keyring.mjs";
import { readJson, rootOf, writeJson } from "./util.mjs";

export const REGISTRY_VERSION = 1;
export const MRU_LIMIT = 20;
export const HISTORY_LIMIT = 20;
export const WIDGET_MODES = ["auto", "on", "off"];

const now = () => new Date().toISOString();

/** 分组名沿用 provider 名的字符集，避免出现需要转义的键。 */
export function normalizeGroupName(name) {
  const id = String(name ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(id)) {
    throw new Error(`分组名只能用字母/数字/._-，长度 1–32，收到: "${name}"`);
  }
  return id;
}

export function emptyRegistry() {
  return {
    version: REGISTRY_VERSION,
    updatedAt: now(),
    groups: {},
    relays: {},
    history: [],
    settings: { widget: "auto" },
  };
}

/** 把磁盘上的任意形状收敛成合法注册表；坏字段丢弃而不是抛错。 */
export function normalizeRegistry(data) {
  const registry = emptyRegistry();
  if (!data || typeof data !== "object" || Array.isArray(data)) return registry;

  for (const [name, group] of Object.entries(data.groups ?? {})) {
    try {
      const id = normalizeGroupName(name);
      registry.groups[id] = {
        title: typeof group?.title === "string" && group.title.trim() ? group.title.trim() : id,
        createdAt: group?.createdAt ?? now(),
      };
    } catch {
      /* 非法分组名，跳过 */
    }
  }

  for (const [id, relay] of Object.entries(data.relays ?? {})) {
    if (!relay || typeof relay !== "object" || !id) continue;
    registry.relays[id] = {
      id,
      name: typeof relay.name === "string" && relay.name ? relay.name : id,
      root: typeof relay.root === "string" ? relay.root : "",
      baseUrl: typeof relay.baseUrl === "string" ? relay.baseUrl : "",
      api: typeof relay.api === "string" ? relay.api : "openai-completions",
      apiRules: Array.isArray(relay.apiRules) ? relay.apiRules.filter((r) => r && r.pattern && r.api) : [],
      group: Object.hasOwn(registry.groups, relay.group) ? relay.group : null,
      tags: Array.isArray(relay.tags) ? relay.tags.filter((t) => typeof t === "string").slice(0, 16) : [],
      keyAliases: Array.isArray(relay.keyAliases) ? relay.keyAliases.filter((a) => typeof a === "string") : [],
      activeKey: typeof relay.activeKey === "string" ? relay.activeKey : null,
      favorites: Array.isArray(relay.favorites) ? relay.favorites.filter((m) => typeof m === "string") : [],
      mru: Array.isArray(relay.mru)
        ? relay.mru.filter((e) => e && typeof e.model === "string").slice(0, MRU_LIMIT)
        : [],
      lastModel: typeof relay.lastModel === "string" ? relay.lastModel : null,
      lastSyncedAt: relay.lastSyncedAt ?? null,
      metaSources: relay.metaSources && typeof relay.metaSources === "object" ? relay.metaSources : {},
      costMode: ["official", "scaled", "ratio", "off"].includes(relay.costMode) ? relay.costMode : "official",
      costMultiplier: Number(relay.costMultiplier) > 0 ? Number(relay.costMultiplier) : 1,
      source: typeof relay.source === "string" ? relay.source : "manual",
      createdAt: relay.createdAt ?? now(),
      updatedAt: relay.updatedAt ?? relay.createdAt ?? now(),
    };
  }

  registry.history = Array.isArray(data.history)
    ? data.history
        .filter((e) => e && typeof e.provider === "string" && e.provider)
        .map((e) => ({
          provider: e.provider,
          model: typeof e.model === "string" && e.model ? e.model : null,
          at: e.at ?? now(),
        }))
        .slice(0, HISTORY_LIMIT)
    : [];

  const widget = data.settings?.widget;
  registry.settings.widget = WIDGET_MODES.includes(widget) ? widget : "auto";
  registry.updatedAt = data.updatedAt ?? now();
  return registry;
}

function deriveRelay(id, provider, auth) {
  const aliases = keyAliasesOf(auth, id).map((e) => e.alias);
  return {
    id,
    name: provider.name ?? id,
    root: rootOf(provider.baseUrl ?? ""),
    baseUrl: provider.baseUrl ?? "",
    api: provider.api ?? "openai-completions",
    apiRules: [],
    group: null,
    tags: [],
    keyAliases: aliases,
    activeKey: aliases[0] ?? null,
    favorites: [],
    mru: [],
    lastModel: null,
    lastSyncedAt: null,
    metaSources: {},
    costMode: "official",
    costMultiplier: 1,
    source: "adopted",
    createdAt: now(),
    updatedAt: now(),
  };
}

/**
 * 读取注册表并与 models.json / auth.json 对齐。
 * 只读：不在磁盘上创建文件；changed=true 表示内存里的结果比磁盘新。
 */
export function loadRegistry(ctx, { models, auth } = {}) {
  const file = ctx.paths.registry;
  let stored = null;
  let corrupt = false;
  let reason = null;
  if (fs.existsSync(file)) {
    try {
      stored = readJson(file, null);
    } catch (err) {
      corrupt = true;
      reason = err.message;
    }
  }

  const registry = normalizeRegistry(stored);
  const modelsData = models ?? readJson(ctx.paths.models, { providers: {} });
  const authData = auth ?? readJson(ctx.paths.auth, {});
  const providers = modelsData?.providers ?? {};
  let changed = false;

  for (const [id, provider] of Object.entries(providers)) {
    let relay = registry.relays[id];
    if (!relay) {
      relay = deriveRelay(id, provider ?? {}, authData);
      registry.relays[id] = relay;
      changed = true;
    }
    // models.json 是接入参数的事实来源
    const aligned = {
      name: provider?.name ?? relay.name ?? id,
      root: rootOf(provider?.baseUrl ?? relay.baseUrl ?? ""),
      baseUrl: provider?.baseUrl ?? relay.baseUrl ?? "",
      api: provider?.api ?? relay.api,
    };
    for (const [field, value] of Object.entries(aligned)) {
      if (value && relay[field] !== value) {
        relay[field] = value;
        changed = true;
      }
    }
    const aliases = keyAliasesOf(authData, id).map((e) => e.alias);
    if (JSON.stringify(aliases) !== JSON.stringify(relay.keyAliases)) {
      relay.keyAliases = aliases;
      changed = true;
    }
    if (!aliases.includes(relay.activeKey)) {
      relay.activeKey = aliases[0] ?? null;
      changed = true;
    }
  }

  const stale = Object.keys(registry.relays).filter((id) => !providers[id]);
  return { registry, stale, corrupt, reason, changed };
}

/** 只做一次原子写；显式操作（分组/收藏/Key）默认留备份，MRU 可关掉。 */
export function saveRegistry(ctx, registry, { backup = true } = {}) {
  registry.version = REGISTRY_VERSION;
  registry.updatedAt = now();
  let keepBackup = backup;
  if (!keepBackup && fs.existsSync(ctx.paths.registry)) {
    try {
      JSON.parse(fs.readFileSync(ctx.paths.registry, "utf8"));
    } catch {
      // 损坏的文件先留一份，别让 MRU 这类自动写入把它直接盖掉
      keepBackup = true;
    }
  }
  return writeJson(ctx.paths.registry, registry, { backup: keepBackup });
}

export function getRelay(registry, relayId, { allowStale = false } = {}) {
  const relay = registry.relays[relayId];
  if (!relay) throw new Error(`注册表里没有 "${relayId}"（pmh ls 查看已接入的站）`);
  return relay;
}

export function removeRelay(registry, relayId) {
  if (!registry.relays[relayId]) return false;
  delete registry.relays[relayId];
  return true;
}

// ---- 分组 ----

export function addGroup(registry, name, { title } = {}) {
  const id = normalizeGroupName(name);
  if (Object.hasOwn(registry.groups, id)) throw new Error(`分组 "${id}" 已存在`);
  registry.groups[id] = { title: String(title ?? id).trim() || id, createdAt: now() };
  return registry.groups[id];
}

export function removeGroup(registry, name) {
  const id = normalizeGroupName(name);
  if (!Object.hasOwn(registry.groups, id)) throw new Error(`分组 "${id}" 不存在`);
  delete registry.groups[id];
  for (const relay of Object.values(registry.relays)) {
    if (relay.group === id) {
      relay.group = null;
      relay.updatedAt = now();
    }
  }
}

export function setRelayGroup(registry, relayId, group) {
  const relay = getRelay(registry, relayId);
  if (group === undefined || group === null || group === "" || group === "-") {
    relay.group = null;
  } else {
    const id = normalizeGroupName(group);
    if (!Object.hasOwn(registry.groups, id)) throw new Error(`分组 "${id}" 不存在，先建一个：pmh group add ${id}`);
    relay.group = id;
  }
  relay.updatedAt = now();
  return relay.group;
}

export function relaysInGroup(registry, group) {
  const id = normalizeGroupName(group);
  return Object.values(registry.relays).filter((r) => r.group === id);
}

// ---- 收藏 ----

export function addFavorite(registry, relayId, model) {
  const relay = getRelay(registry, relayId);
  if (!model) throw new Error("要收藏哪个模型？用法：pmh fav add <relay>#<模型>");
  if (!relay.favorites.includes(model)) {
    relay.favorites.push(model);
    relay.updatedAt = now();
    return true;
  }
  return false;
}

export function removeFavorite(registry, relayId, model) {
  const relay = getRelay(registry, relayId);
  const before = relay.favorites.length;
  relay.favorites = relay.favorites.filter((m) => m !== model);
  if (relay.favorites.length !== before) {
    relay.updatedAt = now();
    return true;
  }
  return false;
}

export function toggleFavorite(registry, relayId, model) {
  return (registry.relays[relayId]?.favorites ?? []).includes(model)
    ? (removeFavorite(registry, relayId, model), false)
    : (addFavorite(registry, relayId, model), true);
}

export function isFavorite(registry, relayId, model) {
  return (registry.relays[relayId]?.favorites ?? []).includes(model);
}

// ---- 最近使用 ----

export function recordUse(registry, relayId, model, { at = now() } = {}) {
  if (!model) return false;
  const relay = registry.relays[relayId];
  if (!relay) return false;
  relay.mru = [{ model, at }, ...(relay.mru ?? []).filter((e) => e.model !== model)].slice(0, MRU_LIMIT);
  relay.lastModel = model;
  relay.updatedAt = at;
  return true;
}

/** 记录被替换掉的默认模型，供 `pmh use -` 回退。 */
export function recordDefaultHistory(registry, { provider, model = null }, { at = now() } = {}) {
  if (!provider) return false;
  registry.history = [
    { provider, model: model ?? null, at },
    ...(registry.history ?? []).filter((e) => !(e.provider === provider && (e.model ?? null) === (model ?? null))),
  ].slice(0, HISTORY_LIMIT);
  return true;
}

/** 取出最近一条历史（出栈），由调用方校验后使用。 */
export function takeDefaultHistory(registry) {
  return (registry.history ?? []).shift() ?? null;
}

/** 跨站最近使用，按时间倒序。 */
export function recentModels(registry, { limit = 10 } = {}) {
  const rows = [];
  for (const relay of Object.values(registry.relays)) {
    for (const entry of relay.mru ?? []) rows.push({ provider: relay.id, model: entry.model, at: entry.at });
  }
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

// ---- 元数据来源 ----

export function recordMetaSources(registry, relayId, sources, { syncedAt = now() } = {}) {
  const relay = registry.relays[relayId];
  if (!relay) return;
  relay.metaSources = { ...relay.metaSources, ...sources };
  relay.lastSyncedAt = syncedAt;
  relay.updatedAt = syncedAt;
}

// ---- 设置 ----

export function setWidgetMode(registry, mode) {
  if (!WIDGET_MODES.includes(mode)) throw new Error(`widget 模式只能是 ${WIDGET_MODES.join(" / ")}`);
  registry.settings.widget = mode;
  return mode;
}
