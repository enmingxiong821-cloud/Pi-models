// 反馈模块：收集脱敏环境信息，生成 GitHub Issue 预填链接。
// 原则：只读本地配置，不上传任何内容；用户确认后才在浏览器打开，提交动作仍由用户完成。
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REQUIRED_APIS, installedMode, probePiApi, readSourceMarker } from "../extensions/auto-router/compat.mjs";
import { readAutoConfig } from "../extensions/auto-router/router.mjs";
import { findPiInstall } from "./paths.mjs";
import { readJson } from "./util.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FEEDBACK_REPO = "enmingxiong821-cloud/pi-model";
export const FEEDBACK_URL = `https://github.com/${FEEDBACK_REPO}/issues/new`;
const MESSAGE_LIMIT = 1200;
const URL_LIMIT = 7000;

export function pmhVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-***"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "xox*-***"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1***"],
  [/\b(Basic\s+)[A-Za-z0-9+/=]{6,}/gi, "$1***"],
  [/([?&](?:key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&\s#]+/gi, "$1***"],
  [/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)(?!\*\*\*|Bearer\s|Basic\s)[^"'\s,;}]+/gi, "$1***"],
  [/\b((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;"'}]+/gi, "$1***"],
];

const USER_PATH_PATTERNS = [
  [/[A-Za-z]:\\Users\\[^\\\s]+/gi, "~"],
  [/(^|[\s"'(:=])\/(?:home|Users)\/[^/\s]+/g, "$1~"],
];

/** 去掉密钥、令牌与用户主目录，避免反馈里夹带隐私。 */
export function redact(text, { home = os.homedir(), max = 4000 } = {}) {
  let out = String(text ?? "");
  if (home) {
    out = out.split(home).join("~");
    const alternate = home.includes("\\") ? home.replace(/\\/g, "/") : home.replace(/\//g, "\\");
    if (alternate !== home) out = out.split(alternate).join("~");
  }
  // 兜底：home 之外的写法（8.3 短路径、另一个盘符的 Users 目录）
  for (const [pattern, replacement] of USER_PATH_PATTERNS) out = out.replace(pattern, replacement);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  out = out.trim();
  if (max && out.length > max) out = `${out.slice(0, max)}…（已截断）`;
  return out;
}

function modeLabel(mode) {
  return mode === "package" ? "pi 包（随仓库更新）"
    : mode === "copy" ? "复制到 agent 扩展目录"
      : mode === "unknown" ? "手动加载（无安装记录）"
        : "未安装";
}

/**
 * 只收集"无法从代码推断、但排查问题时需要"的信息。
 * 刻意不包含 provider 名称、模型名、地址与任何凭据。
 */
export function collectDiagnostics(ctx, {
  version = pmhVersion(),
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.version,
  osRelease = os.release(),
  home = os.homedir(),
} = {}) {
  const models = readJson(ctx.paths.models, { providers: {} }) ?? {};
  const providers = Object.keys(models.providers ?? {});
  const modelCount = providers.reduce((sum, id) => {
    const list = models.providers?.[id]?.models;
    return sum + (Array.isArray(list) ? list.length : 0);
  }, 0);

  const registry = readJson(ctx.paths.registry, {}) ?? {};
  const relays = Object.values(registry.relays ?? {});
  const keyAliases = relays.reduce((sum, relay) => sum + Math.max(0, (relay.keyAliases?.length ?? 0) - 1), 0);
  const favorites = relays.reduce((sum, relay) => sum + (relay.favorites?.length ?? 0), 0);

  // 只探测不写 compat 状态：feedback 必须是纯只读命令
  const probe = probePiApi(ctx.agentDir);
  const missing = probe.known ? REQUIRED_APIS.filter((key) => probe.apis?.[key] === false) : [];
  const install = findPiInstall(ctx.agentDir);
  const marker = readSourceMarker(ctx.agentDir);
  const mode = installedMode(ctx.agentDir, marker?.repoRoot ?? REPO_ROOT);
  const auto = readAutoConfig(ctx.agentDir);

  return {
    pmh: version,
    node: nodeVersion,
    platform,
    arch,
    osRelease,
    pi: install.version ?? probe.version ?? null,
    piApi: probe.known ? (missing.length ? `missing:${missing.join(",")}` : "ok") : "unknown",
    installMode: mode,
    agentDir: redact(ctx.agentDir, { home, max: 300 }),
    counts: {
      providers: providers.length,
      models: modelCount,
      relays: relays.length,
      groups: Object.keys(registry.groups ?? {}).length,
      keyAliases,
      favorites,
    },
    auto: {
      enabled: auto.enabled !== false,
      pinned: auto.pinned ?? null,
      configured: Object.values(auto.tiers ?? {}).filter(Boolean).length,
    },
  };
}

export function formatReport({ message = "", diagnostics }) {
  const d = diagnostics;
  const lines = [
    "### 问题描述",
    "",
    message || "（请补充：你做了什么、期望什么、实际发生了什么；可附上报错原文）",
    "",
    "### 环境信息",
    "",
    `- pmh: ${d.pmh}`,
    `- Node: ${d.node}（${d.platform} ${d.arch}，${d.osRelease}）`,
    `- pi: ${d.pi ?? "未检测到"}${d.piApi === "ok" ? "" : `（扩展 API：${d.piApi}）`}`,
    `- 扩展安装: ${modeLabel(d.installMode)}`,
    `- agent 目录: ${d.agentDir}`,
    `- 配置规模: ${d.counts.relays} 个站点 / ${d.counts.models} 个模型 / ${d.counts.groups} 个分组 / ${d.counts.keyAliases} 个 Key 别名 / ${d.counts.favorites} 个收藏`,
    `- 自动路由: ${d.auto.enabled ? "开启" : "关闭"}${d.auto.pinned ? `，固定 ${d.auto.pinned}` : ""}，已配置 ${d.auto.configured}/3 档`,
    "",
    "### 附注",
    "",
    "- 以上信息由 `pmh feedback` 自动生成，已脱敏：不含 API Key、站点地址、模型名与用户名。",
    "- 如涉及网络或中转站，请补充报错原文（粘贴前先删掉其中的 Key）。",
  ];
  return lines.join("\n");
}

export function feedbackTitle(message, diagnostics) {
  const first = String(message ?? "").trim().split(/\r?\n/)[0].trim();
  if (first) return `[反馈] ${first.length > 60 ? `${first.slice(0, 60)}…` : first}`;
  return `[反馈] pmh ${diagnostics.pmh} 使用问题`;
}

function issueUrl(title, body) {
  return `${FEEDBACK_URL}?${new URLSearchParams({ title, body }).toString()}`;
}

/** 控制 URL 长度：超限时二分截断正文，保证浏览器/GitHub 能接受。 */
export function buildIssueUrl(title, body, { limit = URL_LIMIT } = {}) {
  const full = issueUrl(title, body);
  if (full.length <= limit) return full;
  const marker = "\n\n（报告过长已截断；运行 pmh feedback --print 查看完整内容）";
  let low = 0;
  let high = body.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (issueUrl(title, body.slice(0, mid) + marker).length <= limit) low = mid;
    else high = mid - 1;
  }
  return issueUrl(title, body.slice(0, low) + marker);
}

export function buildFeedback(ctx, message, options = {}) {
  const text = redact(message, { ...options, max: MESSAGE_LIMIT });
  const diagnostics = collectDiagnostics(ctx, options);
  const report = formatReport({ message: text, diagnostics });
  const title = feedbackTitle(text, diagnostics);
  return { message: text, diagnostics, title, report, issueUrl: buildIssueUrl(title, report) };
}

/** 跨平台打开 URL；失败时返回 false，由调用方打印链接兜底。 */
export function openUrl(url, { spawnFn = spawn, platform = process.platform } = {}) {
  const [command, args] = platform === "win32"
    ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    const child = spawnFn(command, args, { detached: true, stdio: "ignore" });
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}
