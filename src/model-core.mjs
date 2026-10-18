// 单模型写入语义：桌面端与 CLI 共用 modelPatch 的字段规则。
import path from "node:path";
import { buildModelEntry } from "./catalog.mjs";
import { loadModels, normalizeProviderName } from "./commands.mjs";
import { loadBuiltinProviders, providerHasContent } from "./native.mjs";
import { baseUrlFor } from "./relay.mjs";
import { writeJson } from "./util.mjs";

const MAX_MODEL = 128;
const MAX_NAME = 200;
const MAX_COUNT = 10_000_000;
const MAX_COST = 100_000;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PATCH_FIELDS = new Set(["name", "contextWindow", "maxTokens", "reasoning", "image", "input", "cost"]);
const COST_FIELDS = new Set(["input", "output", "cacheRead", "cacheWrite"]);

export function validateModelId(value) {
  const id = String(value ?? "").trim();
  if (!id) throw new Error("缺少模型 id");
  if (id.length > MAX_MODEL) throw new Error(`模型 id 不能超过 ${MAX_MODEL} 个字符`);
  if (CONTROL.test(id)) throw new Error("模型 id 包含控制字符");
  if (id.includes("#")) throw new Error("模型 id 不能包含 #");
  return id;
}

function numeric(value, label, { max = MAX_COUNT, zero = false } = {}) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (!Number.isFinite(number)) throw new Error(`${label}需要是数字`);
  if (zero ? number < 0 : number <= 0) throw new Error(`${label}必须${zero ? "大于等于 0" : "大于 0"}`);
  if (number > max) throw new Error(`${label}过大`);
  return number;
}

function normalizeInput(value) {
  const list = Array.isArray(value) ? value : [];
  const allowed = list.filter((item) => item === "text" || item === "image");
  if (!allowed.includes("text")) allowed.unshift("text");
  return [...new Set(allowed)];
}

/** 把桌面表单的 patch 收敛成 models.json 允许的字段。 */
export function normalizeModelPatch(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("模型参数无效");
  for (const key of Object.keys(raw)) {
    if (!PATCH_FIELDS.has(key)) throw new Error(`不支持的模型字段：${key}`);
  }
  const patch = {};
  if (raw.name !== undefined) {
    const name = String(raw.name ?? "").trim();
    if (name.length > MAX_NAME) throw new Error(`显示名不能超过 ${MAX_NAME} 个字符`);
    if (CONTROL.test(name)) throw new Error("显示名包含控制字符");
    if (name) patch.name = name;
  }
  if (raw.contextWindow !== undefined) patch.contextWindow = numeric(raw.contextWindow, "上下文窗口");
  if (raw.maxTokens !== undefined) patch.maxTokens = numeric(raw.maxTokens, "最大输出");
  if (raw.reasoning !== undefined) {
    if (typeof raw.reasoning !== "boolean") throw new Error("reasoning 需要是布尔值");
    patch.reasoning = raw.reasoning;
  }
  if (raw.image !== undefined) {
    if (typeof raw.image !== "boolean") throw new Error("image 需要是布尔值");
    patch.input = raw.image ? ["text", "image"] : ["text"];
  }
  if (raw.input !== undefined) {
    if (!Array.isArray(raw.input) || raw.input.some((item) => item !== "text" && item !== "image")) {
      throw new Error("input 只能包含 text / image");
    }
    patch.input = normalizeInput(raw.input);
  }
  if (raw.cost !== undefined) {
    if (!raw.cost || typeof raw.cost !== "object" || Array.isArray(raw.cost)) throw new Error("cost 参数无效");
    const cost = {};
    for (const [key, value] of Object.entries(raw.cost)) {
      if (!COST_FIELDS.has(key)) throw new Error(`不支持的计价字段：${key}`);
      if (value === "" || value == null) continue;
      cost[key] = numeric(value, `价格 ${key}`, { max: MAX_COST, zero: true });
    }
    if (Object.keys(cost).length) patch.cost = cost;
  }
  return patch;
}

function mergeEntry(base, patch) {
  const entry = { ...base, ...patch };
  if (patch.cost) entry.cost = { ...(base.cost ?? {}), ...patch.cost };
  return entry;
}

function providerState(ctx, provider) {
  const id = normalizeProviderName(provider);
  const models = loadModels(ctx);
  const config = Object.hasOwn(models.providers, id) ? models.providers[id] : null;
  const builtin = loadBuiltinProviders(ctx.agentDir).providers.get(id) ?? null;
  if (!config && !builtin) throw new Error(`不认识站点“${id}”，请先添加站点`);
  return { id, models, config, builtin };
}

