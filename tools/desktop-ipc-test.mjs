#!/usr/bin/env node
// IPC 测试：通道白名单、参数校验、来源校验、切换/收藏与打开目录。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../src/commands.mjs";
import { createSession } from "../src/desktop-service.mjs";
import { CHANNELS, registerHandlers } from "../electron/ipc.mjs";
import { configPaths } from "../src/paths.mjs";

const SECRET = "sk-ipc-test-secret-123456";
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-ipc-"));
const paths = configPaths(agentDir);
const ctx = { agentDir, paths, flags: {} };

fs.writeFileSync(
  paths.models,
  JSON.stringify({
    providers: {
      demo: {
        baseUrl: "https://demo.invalid/v1",
        api: "openai-completions",
        models: [
          { id: "alpha", contextWindow: 128000 },
          { id: "beta", contextWindow: 200000, reasoning: true },
        ],
      },
    },
  }),
);
fs.writeFileSync(paths.auth, JSON.stringify({ demo: { type: "api_key", key: SECRET } }));
fs.writeFileSync(paths.settings, JSON.stringify({ defaultProvider: "demo", defaultModel: "alpha" }));

const handlers = new Map();
const ipcMain = {
  handle(channel, fn) {
    handlers.set(channel, fn);
  },
};
const opened = [];
const shell = {
  async openPath(target) {
    opened.push(target);
    return opened.length === 1 ? "" : "denied";
  },
};
const session = createSession(ctx);
registerHandlers({
  ipcMain,
  session,
  shell,
  isTrustedEvent: (event) => event?.sender?.id === 1,
});

const invoke = (channel, payload, event = { sender: { id: 1 } }) => handlers.get(channel)(event, payload);
const step = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

await step("只注册白名单通道", () => {
  assert.deepEqual([...handlers.keys()], CHANNELS);
  assert.equal(handlers.size, CHANNELS.length);
  assert.equal(handlers.size, 20);
});

