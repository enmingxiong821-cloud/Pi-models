#!/usr/bin/env node
// 控制台测试：范围过滤、搜索、布局、按键映射、切换/收藏写盘、非 TTY 退化。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdUse, loadSettings } from "../src/commands.mjs";
import {
  canRunConsole, cmdConsole, displayWidth, filterEntries, formatDetail, keyToAction, loadConsoleState,
  moveCursor, renderConsole, runConsole, scopeOptions, windowFor,
} from "../src/console.mjs";
import { configPaths } from "../src/paths.mjs";
import {
  addFavorite, addGroup, loadRegistry, recordUse, saveRegistry, setRelayGroup, toggleFavorite,
} from "../src/registry.mjs";

const SECRET = "sk-console-test-secret-123456";
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-console-"));
const paths = configPaths(agentDir);
const ctx = { agentDir, paths, flags: {} };

fs.writeFileSync(
  paths.models,
  JSON.stringify({
    providers: {
      crow5: {
        baseUrl: "https://x.crow5.com/v1",
        api: "openai-completions",
        models: [
          {
            id: "claude-sonnet-4-5",
            name: "Sonnet 4.5",
            contextWindow: 200000,
            maxTokens: 64000,
            reasoning: true,
            input: ["text", "image"],
          },
          { id: "claude-opus-4-1", name: "Opus 4.1", contextWindow: 200000, reasoning: true },
          { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, input: ["text", "image"] },
        ],
      },
      local: {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        models: [{ id: "qwen3", contextWindow: 32000 }],
      },
    },
  }),
);
fs.writeFileSync(paths.auth, JSON.stringify({ crow5: { type: "api_key", key: SECRET } }));
fs.writeFileSync(
  paths.settings,
  JSON.stringify({ defaultProvider: "crow5", defaultModel: "claude-sonnet-4-5" }),
);

{
  const { registry } = loadRegistry(ctx);
  addGroup(registry, "code", { title: "写代码" });
  setRelayGroup(registry, "crow5", "code");
  addFavorite(registry, "crow5", "claude-opus-4-1");
  recordUse(registry, "crow5", "gpt-4o", { at: "2026-01-01T00:00:00Z" });
  recordUse(registry, "local", "qwen3", { at: "2026-01-02T00:00:00Z" });
  saveRegistry(ctx, registry, { backup: false });
}

const step = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

const keys = (entries) => entries.map((entry) => `${entry.provider}#${entry.model}`);
const state = loadConsoleState(ctx);

await step("加载状态：范围、当前默认、分组、收藏与最近标记", () => {
  assert.equal(state.currentKey, "crow5#claude-sonnet-4-5");
  assert.deepEqual(state.scopes.map((scope) => scope.id), ["all", "fav", "recent", "group:code"]);
  assert.deepEqual(
    scopeOptions(state.registry).map((scope) => scope.label),
    ["全部", "收藏", "最近", "@code"],
  );
  const sonnet = state.entries.find((entry) => entry.model === "claude-sonnet-4-5");
  assert.equal(sonnet.group, "code");
  assert.equal(sonnet.credential, "auth.json");
  assert.equal(sonnet.contextWindow, 200000);
  const opus = state.entries.find((entry) => entry.model === "claude-opus-4-1");
  assert.equal(opus.favorite, true);
  const qwen = state.entries.find((entry) => entry.model === "qwen3");
  assert.equal(qwen.recentRank, 0);
  assert.equal(qwen.lastModel, "qwen3");
});

await step("范围过滤：全部、收藏、最近、分组", () => {
  assert.deepEqual(keys(filterEntries(state, "all", "")).slice(0, 2), [
    "crow5#claude-opus-4-1",
    "crow5#gpt-4o",
  ]);
  assert.deepEqual(keys(filterEntries(state, "fav", "")), ["crow5#claude-opus-4-1"]);
  assert.deepEqual(keys(filterEntries(state, "recent", "")), ["local#qwen3", "crow5#gpt-4o"]);
  assert.deepEqual(keys(filterEntries(state, "group:code", "")).sort(), [
    "crow5#claude-opus-4-1",
    "crow5#claude-sonnet-4-5",
    "crow5#gpt-4o",
  ]);
});

