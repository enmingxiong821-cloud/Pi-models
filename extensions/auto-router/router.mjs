// 任务难度分类与自动路由配置。CLI（pmh auto）和 pi 扩展（pmh/auto）共用这一份逻辑，
// 保证 `pmh auto explain` 看到的结果和 pi 里实际路由一致。
//
// 设计取舍（依据见 docs/资料/03-同类项目与生态.md 第 4 节）：
// - 只在“新一轮用户输入”时重新分类，工具调用/重试沿用上一轮模型，避免破坏 prompt cache。
// - 误判成本低：分类只影响档位，用户可 /auto pin、/auto off，或直接 /switch 走人。
// - 不猜模型强弱：档位映射由用户显式配置，工具只负责分类和兜底。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TIERS = ["cheap", "standard", "strong"];
export const TIER_LABELS = { cheap: "轻量", standard: "标准", strong: "强力" };
export const AUTO_PROVIDER = "pmh";
export const AUTO_MODEL = "auto";
export const AUTO_EXTENSION_DIR = "pmh-auto";

export function agentDirFromEnv(env = process.env) {
  return env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : path.join(os.homedir(), ".pi", "agent");
}

export function autoConfigPath(agentDir = agentDirFromEnv()) {
  return path.join(agentDir, "extension-settings", "pmh-auto.json");
}

export function defaultAutoConfig() {
  return {
    version: 1,
    enabled: true,
    pinned: null,
    tiers: { cheap: null, standard: null, strong: null },
    thresholds: { cheap: 0.12, strong: 0.5 },
    upgradeOnRetry: true,
  };
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** `provider#model`；也接受 `provider/model`，但模型 id 里带 `/` 时必须用 `#`。 */
export function parseTierSpec(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("缺少 provider#model");
  let provider = "";
  let model = "";
  const hash = raw.indexOf("#");
  if (hash > 0) {
    provider = raw.slice(0, hash);
    model = raw.slice(hash + 1);
  } else {
    const slash = raw.indexOf("/");
    if (slash <= 0) throw new Error(`需要 provider#model 形式，收到：${raw}`);
    provider = raw.slice(0, slash);
    model = raw.slice(slash + 1);
  }
  provider = provider.trim();
  model = model.trim();
  if (!provider || !model) throw new Error(`需要 provider#model 形式，收到：${raw}`);
  return { provider, model };
}

export function formatTierSpec(spec) {
  return spec?.provider && spec?.model ? `${spec.provider}#${spec.model}` : null;
}

/** 容错读取：坏字段回落到默认值，绝不让 pi 启动失败。 */
export function normalizeAutoConfig(raw = {}) {
  const base = defaultAutoConfig();
  if (!isObj(raw)) return base;
  const cfg = {
    version: 1,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    pinned: TIERS.includes(raw.pinned) ? raw.pinned : null,
    tiers: { ...base.tiers },
    thresholds: { ...base.thresholds },
    upgradeOnRetry: typeof raw.upgradeOnRetry === "boolean" ? raw.upgradeOnRetry : base.upgradeOnRetry,
  };
  for (const tier of TIERS) {
    const entry = raw.tiers?.[tier];
    if (typeof entry === "string") {
      try {
        cfg.tiers[tier] = parseTierSpec(entry);
      } catch {
        cfg.tiers[tier] = null;
      }
    } else if (isObj(entry) && typeof entry.provider === "string" && typeof entry.model === "string") {
      cfg.tiers[tier] = { provider: entry.provider, model: entry.model };
    }
  }
  const cheap = Number(raw.thresholds?.cheap);
  const strong = Number(raw.thresholds?.strong);
  if (Number.isFinite(cheap) && cheap >= 0 && cheap <= 1) cfg.thresholds.cheap = cheap;
  if (Number.isFinite(strong) && strong >= 0 && strong <= 1) cfg.thresholds.strong = strong;
  if (cfg.thresholds.cheap >= cfg.thresholds.strong) cfg.thresholds = { ...base.thresholds };
  return cfg;
}

export function readAutoConfig(agentDir = agentDirFromEnv()) {
  try {
    return normalizeAutoConfig(JSON.parse(fs.readFileSync(autoConfigPath(agentDir), "utf8")));
  } catch {
    return defaultAutoConfig();
  }
}

/** 原子写，避免 pi 正在读时看到半截 JSON。配置文件不含密钥。 */
export function writeAutoConfig(config, agentDir = agentDirFromEnv()) {
  const cfg = normalizeAutoConfig(config);
  const file = autoConfigPath(agentDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

export function bumpTier(tier, step = 1) {
  const i = TIERS.indexOf(tier);
  if (i < 0) return "standard";
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, i + step))];
}

export function tierForScore(score, thresholds = defaultAutoConfig().thresholds) {
  if (!Number.isFinite(score)) return "standard";
  if (score >= thresholds.strong) return "strong";
  if (score <= thresholds.cheap) return "cheap";
  return "standard";
}

