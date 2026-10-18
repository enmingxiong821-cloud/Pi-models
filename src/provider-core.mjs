// 站点（provider）写入语义：只做校验与落盘，不依赖终端交互。
// CLI 的 cmdAdd 负责询问/重试，桌面端通过这里的 plan/apply 复用同一套规则。
import path from "node:path";
import {
  buildModelList, credentialOf, loadAuth, loadModels, loadRegistryState, normalizeProviderName,
} from "./commands.mjs";
import { keyAliasesOf } from "./keyring.mjs";
import { API_KINDS, baseUrlFor, fetchModels } from "./relay.mjs";
import { loadRegistry, saveRegistry } from "./registry.mjs";
import { readAutoConfig } from "../extensions/auto-router/router.mjs";
import { readJson, rootOf, writeJson } from "./util.mjs";

const MAX_URL = 2048;
const MAX_NAME = 120;
const MAX_KEY = 512;
const CONTROL = /[\u0000-\u001f\u007f]/;

export { normalizeProviderName };

export function validateBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("缺少站点地址");
  if (text.length > MAX_URL) throw new Error("站点地址过长");
  if (CONTROL.test(text)) throw new Error("站点地址包含控制字符");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`站点地址不是合法 URL：${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("站点地址只支持 http/https");
  if (url.username || url.password) throw new Error("站点地址不能内嵌账号密码");
  if (!url.hostname) throw new Error("站点地址缺少主机名");
  return url.toString().replace(/\/+$/, "");
}

export function validateDisplayName(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  if (text.length > MAX_NAME) throw new Error(`站点名称不能超过 ${MAX_NAME} 个字符`);
  if (CONTROL.test(text)) throw new Error("站点名称包含控制字符");
  return text;
}

export function validateKey(value) {
  const text = String(value ?? "");
  if (!text) return null;
  if (text.length > MAX_KEY) throw new Error(`Key 不能超过 ${MAX_KEY} 个字符`);
  if (CONTROL.test(text)) throw new Error("Key 包含控制字符");
  return text.trim();
}

function normalizeApi(api) {
  const value = String(api ?? "openai-completions");
  if (!API_KINDS.includes(value)) throw new Error(`不支持的 API：${value}`);
  return value;
}

function providerOfState(models, id) {
  return Object.hasOwn(models.providers, id) ? models.providers[id] : null;
}

/**
 * 生成站点写入计划，不落盘。
 * 返回的 plan 不含 Key；Key 由调用方单独传给 applyProviderPlan。
 */
export async function planProvider(ctx, input = {}) {
  const id = normalizeProviderName(input.provider);
  const baseUrl = validateBaseUrl(input.baseUrl);
  const root = rootOf(baseUrl);
  const api = normalizeApi(input.api);
  const models = loadModels(ctx);
  const auth = loadAuth(ctx);
  const existing = providerOfState(models, id);
  const created = !existing;
  const reuseKey = input.reuseKey === true;

  const oldRoot = existing?.baseUrl ? rootOf(existing.baseUrl) : null;
  if (!created && oldRoot && oldRoot !== root && !reuseKey && !input.key) {
    const hasCredential = Boolean(auth[id]?.key || existing?.apiKey);
    if (hasCredential) {
      throw new Error(`“${id}”的地址将从 ${oldRoot} 改为 ${root}；为避免把旧 Key 发给新站，请同时提交新 Key，或确认复用旧 Key。`);
    }
  }

  const key = validateKey(input.key);
  let ids = [];
  let items = [];
  let discovery = "skipped";
  if (input.discover !== false) {
    try {
      const res = await fetchModels({ root, api, key });
      if (res.ok && res.ids.length) {
        ids = res.ids;
        items = res.items ?? [];
        discovery = "ok";
      } else {
        discovery = `failed:HTTP ${res.status}`;
      }
    } catch (err) {
      discovery = `failed:${err.message}`;
    }
    if (!ids.length && created && !existing) {
      throw new Error(`没有读到这个站点的模型列表（${discovery}）。检查地址/Key，或关闭“探测模型”后手动添加。`);
    }
  }

  const previous = Object.fromEntries((existing?.models ?? []).map((m) => [m.id, m]));
  const { entries } = ids.length
    ? buildModelList(ids, {
        ctx,
        providerApi: api,
        providerBaseUrl: baseUrlFor(root, api),
        rules: [],
        costMode: "official",
        costMultiplier: 1,
        previous,
        upstreamItems: items,
      })
    : { entries: [] };

  const provider = {
    ...(existing ?? {}),
    name: validateDisplayName(input.name, existing?.name ?? id),
    baseUrl: baseUrlFor(root, api),
    api,
  };
  if (entries.length) provider.models = entries;
  else if (!existing) provider.models = existing?.models ?? [];

  return {
    id,
    created,
    provider,
    root,
    discovery,
    modelCount: entries.length || (existing?.models?.length ?? 0),
    reusedExistingModels: !entries.length && Boolean(existing?.models?.length),
  };
}

/** 落盘 plan；Key 只写 auth.json，不生成含明文的备份。 */
export function applyProviderPlan(ctx, plan, { key = null, registryBackup = false } = {}) {
  if (!plan?.id || !plan.provider) throw new Error("写入计划无效");
  const models = loadModels(ctx);
  models.providers[plan.id] = plan.provider;
  const modelsBackup = writeJson(ctx.paths.models, models);

  let keyWritten = false;
  if (key) {
    const auth = loadAuth(ctx);
    const current = auth[plan.id]?.key;
    if (typeof current === "string" && current && current !== key) {
      const defaultSlot = `${plan.id}@default`;
      if (!auth[defaultSlot]) auth[defaultSlot] = { type: "api_key", key: current };
    }
    auth[plan.id] = { ...(auth[plan.id] ?? {}), type: "api_key", key };
    writeJson(ctx.paths.auth, auth, { backup: false, mode: 0o600 });
    keyWritten = true;
  }

  const { registry, changed } = loadRegistryState(ctx);
  if (changed || !registry.relays[plan.id]) saveRegistry(ctx, registry, { backup: registryBackup });
  return { id: plan.id, created: plan.created, modelCount: plan.modelCount, modelsBackup, keyWritten };
}

export function credentialInfo(ctx, id, { models, auth, registry } = {}) {
  const m = models ?? loadModels(ctx);
  const a = auth ?? loadAuth(ctx);
  const reg = registry ?? loadRegistryState(ctx, { models: m, auth: a }).registry;
  const cred = credentialOf(ctx, id, { models: m, auth: a });
  const aliases = keyAliasesOf(a, id).map((entry) => entry.alias);
  const activeAlias = reg.relays?.[id]?.activeKey ?? aliases[0] ?? null;
  let source = cred.kind;
  let configured = false;
  if (a[id]?.key) {
    configured = true;
    source = "auth.json";
  } else if (typeof m.providers?.[id]?.apiKey === "string" && m.providers[id].apiKey) {
    const raw = m.providers[id].apiKey;
    if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(raw)) {
      const name = raw.replace(/[{}$]/g, "");
      configured = Boolean(process.env[name]);
      source = configured ? `环境变量 ${name}` : `环境变量 ${name}（未设置）`;
    } else if (raw.startsWith("!")) {
      configured = true;
      source = "命令引用";
    } else {
      configured = true;
      source = "models.json（明文）";
    }
  }
  return { configured, source, alias: activeAlias, aliases };
}

export function listProviderIds(ctx) {
  const models = loadModels(ctx);
  return Object.keys(models.providers);
}

export function setProviderKey(ctx, id, value) {
  const provider = normalizeProviderName(id);
  const models = loadModels(ctx);
  if (!Object.hasOwn(models.providers, provider)) throw new Error(`没有名为“${provider}”的站点`);
  const key = validateKey(value);
  if (!key) throw new Error("Key 不能为空");
  const auth = loadAuth(ctx);
  const current = auth[provider]?.key;
  if (typeof current === "string" && current && current !== key) {
    const slot = `${provider}@default`;
    if (!auth[slot]) auth[slot] = { type: "api_key", key: current };
  }
  auth[provider] = { ...(auth[provider] ?? {}), type: "api_key", key };
  writeJson(ctx.paths.auth, auth, { backup: false, mode: 0o600 });
  const { registry } = loadRegistryState(ctx, { models, auth });
  if (registry.relays[provider]) {
    registry.relays[provider].activeKey = "default";
    saveRegistry(ctx, registry, { backup: false });
  }
  return credentialInfo(ctx, provider, { models, auth, registry });
}

export function clearProviderKey(ctx, id) {
  const provider = normalizeProviderName(id);
  const models = loadModels(ctx);
  if (!Object.hasOwn(models.providers, provider)) throw new Error(`没有名为“${provider}”的站点`);
  const auth = loadAuth(ctx);
  let removed = 0;
  if (auth[provider]) {
    delete auth[provider];
    removed += 1;
  }
  for (const name of Object.keys(auth)) {
    if (name.startsWith(`${provider}@`)) {
      delete auth[name];
      removed += 1;
    }
  }
  if (removed) writeJson(ctx.paths.auth, auth, { backup: false, mode: 0o600 });
  const { registry } = loadRegistryState(ctx, { models, auth });
  if (registry.relays[provider]) {
    registry.relays[provider].keyAliases = [];
    registry.relays[provider].activeKey = null;
    saveRegistry(ctx, registry, { backup: false });
  }
  return { removed, remaining: credentialInfo(ctx, provider, { models, auth, registry }) };
}

function autoReferences(config, id) {
  const list = [];
  for (const [tier, spec] of Object.entries(config?.tiers ?? {})) {
    if (spec?.provider === id) list.push(`档位 ${tier}`);
  }
  for (const [project, spec] of Object.entries(config?.projects ?? {})) {
    const value = typeof spec === "string" ? spec : spec?.tier;
    if (typeof spec === "object" && spec?.provider === id) list.push(`项目 ${project}`);
    if (value && !["cheap", "standard", "strong"].includes(value)) list.push(`项目 ${project}`);
  }
  return list;
}

export function deleteProvider(ctx, id, { confirm, force = false } = {}) {
  const provider = normalizeProviderName(id);
  if (confirm !== provider) throw new Error(`请输入站点名“${provider}”确认删除`);
  const models = loadModels(ctx);
  if (!Object.hasOwn(models.providers, provider)) throw new Error(`没有名为“${provider}”的站点`);

  const settings = readJson(ctx.paths.settings, {}) ?? {};
  if (settings.defaultProvider === provider && !force) {
    throw new Error(`“${provider}”是当前默认站点；确认删除请允许清理默认值`);
  }
  const auto = readAutoConfig(ctx.agentDir);
  const refs = autoReferences(auto, provider);
  if (refs.length && !force) throw new Error(`“${provider}”仍被自动路由引用（${refs.join("、")}）`);

  delete models.providers[provider];
  const modelsBackup = writeJson(ctx.paths.models, models);

  const auth = loadAuth(ctx);
  let keysRemoved = 0;
  if (auth[provider]) {
    delete auth[provider];
    keysRemoved += 1;
  }
  for (const name of Object.keys(auth)) {
    if (name.startsWith(`${provider}@`)) {
      delete auth[name];
      keysRemoved += 1;
    }
  }
  if (keysRemoved) writeJson(ctx.paths.auth, auth, { backup: false, mode: 0o600 });

  let settingsChanged = false;
  if (settings.defaultProvider === provider) {
    delete settings.defaultProvider;
    delete settings.defaultModel;
    settingsChanged = true;
  }
  if (Array.isArray(settings.enabledModels)) {
    const kept = settings.enabledModels.filter((entry) => {
      const text = String(entry);
      return text !== provider && !text.startsWith(`${provider}/`);
    });
    if (kept.length !== settings.enabledModels.length) {
      if (kept.length) settings.enabledModels = kept;
      else delete settings.enabledModels;
      settingsChanged = true;
    }
  }
  if (settings.modelThinkingLevels && typeof settings.modelThinkingLevels === "object") {
    const kept = Object.fromEntries(
      Object.entries(settings.modelThinkingLevels).filter(([modelKey]) => !modelKey.startsWith(`${provider}/`)),
    );
    if (Object.keys(kept).length !== Object.keys(settings.modelThinkingLevels).length) {
      if (Object.keys(kept).length) settings.modelThinkingLevels = kept;
      else delete settings.modelThinkingLevels;
      settingsChanged = true;
    }
  }
  const settingsBackup = settingsChanged ? writeJson(ctx.paths.settings, settings) : null;

  const { registry } = loadRegistryState(ctx);
  delete registry.relays[provider];
  registry.history = (registry.history ?? []).filter((entry) => entry.provider !== provider);
  saveRegistry(ctx, registry, { backup: false });

  return {
    id: provider,
    keysRemoved,
    modelsBackup: modelsBackup ? path.basename(modelsBackup) : null,
    settingsBackup: settingsBackup ? path.basename(settingsBackup) : null,
  };
}

/** 供测试与诊断：注册表是否存在该站点（不创建文件）。 */
export function hasRelay(ctx, id) {
  const { registry } = loadRegistry(ctx);
  return Boolean(registry.relays[id]);
}