await step("搜索：命中排序与无结果", () => {
  assert.equal(filterEntries(state, "all", "sonnet")[0].model, "claude-sonnet-4-5");
  assert.deepEqual(keys(filterEntries(state, "all", "qwen")), ["local#qwen3"]);
  assert.deepEqual(filterEntries(state, "all", "no-such-model"), []);
});

await step("光标与视口边界", () => {
  assert.equal(moveCursor(0, 0, 1), 0);
  assert.equal(moveCursor(3, 0, -1), 0);
  assert.equal(moveCursor(3, 2, 1), 2);
  assert.equal(moveCursor(3, 1, 1), 2);
  assert.deepEqual(windowFor([1, 2, 3], 1, 5), { start: 0, end: 3, moreAbove: 0, moreBelow: 0 });
  assert.deepEqual(windowFor([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, 3), { start: 4, end: 7, moreAbove: 4, moreBelow: 3 });
  assert.deepEqual(windowFor([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 9, 3), { start: 7, end: 10, moreAbove: 7, moreBelow: 0 });
});

await step("详情与渲染不泄露 Key，中文宽度不越界", () => {
  const sonnet = state.entries.find((entry) => entry.model === "claude-sonnet-4-5");
  const detail = formatDetail(sonnet).join("\n");
  assert.match(detail, /上下文 200K/);
  assert.match(detail, /auth\.json/);
  assert.match(detail, /分组 @code/);
  assert.ok(!detail.includes(SECRET));

  const wide = renderConsole(
    {
      currentKey: state.currentKey,
      scopes: state.scopes,
      scopeId: "all",
      query: "",
      mode: "browse",
      entries: state.entries,
      cursor: 0,
      notice: null,
      busy: false,
    },
    { columns: 80, rows: 24 },
  );
  const wideLines = wide.split("\n");
  assert.equal(wideLines.length, 24);
  assert.ok(wideLines.every((line) => displayWidth(line) <= 80));
  assert.ok(!wide.includes(SECRET));

  const narrow = renderConsole(
    {
      currentKey: state.currentKey,
      scopes: state.scopes,
      scopeId: "all",
      query: "",
      mode: "browse",
      entries: state.entries,
      cursor: 1,
      notice: { kind: "ok", text: "测试提示" },
      busy: false,
    },
    { columns: 40, rows: 10 },
  );
  const narrowLines = narrow.split("\n");
  assert.equal(narrowLines.length, 10);
  assert.ok(narrowLines.every((line) => displayWidth(line) <= 40));
  assert.ok(!wide.includes(SECRET) && !narrow.includes(SECRET));

  const empty = renderConsole(
    {
      scopes: state.scopes,
      scopeId: "all",
      query: "nope",
      mode: "search",
      entries: [],
      cursor: 0,
    },
    { columns: 80, rows: 20 },
  );
  assert.match(empty, /没有匹配 "nope" 的模型/);
});

await step("按键映射：浏览态与搜索态分离", () => {
  assert.deepEqual(keyToAction("", { name: "up" }), { type: "move", delta: -1 });
  assert.deepEqual(keyToAction("", { name: "down" }), { type: "move", delta: 1 });
  assert.deepEqual(keyToAction("", { name: "return" }), { type: "switch" });
  assert.deepEqual(keyToAction("f", {}), { type: "favorite" });
  assert.deepEqual(keyToAction("/", {}), { type: "search" });
  assert.deepEqual(keyToAction("r", {}), { type: "reload" });
  assert.deepEqual(keyToAction("q", {}), { type: "quit" });
  assert.deepEqual(keyToAction("", { name: "tab" }), { type: "scope", delta: 1 });
  assert.deepEqual(keyToAction("", { name: "tab", shift: true }), { type: "scope", delta: -1 });

  assert.deepEqual(keyToAction("q", {}, "search"), { type: "input", text: "q" });
  assert.deepEqual(keyToAction("", { name: "backspace" }, "search"), { type: "backspace" });
  assert.deepEqual(keyToAction("", { name: "escape" }, "search"), { type: "clear" });
  assert.deepEqual(keyToAction("", { name: "return" }, "search"), { type: "switch" });
  assert.deepEqual(keyToAction("", { ctrl: true, name: "c" }, "search"), { type: "quit" });
});

await step("非 TTY / dumb 终端不进入全屏", () => {
  assert.equal(canRunConsole({ stdin: {}, stdout: {}, env: {} }), false);
  assert.equal(
    canRunConsole({ stdin: { isTTY: true, setRawMode() {} }, stdout: { isTTY: true }, env: { PMH_NONINTERACTIVE: "1" } }),
    false,
  );
  assert.equal(
    canRunConsole({ stdin: { isTTY: true, setRawMode() {} }, stdout: { isTTY: true }, env: { TERM: "dumb" } }),
    false,
  );
  assert.equal(
    canRunConsole({ stdin: { isTTY: true, setRawMode() {} }, stdout: { isTTY: true }, env: {} }),
    true,
  );
});

await step("cmdUse quiet 不输出，settings/备份/MRU 正确更新", async () => {
  let output = "";
  const originalLog = console.log;
  console.log = (...args) => {
    output += `${args.join(" ")}\n`;
  };
  try {
    const result = await cmdUse(ctx, "crow5#gpt-4o", { quiet: true });
    assert.deepEqual(result.provider, "crow5");
    assert.deepEqual(result.model, "gpt-4o");
    assert.ok(result.backup);
  } finally {
    console.log = originalLog;
  }
  assert.equal(output, "");
  assert.equal(loadSettings(ctx).defaultModel, "gpt-4o");
  assert.ok(fs.readdirSync(agentDir).some((name) => name.startsWith("settings.json.bak-")));
  const { registry } = loadRegistry(ctx);
  assert.equal(registry.relays.crow5.mru[0].model, "gpt-4o");
});

await step("收藏切换持久化，重新加载仍保留", () => {
  const { registry } = loadRegistry(ctx);
  assert.equal(toggleFavorite(registry, "crow5", "claude-sonnet-4-5"), true);
  saveRegistry(ctx, registry, { backup: false });
  const next = loadConsoleState(ctx);
  assert.equal(next.entries.find((entry) => entry.model === "claude-sonnet-4-5").favorite, true);
});

await step("cmdConsole 在非 TTY 下立即返回并提示", async () => {
  let output = "";
  const originalLog = console.log;
  console.log = (...args) => {
    output += `${args.join(" ")}\n`;
  };
  try {
    await cmdConsole(ctx);
  } finally {
    console.log = originalLog;
  }
  assert.match(output, /交互式终端/);
});

class FakeInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.raw = null;
    this.resumed = false;
  }

  setRawMode(value) {
    this.raw = value;
  }

  resume() {
    this.resumed = true;
  }

  pause() {
    this.resumed = false;
  }
}

