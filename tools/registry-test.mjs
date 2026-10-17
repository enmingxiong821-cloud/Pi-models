#!/usr/bin/env node
// 注册表测试：从 models.json 回填、分组、收藏、MRU、损坏回退、原子写。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HISTORY_LIMIT, MRU_LIMIT, addFavorite, addGroup, emptyRegistry, loadRegistry, normalizeRegistry,
  recentModels, recordDefaultHistory, recordUse, removeFavorite, removeGroup, removeRelay,
  saveRegistry, setRelayGroup, setWidgetMode, takeDefaultHistory, toggleFavorite,
} from "../src/registry.mjs";
import { configPaths } from "../src/paths.mjs";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-reg-"));
const paths = configPaths(agentDir);
fs.writeFileSync(
  paths.models,
  JSON.stringify({
    providers: {
      crow5: { baseUrl: "https://x.crow5.com/v1", api: "openai-completions", models: [{ id: "claude-sonnet-4-5" }] },
      kimi: { baseUrl: "https://api.kimi.com/v1", api: "openai-completions" },
    },
  }),
);
fs.writeFileSync(paths.auth, JSON.stringify({ crow5: { type: "api_key", key: "sk-aaaaaaaaaaaa" } }));
const ctx = { agentDir, paths, flags: {} };

const step = (name, fn) => {
  fn();
  console.error(`  ✔ ${name}`);
};

step("没有注册表时从 models.json + auth.json 回填，且不落盘", () => {
  const { registry, stale, corrupt, changed } = loadRegistry(ctx);
  assert.equal(corrupt, false);
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(registry.relays).sort(), ["crow5", "kimi"]);
  assert.equal(registry.relays.crow5.root, "https://x.crow5.com");
  assert.equal(registry.relays.crow5.api, "openai-completions");
  assert.deepEqual(registry.relays.crow5.keyAliases, ["default"]);
  assert.equal(registry.relays.crow5.activeKey, "default");
  assert.deepEqual(registry.relays.kimi.keyAliases, []);
  assert.deepEqual(stale, []);
  assert.equal(fs.existsSync(paths.registry), false);
});

step("分组：新增 / 归属 / 删除后自动解绑", () => {
  const { registry } = loadRegistry(ctx);
  addGroup(registry, "code", { title: "写代码" });
  setRelayGroup(registry, "crow5", "code");
  assert.equal(registry.relays.crow5.group, "code");
  removeGroup(registry, "code");
  assert.equal(registry.relays.crow5.group, null);
  assert.throws(() => setRelayGroup(registry, "crow5", "nope"), /不存在/);
  assert.throws(() => addGroup(registry, "bad name"), /分组名/);
});

step("收藏：增删与切换", () => {
  const { registry } = loadRegistry(ctx);
  assert.equal(addFavorite(registry, "crow5", "claude-sonnet-4-5"), true);
  assert.equal(addFavorite(registry, "crow5", "claude-sonnet-4-5"), false);
  assert.equal(toggleFavorite(registry, "crow5", "claude-sonnet-4-5"), false);
  assert.deepEqual(registry.relays.crow5.favorites, []);
  assert.equal(toggleFavorite(registry, "crow5", "gpt-5"), true);
  assert.equal(removeFavorite(registry, "crow5", "gpt-5"), true);
  assert.equal(removeFavorite(registry, "crow5", "gpt-5"), false);
});

step("MRU：去重、置顶、上限 20", () => {
  const registry = emptyRegistry();
  registry.relays.crow5 = { id: "crow5", mru: [], favorites: [] };
  recordUse(registry, "crow5", "a", { at: "2026-01-01T00:00:00Z" });
  recordUse(registry, "crow5", "b", { at: "2026-01-02T00:00:00Z" });
  recordUse(registry, "crow5", "a", { at: "2026-01-03T00:00:00Z" });
  assert.deepEqual(registry.relays.crow5.mru.map((e) => e.model), ["a", "b"]);
  assert.equal(registry.relays.crow5.lastModel, "a");
  for (let i = 0; i < 30; i++) recordUse(registry, "crow5", `m${i}`);
  assert.equal(registry.relays.crow5.mru.length, MRU_LIMIT);
  assert.equal(registry.relays.crow5.mru[0].model, "m29");
});

