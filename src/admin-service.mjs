// 桌面端站点/模型/Key/思考等级的安全 DTO。所有返回值都经过白名单，绝不回传 Key。
import { loadAuth, loadModels, loadRegistryState, loadSettings } from "./commands.mjs";
import { costLevel, listModels, normalizeModelPatch, applyModelChange, removeModel } from "./model-core.mjs";
import { getThinkingState, setModelThinking, setGlobalThinking } from "./settings-service.mjs";
import {
  applyProviderPlan, clearProviderKey, credentialInfo, deleteProvider, normalizeProviderName, planProvider, setProviderKey,
} from "./provider-core.mjs";

function modelSummary(model) {
  return {
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow ?? null,
    maxTokens: model.maxTokens ?? null,
    reasoning: Boolean(model.reasoning),
    image: Array.isArray(model.input) && model.input.includes("image"),
    cost: model.cost && typeof model.cost === "object"
      ? {
          input: model.cost.input ?? null,
          output: model.cost.output ?? null,
          cacheRead: model.cost.cacheRead ?? null,
          cacheWrite: model.cost.cacheWrite ?? null,
        }
      : null,
    costTier: costLevel(model.cost),
    source: model.source ?? "models",
    current: false,
  };
}

function providerRows(ctx) {
  const models = loadModels(ctx);
  const auth = loadAuth(ctx);
  const settings = loadSettings(ctx);
  const { registry } = loadRegistryState(ctx, { models, auth });
  const rows = [];
  for (const [id, config] of Object.entries(models.providers)) {
    const relay = registry.relays[id];
    const credential = credentialInfo(ctx, id, { models, auth, registry });
    rows.push({
      id,
      name: config.name ?? id,
      baseUrl: config.baseUrl ?? null,
      api: config.api ?? "openai-completions",
      modelCount: (config.models ?? []).length,
      overrideCount: Object.keys(config.modelOverrides ?? {}).length,
      credential,
      group: relay?.group ?? null,
      isDefault: settings.defaultProvider === id,
      favoriteCount: (relay?.favorites ?? []).length,
    });
  }
  rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id));
  return { rows, models, auth, settings, registry };
}

export function listProviders(ctx) {
  const { rows } = providerRows(ctx);
  return { providers: rows };
}

function currentDefault(settings) {
  return settings.defaultProvider && settings.defaultModel
    ? { provider: settings.defaultProvider, model: settings.defaultModel }
    : null;
}

export function getProviderDetail(ctx, provider) {
  const id = normalizeProviderName(provider);
  const { rows, models, auth, settings, registry } = providerRows(ctx);
  const row = rows.find((entry) => entry.id === id);
  if (!row) throw new Error(`没有名为“${id}”的站点`);
  const config = models.providers[id];
  const current = currentDefault(settings);
  const listed = listModels(ctx, id).models.map((model) => ({
    ...modelSummary(model),
    provider: id,
    current: current?.provider === id && current?.model === model.id,
    override: model.source === "override",
  }));
  return {
    provider: {
      ...row,
      aliases: credentialInfo(ctx, id, { models, auth, registry }).aliases,
      keyAliases: row.credential.aliases,
      group: registry.relays[id]?.group ?? null,
      modelOverrides: Object.keys(config?.modelOverrides ?? {}),
    },
    models: listed,
    current,
  };
}

export async function saveProvider(ctx, input = {}) {
  const plan = await planProvider(ctx, input);
  const key = input.key ? String(input.key) : null;
  const applied = applyProviderPlan(ctx, plan, { key });
  return {
    result: applied,
    discovery: plan.discovery,
    reusedExistingModels: plan.reusedExistingModels,
    detail: getProviderDetail(ctx, plan.id),
  };
}

export function removeProvider(ctx, provider, { confirm, force = false } = {}) {
  const deleted = deleteProvider(ctx, provider, { confirm, force });
  return { result: deleted };
}

export function updateProviderKey(ctx, provider, key) {
  const credential = setProviderKey(ctx, provider, key);
  return { provider: normalizeProviderName(provider), credential };
}

export function purgeProviderKey(ctx, provider, { confirm } = {}) {
  const id = normalizeProviderName(provider);
  if (confirm !== id) throw new Error(`请输入站点名“${id}”确认清除 Key`);
  const result = clearProviderKey(ctx, id);
  return { provider: id, ...result };
}

export function saveModel(ctx, { provider, model, mode = "add", patch = {} } = {}) {
  const clean = normalizeModelPatch(patch);
  const result = applyModelChange(ctx, { provider, model, mode, patch: clean });
  return { result, detail: getProviderDetail(ctx, result.provider) };
}

export function deleteModel(ctx, { provider, model, confirm } = {}) {
  const id = normalizeProviderName(provider);
  const expected = `${id}#${model}`;
  if (confirm !== expected) throw new Error(`请输入“${expected}”确认删除`);
  const result = removeModel(ctx, { provider: id, model });
  return { result, detail: getProviderDetail(ctx, id) };
}

export function getThinking(ctx, { provider = null, model = null } = {}) {
  return getThinkingState(ctx, provider, model);
}

export function setThinking(ctx, { scope = "global", provider = null, model = null, level = null } = {}) {
  if (scope === "global") return { state: setGlobalThinking(ctx, level).state };
  if (scope === "model") {
    if (!provider || !model) throw new Error("缺少模型参数");
    return { state: setModelThinking(ctx, provider, model, level).state };
  }
  throw new Error("思考等级范围只能是 global / model");
}
