#!/usr/bin/env node
// 跨平台适配的自测：把平台相关的逻辑（剪贴板、启动器查找、名称推断）都喂假数据跑一遍，
// 这样无论当前机器是 Windows / macOS / Linux，都能验证另一套分支是否正确。
import assert from "node:assert/strict";
import path from "node:path";

const { CLIPBOARD_CANDIDATES, clipboardCandidates, readClipboard, detectClipboardTool, parseEndpoint, maskKey } =
  await import("../src/clipboard.mjs");
const { findPiLauncher, launcherNeedsShell } = await import("../src/paths.mjs");
const { suggestName } = await import("../src/relay.mjs");

let passed = 0;
const step = (name, fn) => {
  try {
    fn();
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.error(`  \u2714 ${name}`);
};

// ---- 剪贴板：各平台候选与回退 ----
step("三个平台都有剪贴板候选命令", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    assert.ok(clipboardCandidates(platform).length > 0, platform);
  }
  assert.match(clipboardCandidates("win32")[0][0], /pwsh|powershell/);
  assert.equal(clipboardCandidates("darwin")[0][0], "pbpaste");
  assert.ok(clipboardCandidates("linux").some(([bin]) => bin === "termux-clipboard-get"), "Linux/Android 需要 termux 支持");
});

step("未知平台回退到 linux 候选，不会抛错", () => {
  assert.deepEqual(clipboardCandidates("freebsd"), CLIPBOARD_CANDIDATES.linux);
});

step("readClipboard：第一个命令失败会自动试下一个", () => {
  const tried = [];
  const text = readClipboard({
    platform: "linux",
    run: (bin) => {
      tried.push(bin);
      if (bin === "wl-paste") throw new Error("not installed");
      if (bin === "xclip") return "  https://a.example.com  sk-1234567890abcd  ";
      return "";
    },
  });
  assert.deepEqual(tried, ["wl-paste", "xclip"]);
  assert.equal(text, "https://a.example.com  sk-1234567890abcd");
});

step("readClipboard：全部不可用时返回空串（不抛错）", () => {
  assert.equal(readClipboard({ platform: "linux", run: () => "" }), "");
});

step("detectClipboardTool 报告实际可用的工具", () => {
  assert.equal(detectClipboardTool({ platform: "darwin", isAvailable: (bin) => bin === "pbpaste" }), "pbpaste");
  assert.equal(detectClipboardTool({ platform: "linux", isAvailable: () => false }), null);
});

// ---- 文本解析 ----
step("parseEndpoint 认识带协议 / 不带协议 / 夹杂说明文字的粘贴内容", () => {
  assert.deepEqual(parseEndpoint("https://x.crow5.com sk-abcdefghijklmn"), { url: "https://x.crow5.com", key: "sk-abcdefghijklmn" });
  assert.deepEqual(parseEndpoint("api.crow5.com/v1  sk-abcdefghijklmn"), { url: "https://api.crow5.com/v1", key: "sk-abcdefghijklmn" });
  assert.deepEqual(parseEndpoint("地址：https://a.b.com，密钥：sk-abcdefghijklmn。"), {
    url: "https://a.b.com",
    key: "sk-abcdefghijklmn",
  });
  assert.equal(parseEndpoint("只有 https://a.b.com").key, "");
  assert.deepEqual(parseEndpoint(""), { url: "", key: "" });
});

step("maskKey 不会泄露完整密钥", () => {
  const masked = maskKey("sk-1234567890abcdef");
  assert.ok(!masked.includes("67890"), masked);
  assert.match(masked, /^sk-12…cdef/);
  assert.equal(maskKey("short"), "****");
});

// ---- provider 名称推断 ----
step("suggestName 覆盖常见形态", () => {
  assert.equal(suggestName("https://api.openai.com/v1"), "openai");
  assert.equal(suggestName("https://tbyunyi-router.crow5.com"), "crow5");
  assert.equal(suggestName("http://localhost:11434"), "localhost");
  assert.equal(suggestName("http://192.168.1.10:8080"), "192-168-1-10");
  assert.equal(suggestName("https://gw.example.invalid"), "example");
  assert.equal(suggestName("这不是地址"), "relay");
});

// ---- pi 启动器查找 ----
step("Windows：优先 pi.cmd，走 shell 启动", () => {
  const agent = "C:\\Users\\me\\.pi\\agent";
  const launcher = findPiLauncher(agent, { exists: (p) => p.endsWith("pi.cmd"), home: "C:\\Users\\me" });
  assert.equal(launcher.kind, "cmd");
  assert.equal(launcherNeedsShell(launcher), true);
});

step("macOS/Linux：找 ~/.pi/agent/bin/pi，不需要 shell", () => {
  const agent = "/home/me/.pi/agent";
  const launcher = findPiLauncher(agent, { exists: (p) => p === path.join(agent, "bin", "pi"), home: "/home/me" });
  assert.equal(launcher.kind, "bin");
  assert.equal(launcherNeedsShell(launcher), false);
});

step("Homebrew 安装位置也能找到", () => {
  const launcher = findPiLauncher("/home/me/.pi/agent", { exists: (p) => p === "/opt/homebrew/bin/pi", home: "/home/me" });
  assert.equal(launcher.command, "/opt/homebrew/bin/pi");
});

step("都没有时回退到 PATH，并按平台决定是否需要 shell", () => {
  const launcher = findPiLauncher("/home/me/.pi/agent", { exists: () => false, home: "/home/me" });
  assert.equal(launcher.command, "pi");
  assert.equal(launcher.fromPath, true);
  assert.equal(launcherNeedsShell(launcher), process.platform === "win32");
});

console.error(`\n跨平台自测通过 ${passed} 项 ✅（当前系统：${process.platform} ${process.arch}）`);