step("recentModels 跨站按时间倒序", () => {
  const registry = emptyRegistry();
  registry.relays.a = { id: "a", mru: [{ model: "x", at: "2026-01-01T00:00:00Z" }] };
  registry.relays.b = { id: "b", mru: [{ model: "y", at: "2026-01-02T00:00:00Z" }] };
  assert.deepEqual(recentModels(registry).map((r) => `${r.provider}/${r.model}`), ["b/y", "a/x"]);
});

step("保存：原子写、默认留备份、可关闭备份", () => {
  const { registry } = loadRegistry(ctx);
  addGroup(registry, "code");
  const first = saveRegistry(ctx, registry);
  assert.equal(first, null); // 首次创建没有旧文件可备份
  const backup = saveRegistry(ctx, registry);
  assert.ok(backup && fs.existsSync(backup));
  const saved = JSON.parse(fs.readFileSync(paths.registry, "utf8"));
  assert.equal(saved.groups.code.title, "code");
  const again = saveRegistry(ctx, registry, { backup: false });
  assert.equal(again, null);
  assert.ok(fs.readFileSync(paths.registry, "utf8").includes('"code"'));
});

step("坏注册表：不抛错，回退重建；备份关掉时也强制留档", () => {
  fs.writeFileSync(paths.registry, "{ not json");
  const before = fs.readdirSync(agentDir).filter((f) => f.startsWith("pmh-relays.json.bak-")).length;
  const { registry, corrupt, reason } = loadRegistry(ctx);
  assert.equal(corrupt, true);
  assert.match(reason, /无法解析/);
  assert.equal(registry.relays.crow5.name, "crow5");
  saveRegistry(ctx, registry, { backup: false });
  const backups = fs.readdirSync(agentDir).filter((f) => f.startsWith("pmh-relays.json.bak-"));
  assert.equal(backups.length, before + 1, "损坏文件必须留一份备份");
  assert.ok(backups.some((f) => fs.readFileSync(path.join(agentDir, f), "utf8") === "{ not json"));
});

step("models.json 手工改动会对齐，provider 消失则标为 stale", () => {
  const data = JSON.parse(fs.readFileSync(paths.models, "utf8"));
  data.providers.crow5.baseUrl = "https://new.example.com/v1";
  delete data.providers.kimi;
  fs.writeFileSync(paths.models, JSON.stringify(data));
  const { registry, stale } = loadRegistry(ctx, { auth: { crow5: { key: "sk-x" } } });
  assert.equal(registry.relays.crow5.root, "https://new.example.com");
  assert.deepEqual(stale, ["kimi"]);
  assert.equal(removeRelay(registry, "kimi"), true);
  assert.equal(registry.relays.kimi, undefined);
});

step("默认模型历史：去重、上限、出栈、坏数据丢弃", () => {
  const registry = emptyRegistry();
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
    recordDefaultHistory(registry, { provider: "crow5", model: `m-${i}` });
  }
  assert.equal(registry.history.length, HISTORY_LIMIT);
  assert.equal(registry.history[0].model, `m-${HISTORY_LIMIT + 4}`);

  recordDefaultHistory(registry, { provider: "crow5", model: `m-${HISTORY_LIMIT + 4}` });
  assert.equal(registry.history.length, HISTORY_LIMIT, "重复项应先移除再入栈");
  assert.equal(registry.history[0].model, `m-${HISTORY_LIMIT + 4}`);

  assert.equal(takeDefaultHistory(registry).model, `m-${HISTORY_LIMIT + 4}`);
  assert.equal(registry.history.length, HISTORY_LIMIT - 1);
  assert.equal(takeDefaultHistory(emptyRegistry()), null);

  const normalized = normalizeRegistry({
    history: [{ provider: "a", model: "x" }, { model: "no-provider" }, null, { provider: "" }],
  });
  assert.deepEqual(normalized.history.map((e) => e.provider), ["a"]);
});

step("widget 模式校验", () => {
  const registry = emptyRegistry();
  assert.equal(setWidgetMode(registry, "on"), "on");
  assert.throws(() => setWidgetMode(registry, "sometimes"), /widget/);
});

console.error("\nregistry-test: 全部通过");