export function listModels(ctx, provider) {
  const { id, config, builtin } = providerState(ctx, provider);
  const overrides = config?.modelOverrides ?? {};
  const rows = [];
  const seen = new Set();
  for (const model of config?.models ?? []) {
    seen.add(model.id);
    const override = Object.hasOwn(overrides, model.id) ? overrides[model.id] : null;
    rows.push({ ...model, ...(override ?? {}), id: model.id, source: override ? "override" : "models" });
  }
  for (const [modelId, override] of Object.entries(overrides)) {
    if (!seen.has(modelId)) rows.push({ id: modelId, ...override, source: "override" });
  }
  return {
    provider: id,
    builtin: builtin ? { name: builtin.name, baseUrl: builtin.baseUrl, api: builtin.api } : null,
    models: rows,
  };
}

/**
 * mode=add 写 models 条目（新增或替换）；
 * mode=override 只写 modelOverrides。
 */
export function applyModelChange(ctx, { provider, model, mode = "add", patch = {} } = {}) {
  const id = normalizeProviderName(provider);
  const modelId = validateModelId(model);
  const clean = normalizeModelPatch(patch);
  if (mode !== "add" && mode !== "override") throw new Error("模式只能是 add / override");
  if (mode === "override" && !Object.keys(clean).length) {
    throw new Error("至少要修改一个字段");
  }
  const { models, config, builtin } = providerState(ctx, id);
  const next = { ...(config ?? {}) };
  let entry;
  let created = false;

  if (mode === "override") {
    next.modelOverrides = { ...(next.modelOverrides ?? {}) };
    next.modelOverrides[modelId] = { ...(next.modelOverrides[modelId] ?? {}), ...clean };
    entry = { id: modelId, ...next.modelOverrides[modelId] };
  } else {
    const providerApi = next.api ?? builtin?.api ?? "openai-completions";
    const providerBase = next.baseUrl ?? builtin?.baseUrl;
    if (!providerBase) throw new Error(`无法确定 ${id} 的 baseUrl，请先补全站点地址`);
    const built = buildModelEntry(modelId, {
      catalog: ctx.catalog,
      providerApi,
      providerBaseUrl: providerBase,
      modelApi: providerApi,
      modelBaseUrl: providerBase,
      costMode: "official",
      costMultiplier: 1,
    });
    const previous = new Map((next.models ?? []).map((item) => [item.id, item]));
    created = !previous.has(modelId);
    entry = mergeEntry(previous.get(modelId) ?? built.entry, clean);
    next.models = [...(next.models ?? []).filter((item) => item?.id !== modelId), entry];
  }

  if (providerHasContent(next)) models.providers[id] = next;
  else delete models.providers[id];
  const backup = writeJson(ctx.paths.models, models);
  return { provider: id, model: modelId, mode, created, entry, backup: backup ? path.basename(backup) : null };
}

export function removeModel(ctx, { provider, model } = {}) {
  const id = normalizeProviderName(provider);
  const modelId = validateModelId(model);
  const { models, config } = providerState(ctx, id);
  if (!config) throw new Error(`models.json 里没有“${id}”的可删除条目`);
  const next = { ...config };
  let removed = false;
  if (next.modelOverrides && Object.hasOwn(next.modelOverrides, modelId)) {
    delete next.modelOverrides[modelId];
    removed = true;
  }
  const before = next.models?.length ?? 0;
  next.models = (next.models ?? []).filter((item) => item?.id !== modelId);
  if ((next.models?.length ?? 0) !== before) removed = true;
  if (!removed) throw new Error(`没有找到 ${id}#${modelId}`);
  if (!next.models?.length) delete next.models;
  if (next.modelOverrides && !Object.keys(next.modelOverrides).length) delete next.modelOverrides;
  if (providerHasContent(next)) models.providers[id] = next;
  else delete models.providers[id];
  const backup = writeJson(ctx.paths.models, models);
  return { provider: id, model: modelId, removed: true, backup: backup ? path.basename(backup) : null };
}

/** 成本等级：input + output 的加权值（USD / 百万 token）。 */
export function costLevel(cost) {
  const input = Number(cost?.input);
  const output = Number(cost?.output);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  const value = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
  if (value <= 1) return { level: "low", label: "低", value };
  if (value <= 10) return { level: "medium", label: "中", value };
  return { level: "high", label: "高", value };
}
