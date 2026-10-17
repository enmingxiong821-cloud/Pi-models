// 读系统剪贴板，用于"一键配置"：用户复制一串 "地址 + Key" 就能直接用。
// 候选命令表按平台区分，并且可以注入假的执行器，方便在任意系统上跑单测。
import { spawnSync } from "node:child_process";

/** 各平台的剪贴板读取命令，按优先级排列。 */
export const CLIPBOARD_CANDIDATES = {
  win32: [
    ["pwsh", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]],
    ["powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]],
  ],
  darwin: [["pbpaste", []]],
  linux: [
    ["wl-paste", ["--no-newline"]], // Wayland
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
    ["termux-clipboard-get", []], // Android / Termux
  ],
};

export function clipboardCandidates(platform = process.platform) {
  return CLIPBOARD_CANDIDATES[platform] ?? CLIPBOARD_CANDIDATES.linux;
}

function runCommand(bin, args) {
  const res = spawnSync(bin, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
  return res.status === 0 ? (res.stdout ?? "").trim() : "";
}

/** 读剪贴板；Windows 优先 pwsh（如有）再退到 Windows PowerShell。 */
export function readClipboard({ platform = process.platform, run = runCommand } = {}) {
  for (const [bin, args] of clipboardCandidates(platform)) {
    try {
      const text = String(run(bin, args) ?? "").trim();
      if (text) return text;
    } catch {
      /* 换下一个工具 */
    }
  }
  return "";
}

/** doctor 用：报告这台机器上实际可用的剪贴板工具。 */
export function detectClipboardTool({ platform = process.platform, isAvailable } = {}) {
  const probe = isAvailable ?? ((bin) => {
    const finder = platform === "win32" ? "where" : "which";
    const res = spawnSync(finder, [bin], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return res.status === 0;
  });
  for (const [bin] of clipboardCandidates(platform)) {
    try {
      if (probe(bin)) return bin;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

/**
 * 从任意文本里抽出地址与 Key。用户可能粘贴的是：
 *   https://xxx.crow5.com  sk-abc123
 *   Base URL: https://xxx/v1\nAPI Key: sk-abc
 * 甚至一整段文档，只要里面同时有 URL 和看起来像 key 的串就能认出来。
 */
export function parseEndpoint(text) {
  const raw = String(text ?? "");
  const urlMatch = raw.match(/https?:\/\/[^\s"'`）)】,，、]+/i);
  let url = urlMatch ? urlMatch[0].replace(/[.,;]+$/, "") : "";
  if (!url) {
    // 允许只粘域名（api.example.com/v1），自动补 https://
    const hostMatch = raw.match(/\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)(\/[^\s"'`）)】,，、]*)?/i);
    if (hostMatch && /\.[a-z]{2,8}\b/i.test(hostMatch[1])) {
      url = `https://${hostMatch[1]}${hostMatch[2] ?? ""}`;
    }
  }

  let key = "";
  const patterns = [
    /\b(sk-[A-Za-z0-9_-]{10,})\b/,
    /\b(sk_[A-Za-z0-9_-]{10,})\b/,
    /\b([A-Za-z0-9]{8,}-[A-Za-z0-9_-]{8,})\b/, // 部分中转站的 key 不是 sk- 开头
    /\b([A-Za-z0-9_-]{32,})\b/,
  ];
  for (const re of patterns) {
    const hit = raw.match(re);
    if (hit) {
      key = hit[1];
      break;
    }
  }
  return { url, key };
}

export function maskKey(key) {
  const s = String(key ?? "");
  if (s.length <= 8) return "****";
  return `${s.slice(0, 5)}…${s.slice(-4)}（${s.length} 位）`;
}