await step("init 返回配置目录与脱敏视图", async () => {
  const result = await invoke("pmh:init");
  assert.equal(result.ok, true);
  assert.equal(result.agentDir, agentDir);
  assert.equal(result.view.currentKey, "demo#alpha");
  assert.equal(result.view.entries.length, 2);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

await step("list 参数校验", async () => {
  const ok = await invoke("pmh:list", { scopeId: "all", query: "beta" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.view.entries.map((entry) => entry.model), ["beta"]);

  assert.equal((await invoke("pmh:list", { scopeId: "group:nope" })).ok, false);
  assert.equal((await invoke("pmh:list", { scopeId: "all", query: "x".repeat(129) })).ok, false);
  assert.equal((await invoke("pmh:list", { scopeId: "all", query: "a\u0000b" })).ok, false);
  assert.equal((await invoke("pmh:list", { scopeId: "all", query: 42 })).ok, false);
  assert.equal((await invoke("pmh:list", { scopeId: "all", selectedKey: "a\u0007b" })).ok, false);
});

await step("拒绝非主窗口来源", async () => {
  const result = await invoke("pmh:list", { scopeId: "all" }, { sender: { id: 2 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /来源无效/);
});

await step("切换校验与落盘", async () => {
  const missing = await invoke("pmh:switch", { provider: "demo", model: "missing" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /模型不存在/);

  const proto = await invoke("pmh:switch", { provider: "__proto__", model: "alpha" });
  assert.equal(proto.ok, false);

  const result = await invoke("pmh:switch", { provider: "demo", model: "beta", scopeId: "all", query: "" });
  assert.equal(result.ok, true);
  assert.equal(result.view.currentKey, "demo#beta");
  assert.equal(result.notice.kind, "ok");
  assert.equal(loadSettings(ctx).defaultModel, "beta");
});

await step("收藏切换返回新视图", async () => {
  const result = await invoke("pmh:favorite", { provider: "demo", model: "beta", scopeId: "all" });
  assert.equal(result.ok, true);
  assert.equal(result.view.entries.find((entry) => entry.model === "beta").favorite, true);
  assert.match(result.notice.text, /已收藏/);
});

await step("refresh 与打开配置目录", async () => {
  const refreshed = await invoke("pmh:refresh", { scopeId: "all" });
  assert.equal(refreshed.ok, true);

  const openedResult = await invoke("pmh:open-agent-dir");
  assert.equal(openedResult.ok, true);
  assert.deepEqual(opened, [agentDir]);

  const failed = await invoke("pmh:open-agent-dir");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /无法打开配置目录/);
});

await step("站点列表与详情不泄露 Key", async () => {
  const list = await invoke("pmh:providers");
  assert.equal(list.ok, true);
  assert.equal(list.providers.length, 1);
  assert.equal(list.providers[0].credential.configured, true);
  assert.equal(JSON.stringify(list).includes(SECRET), false);

  const detail = await invoke("pmh:provider-get", { provider: "demo" });
  assert.equal(detail.ok, true);
  assert.equal(detail.models.length, 2);
  assert.equal(JSON.stringify(detail).includes(SECRET), false);

  assert.equal((await invoke("pmh:provider-get", { provider: "nope" })).ok, false);
  assert.equal((await invoke("pmh:provider-get", { provider: "a\u0000b" })).ok, false);
});

await step("新建站点参数校验与写盘", async () => {
  const badUrl = await invoke("pmh:provider-save", {
    provider: "extra", baseUrl: "ftp://extra.invalid", discover: false,
  });
  assert.equal(badUrl.ok, false);

  const accountInUrl = await invoke("pmh:provider-save", {
    provider: "extra", baseUrl: "https://user:pass@extra.invalid", discover: false,
  });
  assert.equal(accountInUrl.ok, false);
  assert.match(accountInUrl.error, /内嵌账号/);

  const badApi = await invoke("pmh:provider-save", {
    provider: "extra", baseUrl: "https://extra.invalid", api: "graphql", discover: false,
  });
  assert.equal(badApi.ok, false);

  const badKey = await invoke("pmh:provider-save", {
    provider: "extra", baseUrl: "https://extra.invalid", api: "openai-completions",
    key: "sk-a\u0000b", discover: false,
  });
  assert.equal(badKey.ok, false);

  const saved = await invoke("pmh:provider-save", {
    provider: "extra",
    name: "Extra",
    baseUrl: "https://extra.invalid",
    api: "openai-completions",
    key: SECRET,
    discover: false,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.result.created, true);
  assert.equal(JSON.stringify(saved).includes(SECRET), false);
});

await step("Key 替换/清除与确认", async () => {
  const set = await invoke("pmh:key-set", { provider: "extra", key: SECRET });
  assert.equal(set.ok, true);
  assert.equal(set.credential.configured, true);
  assert.equal(JSON.stringify(set).includes(SECRET), false);

  assert.equal((await invoke("pmh:key-set", { provider: "extra", key: "" })).ok, false);
  assert.equal((await invoke("pmh:key-set", { provider: "extra", key: "x".repeat(513) })).ok, false);
  assert.equal((await invoke("pmh:key-clear", { provider: "extra", confirm: "wrong" })).ok, false);

  const cleared = await invoke("pmh:key-clear", { provider: "extra", confirm: "extra" });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.remaining.configured, false);
});

await step("模型保存/删除与确认", async () => {
  const saved = await invoke("pmh:model-save", {
    provider: "extra",
    model: "gamma",
    mode: "add",
    patch: { contextWindow: 32000, cost: { input: 0.5, output: 1 } },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.detail.models.some((entry) => entry.id === "gamma"), true);

  assert.equal((await invoke("pmh:model-save", {
    provider: "extra", model: "gamma", mode: "add", patch: { evil: 1 },
  })).ok, false);
  assert.equal((await invoke("pmh:model-delete", {
    provider: "extra", model: "gamma", confirm: "extra",
  })).ok, false);

  const removed = await invoke("pmh:model-delete", {
    provider: "extra", model: "gamma", confirm: "extra#gamma",
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.detail.models.length, 0);
});

await step("站点删除确认与默认站点保护", async () => {
  assert.equal((await invoke("pmh:provider-delete", {
    provider: "extra", confirm: "nope",
  })).ok, false);

  const removed = await invoke("pmh:provider-delete", { provider: "extra", confirm: "extra" });
  assert.equal(removed.ok, true);
  assert.equal((await invoke("pmh:providers")).providers.some((row) => row.id === "extra"), false);

  const guarded = await invoke("pmh:provider-delete", { provider: "demo", confirm: "demo" });
  assert.equal(guarded.ok, false);
  assert.match(guarded.error, /默认站点/);
});

await step("思考等级读写", async () => {
  assert.equal((await invoke("pmh:thinking-set", { scope: "global", level: "ultra" })).ok, false);
  assert.equal((await invoke("pmh:thinking-set", { scope: "nope", level: "high" })).ok, false);
  assert.equal((await invoke("pmh:thinking-set", { scope: "model", level: "high" })).ok, false);

  const set = await invoke("pmh:thinking-set", { scope: "global", level: "medium" });
  assert.equal(set.ok, true);
  assert.equal(set.state.global, "medium");

  const modelSet = await invoke("pmh:thinking-set", {
    scope: "model", provider: "demo", model: "beta", level: "high",
  });
  assert.equal(modelSet.ok, true);

  const got = await invoke("pmh:thinking-get", { provider: "demo", model: "beta" });
  assert.equal(got.ok, true);
  assert.equal(got.state.effective, "high");
  assert.equal(got.state.source, "model");

  const reset = await invoke("pmh:thinking-set", { scope: "global", level: null });
  assert.equal(reset.ok, true);
  assert.equal(reset.state.global, null);
});

await step("自动路由读写、校验与预览", async () => {
  const auto = await invoke("pmh:auto-get");
  assert.equal(auto.ok, true);
  assert.equal(typeof auto.auto.enabled, "boolean");
  assert.equal(typeof auto.auto.tiers, "object");
  assert.equal(auto.auto.version, 2);

  const saved = await invoke("pmh:auto-set", {
    enabled: true,
    upgradeOnRetry: false,
    useModelThinking: true,
    pinned: null,
    thresholds: { cheap: 0.2, strong: 0.6 },
    tiers: { cheap: "demo#alpha", standard: "demo#beta", strong: "demo#beta" },
    projects: { "ipc-proj": { pinned: "standard" } },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.auto.version, 2);
  assert.equal(saved.auto.upgradeOnRetry, false);
  assert.equal(saved.auto.useModelThinking, true);
  assert.equal(saved.auto.projects["ipc-proj"].pinned, "standard");
  assert.deepEqual(saved.auto.thresholds, { cheap: 0.2, strong: 0.6 });
  assert.equal(JSON.stringify(saved).includes(SECRET), false);

  assert.equal((await invoke("pmh:auto-set", { thresholds: { cheap: 0.8, strong: 0.2 } })).ok, false);
  assert.equal((await invoke("pmh:auto-set", { tiers: { cheap: "demo#ghost" } })).ok, false);
  assert.equal((await invoke("pmh:auto-set", { tiers: { cheap: "pmh#auto" } })).ok, false);
  assert.equal((await invoke("pmh:auto-set", { pinned: "turbo" })).ok, false);
  assert.equal((await invoke("pmh:auto-set", { projects: { "a*": "strong" } })).ok, false);
  assert.equal((await invoke("pmh:auto-set", { unknown: true })).ok, false);
  assert.equal((await invoke("pmh:auto-set", "nope")).ok, false);

  const preview = await invoke("pmh:auto-preview", { text: "把错别字改一下" });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview.tier, "cheap");
  assert.equal(preview.preview.target, "demo#alpha");
  assert.equal(preview.preview.thinking, null);

  const project = await invoke("pmh:auto-preview", { text: "把错别字改一下", project: "ipc-proj" });
  assert.equal(project.ok, true);
  assert.equal(project.preview.effectiveTier, "standard");
  assert.equal(project.preview.pinnedSource, "project");
  assert.equal(project.preview.target, "demo#beta");

  assert.equal((await invoke("pmh:auto-preview", { text: "x".repeat(4001) })).ok, false);
  assert.equal((await invoke("pmh:auto-preview", { project: "x".repeat(261) })).ok, false);
  assert.equal((await invoke("pmh:auto-preview", { text: "a\u0000b" })).ok, false);
  assert.equal((await invoke("pmh:auto-preview", "nope")).ok, false);
});

await step("用量只读聚合与参数校验", async () => {
  fs.mkdirSync(paths.sessions, { recursive: true });
  const now = new Date().toISOString();
  const rows = [
    { type: "session", id: "ipc-s1", version: 3, timestamp: now, cwd: agentDir },
    {
      type: "message", id: "ipc-m1", parentId: null, timestamp: now,
      message: {
        role: "assistant", provider: "demo", model: "alpha",
        usage: { input: 1000, output: 200, totalTokens: 1200, cost: { total: 0.01 } },
      },
    },
  ];
  fs.writeFileSync(path.join(paths.sessions, "ipc.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = await invoke("pmh:usage", { range: "today", groupBy: "provider", branch: "all" });
  assert.equal(result.ok, true);
  assert.equal(result.usage.totals.input, 1000);
  assert.equal(result.usage.totals.output, 200);
  assert.equal(result.usage.totals.totalTokens, 1200);
  assert.equal(result.usage.totals.cost, 0.01);
  assert.equal(result.usage.groups[0].key, "demo");
  assert.equal(result.usage.scan.branch, "all");
  assert.equal(JSON.stringify(result).includes(SECRET), false);

  assert.equal((await invoke("pmh:usage", { range: "yesterday" })).ok, false);
  assert.equal((await invoke("pmh:usage", { range: "2026-02-30" })).ok, false);
  assert.equal((await invoke("pmh:usage", { groupBy: "hour" })).ok, false);
  assert.equal((await invoke("pmh:usage", { branch: "side" })).ok, false);
  assert.equal((await invoke("pmh:usage", { project: "x".repeat(201) })).ok, false);
  assert.equal((await invoke("pmh:usage", { project: "a\u0000b" })).ok, false);
  assert.equal((await invoke("pmh:usage", "nope")).ok, false);
});

await step("并发写操作按顺序落盘", async () => {
  const levels = ["low", "medium", "high"];
  const results = await Promise.all(levels.map((level) => invoke("pmh:thinking-set", {
    scope: "model", provider: "demo", model: "alpha", level,
  })));
  assert.equal(results.every((result) => result.ok), true);
  const state = await invoke("pmh:thinking-get", { provider: "demo", model: "alpha" });
  assert.equal(state.state.effective, "high");
  assert.equal(loadSettings(ctx).modelThinkingLevels["demo/alpha"], "high");
});

console.error("IPC 测试全部通过 ✅");
