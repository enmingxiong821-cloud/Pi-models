#!/usr/bin/env node
// 站点/模型/Key/思考等级的写入语义测试（不联网、不碰真实 agent 目录）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAuth, loadModels, loadSettings } from "../src/commands.mjs";
import { applyProviderPlan, clearProviderKey, deleteProvider, planProvider, setProviderKey } from "../src/provider-core.mjs";
import { applyModelChange, costLevel, normalizeModelPatch, removeModel } from "../src/model-core.mjs";
import { getThinkingState, setGlobalThinking, setModelThinking } from "../src/settings-service.mjs";
import { getProviderDetail, listProviders, saveModel } from "../src/admin-service.mjs";
import { configPaths } from "../src/paths.mjs";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-admin-"));
const paths = configPaths(agentDir);
const ctx = { agentDir, paths, flags: {} };
const SECRET = "sk-provider-test-secret-123456";
const SECRET2 = "sk-provider-test-secret-654321";

fs.writeFileSync(paths.models, JSON.stringify({
  providers: {
    demo: {
      name: "Demo",
      baseUrl: "https://demo.invalid/v1",
      api: "openai-completions",
      models: [{ id: "alpha", contextWindow: 128000, cost: { input: 1, output: 2 } }],
    },
  },
}));
fs.writeFileSync(paths.settings, JSON.stringify({ defaultProvider: "demo", defaultModel: "alpha" }));

const step = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

await step("plan 不落盘、不含 Key", async () => {
  const plan = await planProvider(ctx, {
    provider: "newrelay",
    name: "New Relay",
    baseUrl: "https://new.invalid/v1/",
    api: "openai-completions",
    key: SECRET,
    discover: false,
  });
  assert.equal(plan.id, "newrelay");
  assert.equal(plan.provider.baseUrl, "https://new.invalid/v1");
  assert.equal(JSON.stringify(plan).includes(SECRET), false);
  assert.equal(loadModels(ctx).providers.newrelay, undefined);
});

await step("plan/apply 写 models 与 auth，且不生成含 Key 的备份", async () => {
  const plan = await planProvider(ctx, {
    provider: "newrelay",
    name: "New Relay",
    baseUrl: "https://new.invalid",
    api: "openai-completions",
    key: SECRET,
    discover: false,
  });
  const result = applyProviderPlan(ctx, plan, { key: SECRET });
  assert.equal(result.created, true);
  assert.equal(loadModels(ctx).providers.newrelay.baseUrl, "https://new.invalid/v1");
  assert.equal(loadAuth(ctx).newrelay.key, SECRET);
  const backups = fs.readdirSync(agentDir).filter((name) => name.startsWith("auth.json.bak-"));
  assert.deepEqual(backups, []);
  // Windows 上 chmod 只有只读位，0600 无法体现；其余平台必须收紧。
  if (process.platform !== "win32") assert.equal(fs.statSync(paths.auth).mode & 0o777, 0o600);
});

await step("替换 Key 时把旧 Key 存成 default 别名；清除时全删", async () => {
  setProviderKey(ctx, "newrelay", SECRET2);
  const auth = loadAuth(ctx);
  assert.equal(auth.newrelay.key, SECRET2);
  assert.equal(auth["newrelay@default"].key, SECRET);
  const cleared = clearProviderKey(ctx, "newrelay");
  assert.equal(cleared.removed >= 2, true);
  const after = loadAuth(ctx);
  assert.equal(after.newrelay, undefined);
  assert.equal(after["newrelay@default"], undefined);
  assert.equal(cleared.remaining.configured, false);
});

await step("换站必须提供新 Key 或确认复用", async () => {
  setProviderKey(ctx, "demo", SECRET);
  await assert.rejects(
    () => planProvider(ctx, { provider: "demo", baseUrl: "https://other.invalid", discover: false }),
    /旧 Key/,
  );
  const okPlan = await planProvider(ctx, {
    provider: "demo", baseUrl: "https://other.invalid", discover: false, reuseKey: true,
  });
  assert.equal(okPlan.provider.baseUrl, "https://other.invalid/v1");
});

