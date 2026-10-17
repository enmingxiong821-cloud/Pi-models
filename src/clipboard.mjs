// 读系统剪贴板，用于"一键配置"：用户复制一串 "地址 + Key" 就能直接用。
import { spawnSync } from "node:child_process";

const CANDIDATES = {
  win32: [["powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]],
  darwin: [["pbpaste", []]],
  linux: [
    ["wl-paste", ["--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
  ],
};

export function readClipboard() {
  for (const [bin, args] of CANDIDATES[process.platform] ?? []) {
    try {
      const res = spawnSync(bin, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
      if (res.status === 0 && res.stdout?.trim()) return res.stdout.trim();
    } catch {
      /* 换下一个工具 */
    }
  }
  return "";
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
  const url = urlMatch ? urlMatch[0].replace(/[.,;]+$/, "") : "";

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
