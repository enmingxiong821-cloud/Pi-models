#!/usr/bin/env node
// 桌面服务测试：DTO 脱敏、过滤顺序、切换/收藏落盘、并发串行与错误清洗。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../src/commands.mjs";
import { filterEntries, loadConsoleState } from "../src/console.mjs";
import { buildView, createSession, favoriteModel, refresh, safeError, switchModel } from "../src/desktop-service.mjs";
import { configPaths } from "../src/paths.mjs";
import { addFavorite, addGroup, loadRegistry, recordUse, saveRegistry, setRelayGroup } from "../src/registry.mjs";

const SECRET = "sk-desktop-test-secret-123456";
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-desktop-"));
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
  saveRegistry(ctx, registry, { backup: false });
}

const step = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

const keys = (entries) => entries.map((entry) => `${entry.provider}#${entry.model}`);
const settingsNow = () => loadSettings(ctx);

await step("视图字段完整，顺序与终端过滤一致，且不含 Key", () => {
  const session = createSession(ctx);
  const view = buildView(session, {});
  const expected = filterEntries(loadConsoleState(ctx), "all", "");
  assert.deepEqual(keys(view.entries), keys(expected));
  assert.equal(view.currentKey, "crow5#claude-sonnet-4-5");
  assert.equal(view.selectedKey, view.entries[0] ? `${view.entries[0].provider}#${view.entries[0].model}` : null);
  assert.equal(view.scopes.find((scope) => scope.id === "all").count, 3);
  assert.equal(view.scopes.find((scope) => scope.id === "fav").count, 1);
  assert.equal(view.scopes.find((scope) => scope.id === "group:code").count, 3);
  const sonnet = view.entries.find((entry) => entry.model === "claude-sonnet-4-5");
  assert.equal(sonnet.current, true);
  assert.equal(sonnet.credentialKind, "auth.json");
  assert.equal(sonnet.contextLabel, "200K");
  assert.equal(sonnet.image, true);
  assert.ok(Array.isArray(sonnet.detailLines) && sonnet.detailLines.length >= 4);
  assert.equal(JSON.stringify(view).includes(SECRET), false);
});

await step("搜索与空结果", () => {
  const session = createSession(ctx);
  const hit = buildView(session, { query: "opus" });
  assert.deepEqual(keys(hit.entries), ["crow5#claude-opus-4-1"]);
  const miss = buildView(session, { query: "no-such-model" });
  assert.equal(miss.entries.length, 0);
  assert.equal(miss.selectedKey, null);
  assert.throws(() => buildView(session, { scopeId: "group:missing" }), /筛选范围无效/);
});

await step("切换默认模型：settings、备份与 MRU 更新", async () => {
  const session = createSession(ctx);
  const before = fs.readdirSync(agentDir);
  const result = await switchModel(session, "crow5", "claude-opus-4-1");
  assert.equal(result.key, "crow5#claude-opus-4-1");
  const settings = settingsNow();
  assert.equal(settings.defaultProvider, "crow5");
  assert.equal(settings.defaultModel, "claude-opus-4-1");
  const after = fs.readdirSync(agentDir);
  assert.ok(after.length > before.length, "应生成设置备份");
  const view = buildView(session, {});
  assert.equal(view.currentKey, "crow5#claude-opus-4-1");
  assert.equal(view.entries.find((entry) => entry.model === "claude-opus-4-1").current, true);
  const { registry } = loadRegistry(ctx);
  assert.equal(registry.relays.crow5.mru[0].model, "claude-opus-4-1");
});

await step("收藏切换持久化", async () => {
  const session = createSession(ctx);
  const added = await favoriteModel(session, "crow5", "gpt-4o");
  assert.equal(added.added, true);
  assert.equal(loadRegistry(ctx).registry.relays.crow5.favorites.includes("gpt-4o"), true);
  const view = buildView(session, { scopeId: "fav" });
  assert.deepEqual(keys(view.entries).sort(), ["crow5#claude-opus-4-1", "crow5#gpt-4o"]);
  const removed = await favoriteModel(session, "crow5", "gpt-4o");
  assert.equal(removed.added, false);
  assert.equal(loadRegistry(ctx).registry.relays.crow5.favorites.includes("gpt-4o"), false);
  assert.equal(JSON.stringify(buildView(session, {})).includes(SECRET), false);
});

await step("非法目标被拒绝且不改配置", async () => {
  const session = createSession(ctx);
  const before = JSON.stringify(settingsNow());
  await assert.rejects(switchModel(session, "crow5", "no-such-model"), /模型不存在/);
  await assert.rejects(favoriteModel(session, "crow5", "no-such-model"), /模型不存在/);
  assert.throws(() => switchModel(session, "__proto__", "x"), /模型参数无效/);
  assert.throws(() => switchModel(session, "crow5", "bad\nmodel"), /模型参数无效/);
  assert.equal(JSON.stringify(settingsNow()), before);
});

await step("并发切换串行执行，最终状态一致", async () => {
  const session = createSession(ctx);
  await Promise.all([
    switchModel(session, "crow5", "claude-sonnet-4-5"),
    switchModel(session, "crow5", "gpt-4o"),
  ]);
  const settings = settingsNow();
  assert.equal(settings.defaultProvider, "crow5");
  assert.equal(settings.defaultModel, "gpt-4o");
  assert.equal(buildView(session, {}).currentKey, "crow5#gpt-4o");
});

await step("刷新重新读取配置", async () => {
  const session = createSession(ctx);
  fs.writeFileSync(paths.settings, JSON.stringify({ defaultProvider: "crow5", defaultModel: "claude-sonnet-4-5" }));
  assert.equal(buildView(session, {}).currentKey, "crow5#gpt-4o");
  refresh(session);
  assert.equal(buildView(session, {}).currentKey, "crow5#claude-sonnet-4-5");
});

await step("错误文本清洗密钥", () => {
  const message = safeError(new Error(`request failed: Bearer ${SECRET}`));
  assert.equal(message.includes(SECRET), false);
});

console.error("桌面服务测试全部通过 ✅");