await step("模型 add / override / remove", () => {
  const added = applyModelChange(ctx, {
    provider: "demo",
    model: "gamma",
    mode: "add",
    patch: { contextWindow: 64000, reasoning: true, image: true, cost: { input: 0.5, output: 1.5 } },
  });
  assert.equal(added.created, true);
  const model = loadModels(ctx).providers.demo.models.find((item) => item.id === "gamma");
  assert.equal(model.contextWindow, 64000);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.cost.input, 0.5);

  applyModelChange(ctx, { provider: "demo", model: "alpha", mode: "override", patch: { maxTokens: 8192 } });
  assert.equal(loadModels(ctx).providers.demo.modelOverrides.alpha.maxTokens, 8192);
  assert.equal(getProviderDetail(ctx, "demo").models.filter((item) => item.id === "alpha").length, 1);

  removeModel(ctx, { provider: "demo", model: "gamma" });
  assert.equal(loadModels(ctx).providers.demo.models.some((item) => item.id === "gamma"), false);
});

await step("模型字段白名单与成本等级", () => {
  assert.throws(() => normalizeModelPatch({ evil: 1 }), /不支持/);
  assert.throws(() => normalizeModelPatch({ contextWindow: -1 }), /大于 0/);
  assert.throws(() => normalizeModelPatch({ cost: { evil: 1 } }), /不支持/);
  assert.deepEqual(costLevel({ input: 0.5, output: 0.5 }).level, "low");
  assert.deepEqual(costLevel({ input: 3, output: 4 }).level, "medium");
  assert.deepEqual(costLevel({ input: 20, output: 40 }).level, "high");
  assert.equal(costLevel(null), null);
});

await step("思考等级：全局、模型覆盖、继承", () => {
  setGlobalThinking(ctx, "medium");
  assert.equal(getThinkingState(ctx, "demo", "alpha").effective, "medium");
  setModelThinking(ctx, "demo", "alpha", "high");
  const state = getThinkingState(ctx, "demo", "alpha");
  assert.equal(state.effective, "high");
  assert.equal(state.source, "model");
  setModelThinking(ctx, "demo", "alpha", null);
  assert.equal(getThinkingState(ctx, "demo", "alpha").effective, "medium");
  setGlobalThinking(ctx, null);
  assert.equal(getThinkingState(ctx, "demo", "alpha").effective, null);
  assert.throws(() => setGlobalThinking(ctx, "ultra"), /思考等级/);
});

await step("admin DTO 不泄露 Key", () => {
  setProviderKey(ctx, "demo", SECRET);
  const list = listProviders(ctx);
  const detail = getProviderDetail(ctx, "demo");
  assert.equal(JSON.stringify(list).includes(SECRET), false);
  assert.equal(JSON.stringify(detail).includes(SECRET), false);
  assert.equal(detail.provider.credential.configured, true);
  assert.equal(detail.provider.credential.source, "auth.json");
  assert.equal(detail.models.some((item) => item.id === "alpha" && item.costTier.label === "中"), true);
});

await step("删除站点：确认名、默认站点需 force、清理 settings/auth/registry", () => {
  assert.throws(() => deleteProvider(ctx, "demo", { confirm: "nope" }), /确认删除/);
  assert.throws(() => deleteProvider(ctx, "demo", { confirm: "demo" }), /默认站点/);
  applyModelChange(ctx, { provider: "demo", model: "alpha", mode: "override", patch: { maxTokens: 4096 } });
  const result = deleteProvider(ctx, "demo", { confirm: "demo", force: true });
  assert.equal(result.keysRemoved >= 1, true);
  assert.equal(loadModels(ctx).providers.demo, undefined);
  assert.equal(loadAuth(ctx).demo, undefined);
  const settings = loadSettings(ctx);
  assert.equal(settings.defaultProvider, undefined);
  assert.equal(settings.defaultModel, undefined);
});

await step("保存模型走 admin DTO", () => {
  const saved = saveModel(ctx, {
    provider: "newrelay",
    model: "beta",
    mode: "add",
    patch: { name: "Beta", contextWindow: 32000, cost: { input: 1, output: 1 } },
  });
  assert.equal(saved.result.created, true);
  assert.equal(saved.detail.models.some((item) => item.id === "beta"), true);
});

fs.rmSync(agentDir, { recursive: true, force: true });
console.error("站点/模型/思考等级测试全部通过 ✅");