class FakeOutput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.columns = 80;
    this.rows = 24;
    this.data = "";
  }

  write(chunk) {
    this.data += String(chunk);
    return true;
  }
}

await step("runConsole 进入/退出备用屏、响应 resize、恢复终端", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = runConsole(ctx, { input, output, env: {} });
  assert.equal(input.raw, true);
  assert.match(output.data, /\u001b\[\?1049h/);
  assert.match(output.data, /pmh console/);
  output.rows = 20;
  output.emit("resize");
  assert.ok((output.data.match(/pmh console/g) ?? []).length >= 2);
  input.emit("keypress", "q", { name: "q" });
  assert.equal(await done, 0);
  assert.equal(input.raw, false);
  assert.equal(input.resumed, false);
  assert.match(output.data, /\u001b\[\?25h\u001b\[\?1049l/);
  assert.ok(!output.data.includes(SECRET));
});

await step("runConsole 内搜索并切换默认模型", async () => {
  await cmdUse(ctx, "crow5#claude-sonnet-4-5", { quiet: true });
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = runConsole(ctx, { input, output, env: {} });
  input.emit("keypress", "/", { name: undefined });
  input.emit("keypress", "gpt", { name: undefined });
  input.emit("keypress", "", { name: "return" });
  const deadline = Date.now() + 2000;
  while (loadSettings(ctx).defaultModel !== "gpt-4o" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(loadSettings(ctx).defaultModel, "gpt-4o");
  input.emit("keypress", "", { ctrl: true, name: "c" });
  assert.equal(await done, 0);
  assert.ok(!output.data.includes(SECRET));
});

console.error("\n控制台测试全部通过 ✅");