// 强信号：出现越多越像“值得上强模型”的任务。
const HARD_SIGNALS = [
  { label: "架构/重构", weight: 0.18, re: /架构|重构|重写|迁移|跨模块|整体设计|模块划分|设计模式|整个(项目|仓库|代码库)|全仓|多个模块|redesign|architect\w*|refactor\w*|rewrit\w*|migrat\w*|cross-cutting|whole (repo|project|codebase)/gi },
  { label: "并发/底层", weight: 0.18, re: /并发|死锁|竞态|内存泄漏|线程安全|concurren\w*|deadlock|race condition|memory leak|thread[- ]safe/gi },
  { label: "调试/报错", weight: 0.12, re: /堆栈|调用栈|报错|崩溃|traceback|stack trace|segfault|panic:|exception|crash/gi },
  { label: "测试/构建失败", weight: 0.12, re: /(测试|用例|构建|编译|CI|流水线).{0,8}(失败|挂|红了?|报错)|(test|build|compile|ci).{0,12}(fail\w*|broken|red)/gi },
  { label: "性能/安全", weight: 0.12, re: /性能|优化|安全|漏洞|权限|加密|认证|authoriz\w*|authenticat\w*|performance|optimi[sz]\w*|vulnerab\w*|security/gi },
  { label: "算法/协议", weight: 0.12, re: /算法|协议|复杂度|数据结构|algorithm|protocol|complexity|data structure/gi },
  { label: "实现/设计", weight: 0.08, re: /实现|新增功能|从零|端到端|implement\w*|from scratch|end[- ]to[- ]end|design/gi },
];

// 弱信号：这些任务通常不需要强模型。
const EASY_SIGNALS = [
  { label: "格式化/重命名", weight: -0.14, re: /格式化|排版|重命名|改名|拼写|错别字|缩进|format|lint|rename|typo|indent/gi },
  { label: "翻译/解释", weight: -0.14, re: /翻译|解释|说明一下|是什么意思|translate|explain|what does|meaning of/gi },
  { label: "注释/文档/总结", weight: -0.10, re: /注释|文档|总结|摘要|README|comment|docstring|summari[sz]e|summary|document/gi },
  { label: "单行/小改", weight: -0.10, re: /单行|一行|小改|微调|one[- ]liner|small tweak|quick fix/gi },
];

const IMPERATIVE = /^(请|帮我|帮忙|把|给我|实现|修复|添加|新增|删除|移除|修改|优化|重构|迁移|写|加|补|做|支持)|^\s*(please\s+)?(implement|fix|add|remove|delete|update|change|refactor|migrate|build|write|create|support|make)\b/i;
const FILE_PATH = /(?:[\w.@-]+\/)*[\w.@-]+\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|kt|cs|cpp|cc|c|h|hpp|rb|php|swift|scala|sh|ps1|lua|sql|json|ya?ml|toml|md)\b/gi;

const countMatches = (text, re) => {
  const matches = text.match(re);
  return matches ? matches.length : 0;
};

/**
 * 根据一条用户输入判断任务档位。
 * 返回 { tier, score, reasons, files, textLength }；score 已裁剪到 [0,1]。
 */
export function classifyTask(text, { images = 0, thresholds } = {}) {
  const source = String(text ?? "").trim();
  const limits = thresholds ?? defaultAutoConfig().thresholds;
  if (!source) {
    return { tier: "standard", score: 0.15, reasons: ["空输入"], files: 0, textLength: 0 };
  }

  // 从“标准任务”的基线开始：中性输入落在 standard，只有明确简单/复杂的信号才移动。
  let score = 0.15;
  const reasons = [];
  let files = 0;

  let hardHits = 0;
  for (const signal of HARD_SIGNALS) {
    const n = countMatches(source, signal.re);
    if (!n) continue;
    hardHits += n;
    score += signal.weight * Math.min(n, 2);
    reasons.push(signal.label);
  }
  score = Math.min(score, 0.15 + 0.6);

  for (const signal of EASY_SIGNALS) {
    const n = countMatches(source, signal.re);
    if (!n) continue;
    score += signal.weight * Math.min(n, 2);
    reasons.push(signal.label);
  }

  const paths = new Set((source.match(FILE_PATH) ?? []).map((p) => p.toLowerCase()));
  files = paths.size;
  if (files >= 2) {
    score += 0.1;
    reasons.push(`涉及 ${files} 个文件`);
  }

  const fences = (source.match(/```/g) ?? []).length;
  const codeLines = source.split("\n").filter((line) => /^\s{0,4}(?:const|let|var|function|class|def|import|export|fn |pub |#include|package |public |private )/.test(line)).length;
  if (fences >= 2 || codeLines >= 10) {
    score += 0.06;
    reasons.push("带代码片段");
  }

  const imperative = IMPERATIVE.test(source);
  if (imperative) score += 0.06;

  if (source.length >= 2400) {
    score += 0.11;
    reasons.push("长描述");
  } else if (source.length >= 800) {
    score += 0.05;
    reasons.push("长描述");
  }

  const question = /[?？]\s*$/.test(source) && source.length < 300 && !imperative;
  if (question) {
    score -= 0.08;
    reasons.push("提问");
  }
  if (source.length <= 16 && !imperative && !hardHits) {
    score -= 0.08;
    reasons.push("短输入");
  }

  const imageCount = Number(images) || 0;
  if (imageCount > 0) {
    score += 0.05;
    reasons.push("含图片");
  }

  score = Math.max(0, Math.min(1, score));
  const tier = tierForScore(score, limits);
  return {
    tier,
    score: Math.round(score * 100) / 100,
    reasons: [...new Set(reasons)].slice(0, 5),
    files,
    textLength: source.length,
  };
}

/** 从 provider 配置里给“内置 provider 但没有模型列表”的场景一个可读提示。 */
export function missingTierHint(config) {
  const missing = TIERS.filter((tier) => !config.tiers[tier]);
  return missing.length ? `未配置档位：${missing.join(" / ")}` : null;
}
