// 自动路由的读写与预览。桌面端只拿脱敏 DTO；配置写入走 router.mjs 的原子写。
import path from "node:path";
import { loadModels } from "./commands.mjs";
import {
  AUTO_MODEL, AUTO_PROVIDER, TIERS, autoConfigPath, classifyTask, formatTierSpec, parseTierSpec,
  readAutoConfig, readModelThinkingLevel, resolveProjectRule, writeAutoConfig,
} from "../extensions/auto-router/router.mjs";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PROJECT_BAD = /[*?[\]{}]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const EDITABLE = new Set([
  "enabled", "pinned", "tiers", "thresholds", "upgradeOnRetry", "useModelThinking", "projects",
]);

const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);

function modelCatalog(ctx) {
  const models = loadModels(ctx);
  const rows = [];
  for (const [provider, config] of Object.entries(models.providers ?? {})) {
    const ids = new Set([
      ...(Array.isArray(config.models) ? config.models.map((model) => model.id) : []),
      ...Object.keys(config.modelOverrides ?? {}),
    ]);
    for (const id of ids) {
      if (typeof id !== "string" || !id) continue;
      rows.push({ provider, model: id, spec: `${provider}#${id}` });
    }
  }
  rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  return rows;
}

function specProblem(spec, catalog) {
  if (!spec) return null;
  if (spec.provider === AUTO_PROVIDER && spec.model === AUTO_MODEL) {
    return "不能把 pmh/auto 自己设成档位模型";
  }
  const exists = catalog.some((row) => row.provider === spec.provider && row.model === spec.model);
  return exists ? null : `模型 ${formatTierSpec(spec)} 不在 models.json 中`;
}

function validateConfig(config, catalog) {
  const issues = [];
  for (const tier of TIERS) {
    const spec = config.tiers?.[tier];
    const problem = specProblem(spec, catalog);
    if (problem) issues.push({ level: "error", message: `${tier} 档：${problem}` });
  }
  const { cheap, strong } = config.thresholds ?? {};
  if (!(Number.isFinite(cheap) && Number.isFinite(strong) && cheap >= 0 && strong <= 1 && cheap < strong)) {
    issues.push({ level: "error", message: "阈值需满足 0 ≤ cheap < strong ≤ 1" });
  }
  if (config.pinned && !config.tiers?.[config.pinned]) {
    issues.push({ level: "warn", message: `固定档位 ${config.pinned} 未配置模型，会自动向邻近档位回退` });
  }
  for (const [key, rule] of Object.entries(config.projects ?? {})) {
    if (rule?.pinned && !config.tiers?.[rule.pinned]) {
      issues.push({ level: "warn", message: `项目 ${key} 固定到未配置的 ${rule.pinned} 档，会向邻近档位回退` });
    }
  }
  if (!config.tiers?.standard) {
    issues.push({ level: "warn", message: "standard 档未配置，自动路由的效果会受限" });
  }
  return { ok: !issues.some((issue) => issue.level === "error"), issues };
}

export function getAutoState(ctx) {
  const config = readAutoConfig(ctx.agentDir);
  const catalog = modelCatalog(ctx);
  return {
    version: config.version,
    enabled: config.enabled,
    pinned: config.pinned,
    tiers: config.tiers,
    thresholds: config.thresholds,
    upgradeOnRetry: config.upgradeOnRetry,
    useModelThinking: config.useModelThinking,
    projects: config.projects,
    path: autoConfigPath(ctx.agentDir),
    models: catalog,
    validation: validateConfig(config, catalog),
  };
}

function strictTier(value, label, catalog) {
  if (value === null || value === undefined || value === "") return null;
  let spec;
  if (typeof value === "string") spec = parseTierSpec(value);
  else if (isObj(value)) spec = parseTierSpec(`${value.provider ?? ""}#${value.model ?? ""}`);
  else throw new Error(`${label}格式无效`);
  const problem = specProblem(spec, catalog);
  if (problem) throw new Error(`${label}：${problem}`);
  return { provider: spec.provider, model: spec.model };
}

function normalizeProjectKey(value) {
  if (typeof value !== "string") throw new Error("项目名无效");
  const key = value.trim();
  if (!key) throw new Error("项目名不能为空");
  if (key.length > 260) throw new Error("项目名过长");
  if (CONTROL.test(key)) throw new Error("项目名包含控制字符");
  if (UNSAFE_KEYS.has(key)) throw new Error("项目名无效");
  if (PROJECT_BAD.test(key)) throw new Error("项目名不支持通配符或正则");
  if (/(^|[\\/])\.\.([\\/]|$)/.test(key)) throw new Error("项目名不能包含 ..");
  if (!path.isAbsolute(key) && /[\\/]/.test(key)) throw new Error("请填写目录名或绝对路径");
  return key;
}

