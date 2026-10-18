// 思考等级：全局默认 + 模型级覆盖，写在 settings.json。
import { loadSettings, normalizeProviderName } from "./commands.mjs";
import { validateModelId } from "./model-core.mjs";
import { writeJson } from "./util.mjs";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const THINKING_LABELS = {
  off: "关闭", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高",
};

export function normalizeThinkingLevel(value, { allowInherit = false } = {}) {
  if (value === null || value === undefined || value === "" || value === "inherit") {
    if (allowInherit) return null;
    throw new Error("缺少思考等级");
  }
  const level = String(value);
  if (!THINKING_LEVELS.includes(level)) {
    throw new Error(`思考等级只能是 ${THINKING_LEVELS.join(" / ")}`);
  }
  return level;
}

export function modelKey(provider, model) {
  const id = normalizeProviderName(provider);
  const modelId = validateModelId(model);
  return `${id}/${modelId}`;
}

export function getThinkingState(ctx, provider = null, model = null) {
  const settings = loadSettings(ctx);
  const global = THINKING_LEVELS.includes(settings.defaultThinkingLevel) ? settings.defaultThinkingLevel : null;
  const levels = settings.modelThinkingLevels && typeof settings.modelThinkingLevels === "object"
    ? settings.modelThinkingLevels
    : {};
  let key = null;
  let pinned = null;
  if (provider && model) {
    key = modelKey(provider, model);
    pinned = THINKING_LEVELS.includes(levels[key]) ? levels[key] : null;
  }
  const effective = pinned ?? global;
  return {
    levels: THINKING_LEVELS,
    labels: THINKING_LABELS,
    global,
    key,
    pinned,
    effective,
    source: pinned ? "model" : global ? "global" : "default",
  };
}

export function setGlobalThinking(ctx, level) {
  const value = normalizeThinkingLevel(level, { allowInherit: true });
  const settings = loadSettings(ctx);
  if (value) settings.defaultThinkingLevel = value;
  else delete settings.defaultThinkingLevel;
  const backup = writeJson(ctx.paths.settings, settings);
  return { backup: backup ?? null, state: getThinkingState(ctx) };
}

export function setModelThinking(ctx, provider, model, level) {
  const key = modelKey(provider, model);
  const value = normalizeThinkingLevel(level, { allowInherit: true });
  const settings = loadSettings(ctx);
  const levels = settings.modelThinkingLevels && typeof settings.modelThinkingLevels === "object"
    ? { ...settings.modelThinkingLevels }
    : {};
  if (value) levels[key] = value;
  else delete levels[key];
  if (Object.keys(levels).length) settings.modelThinkingLevels = levels;
  else delete settings.modelThinkingLevels;
  const backup = writeJson(ctx.paths.settings, settings);
  return { backup: backup ?? null, state: getThinkingState(ctx, provider, model) };
}