function normalizeProjectsPatch(raw) {
  if (!isObj(raw)) throw new Error("项目规则格式无效");
  const out = {};
  for (const [rawKey, entry] of Object.entries(raw)) {
    const key = normalizeProjectKey(rawKey);
    if (entry === null || entry === undefined || entry === "") continue;
    let pinned = null;
    if (typeof entry === "string") {
      if (!TIERS.includes(entry)) throw new Error(`项目 ${key} 的档位无效`);
      pinned = entry;
    } else if (isObj(entry)) {
      if (entry.pinned === null || entry.pinned === undefined || entry.pinned === "") continue;
      if (!TIERS.includes(entry.pinned)) throw new Error(`项目 ${key} 的档位无效`);
      pinned = entry.pinned;
    } else {
      throw new Error(`项目 ${key} 的规则无效`);
    }
    out[key] = { pinned };
  }
  return out;
}

export function updateAuto(ctx, patch = {}) {
  if (!isObj(patch)) throw new Error("自动路由参数无效");
  for (const key of Object.keys(patch)) {
    if (!EDITABLE.has(key)) throw new Error(`不支持的配置项：${key}`);
  }
  const config = readAutoConfig(ctx.agentDir);
  const catalog = modelCatalog(ctx);
  const next = {
    ...config,
    tiers: { ...config.tiers },
    thresholds: { ...config.thresholds },
    projects: { ...config.projects },
  };

  if ("enabled" in patch) {
    if (typeof patch.enabled !== "boolean") throw new Error("enabled 需要是布尔值");
    next.enabled = patch.enabled;
  }
  if ("upgradeOnRetry" in patch) {
    if (typeof patch.upgradeOnRetry !== "boolean") throw new Error("upgradeOnRetry 需要是布尔值");
    next.upgradeOnRetry = patch.upgradeOnRetry;
  }
  if ("useModelThinking" in patch) {
    if (typeof patch.useModelThinking !== "boolean") throw new Error("useModelThinking 需要是布尔值");
    next.useModelThinking = patch.useModelThinking;
  }
  if ("pinned" in patch) {
    const value = patch.pinned;
    if (value === null || value === undefined || value === "" || value === "off" || value === "auto") {
      next.pinned = null;
    } else if (TIERS.includes(value)) {
      next.pinned = value;
    } else {
      throw new Error(`固定档位只能是 ${TIERS.join(" / ")} 或 null`);
    }
  }
  if ("thresholds" in patch) {
    if (!isObj(patch.thresholds)) throw new Error("阈值格式无效");
    for (const key of Object.keys(patch.thresholds)) {
      if (key !== "cheap" && key !== "strong") throw new Error(`不支持的阈值项：${key}`);
    }
    const cheap = patch.thresholds.cheap === undefined ? next.thresholds.cheap : Number(patch.thresholds.cheap);
    const strong = patch.thresholds.strong === undefined ? next.thresholds.strong : Number(patch.thresholds.strong);
    if (!Number.isFinite(cheap) || !Number.isFinite(strong) || cheap < 0 || strong > 1 || cheap >= strong) {
      throw new Error("阈值需满足 0 ≤ cheap < strong ≤ 1");
    }
    next.thresholds = { cheap, strong };
  }
  if ("tiers" in patch) {
    if (!isObj(patch.tiers)) throw new Error("档位格式无效");
    for (const key of Object.keys(patch.tiers)) {
      if (!TIERS.includes(key)) throw new Error(`未知档位：${key}`);
    }
    for (const tier of TIERS) {
      if (!(tier in patch.tiers)) continue;
      next.tiers[tier] = strictTier(patch.tiers[tier], `${tier} 档`, catalog);
    }
  }
  if ("projects" in patch) {
    next.projects = normalizeProjectsPatch(patch.projects);
  }

  const draft = { ...next, version: 2 };
  const validation = validateConfig(draft, catalog);
  if (!validation.ok) {
    const first = validation.issues.find((issue) => issue.level === "error");
    throw new Error(first?.message ?? "自动路由配置无效");
  }
  writeAutoConfig(draft, ctx.agentDir);
  return getAutoState(ctx);
}

export function previewRoute(ctx, { text = "", project = null } = {}) {
  const config = readAutoConfig(ctx.agentDir);
  const catalog = modelCatalog(ctx);
  const source = String(text ?? "");
  if (source.length > 4000) throw new Error("任务描述过长");
  const result = classifyTask(source, { thresholds: config.thresholds });
  const projectRule = project ? resolveProjectRule(config, String(project)) : null;
  const pinned = projectRule?.pinned ?? config.pinned;
  const pinnedSource = projectRule ? "project" : config.pinned ? "global" : null;
  const effectiveTier = config.enabled ? (pinned ?? result.tier) : (pinned ?? "standard");
  const spec = config.tiers?.[effectiveTier] ?? null;
  const model = spec ? { provider: spec.provider, model: spec.model } : null;
  const thinking = config.useModelThinking && spec
    ? readModelThinkingLevel(ctx.agentDir, spec.provider, spec.model)
    : null;
  return {
    text: source.slice(0, 500),
    score: result.score,
    tier: result.tier,
    reasons: result.reasons,
    files: result.files,
    textLength: result.textLength,
    enabled: config.enabled,
    effectiveTier,
    pinned,
    pinnedSource,
    projectRule,
    target: spec ? formatTierSpec(spec) : null,
    model,
    thinking,
  };
}
