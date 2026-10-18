#!/usr/bin/env node
// 自动路由服务：读写校验、项目固定档、思考等级叠加与预览。全部在临时目录里跑。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PMH_NO_PROXY = "1";
process.env.PMH_NONINTERACTIVE = "1";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-auto-service-"));
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    demo: {
      baseUrl: "https://demo.test/v1",
      api: "openai-completions",
      apiKey: "sk-test",
      models: [
        { id: "m-cheap", contextWindow: 32000 },
        { id: "m-standard", contextWindow: 128000 },
        { id: "m-strong", contextWindow: 200000 },
      ],
    },
  },
}, null, 2));

const {
  autoConfigPath, defaultAutoConfig, readAutoConfig, resolveProjectRule, writeAutoConfig,
} = await import("../extensions/auto-router/router.mjs");
const { getAutoState, previewRoute, updateAuto } = await import("../src/auto-service.mjs");
const { makeContext } = await import("../src/commands.mjs");

const ctx = makeContext({ agentDir });
const step = (name, fn) => {
  fn();
  console.error(`  ✔ ${name}`);
};

step("默认状态：v2、模型目录与校验提醒", () => {
  const state = getAutoState(ctx);
  assert.equal(state.version, 2);
  assert.equal(state.enabled, true);
  assert.equal(state.useModelThinking, false);
  assert.deepEqual(state.projects, {});
  assert.equal(state.models.length, 3);
  assert.equal(state.validation.ok, true);
  assert.ok(state.validation.issues.some((issue) => issue.message.includes("standard")));
  assert.equal(state.path, autoConfigPath(agentDir));
});

step("保存档位与阈值：写入 v2 并回读", () => {
  const state = updateAuto(ctx, {
    enabled: true,
    pinned: null,
    upgradeOnRetry: false,
    useModelThinking: false,
    thresholds: { cheap: 0.2, strong: 0.6 },
    tiers: {
      cheap: "demo#m-cheap",
      standard: { provider: "demo", model: "m-standard" },
      strong: "demo#m-strong",
    },
  });
  assert.equal(state.version, 2);
  assert.equal(state.upgradeOnRetry, false);
  assert.deepEqual(state.thresholds, { cheap: 0.2, strong: 0.6 });
  assert.equal(state.tiers.cheap.model, "m-cheap");
  assert.equal(state.validation.ok, true);
  const disk = readAutoConfig(agentDir);
  assert.equal(disk.version, 2);
  assert.equal(disk.tiers.strong.provider, "demo");
});

step("非法输入直接拒绝，不静默回默认", () => {
  assert.throws(() => updateAuto(ctx, { thresholds: { cheap: 0.7, strong: 0.3 } }), /阈值/);
  assert.throws(() => updateAuto(ctx, { thresholds: { cheap: -0.1, strong: 0.3 } }), /阈值/);
  assert.throws(() => updateAuto(ctx, { tiers: { cheap: "demo#nope" } }), /不在 models\.json/);
  assert.throws(() => updateAuto(ctx, { tiers: { cheap: "pmh#auto" } }), /pmh\/auto/);
  assert.throws(() => updateAuto(ctx, { pinned: "turbo" }), /固定档位/);
  assert.throws(() => updateAuto(ctx, { enabled: "yes" }), /布尔值/);
  assert.throws(() => updateAuto(ctx, { unknown: 1 }), /不支持的配置项/);
  assert.throws(() => updateAuto(ctx, { projects: { "a*": "strong" } }), /通配符/);
  assert.throws(() => updateAuto(ctx, { projects: { "../up": "strong" } }), /\.\./);
});

step("项目级固定档：保存、匹配目录名与绝对路径", () => {
  const abs = path.resolve(os.tmpdir(), "proj-alpha");
  const state = updateAuto(ctx, {
    projects: {
      "proj-heavy": { pinned: "strong" },
      [abs]: "cheap",
    },
  });
  assert.equal(state.projects["proj-heavy"].pinned, "strong");
  assert.equal(resolveProjectRule(readAutoConfig(agentDir), "proj-heavy").pinned, "strong");
  assert.equal(resolveProjectRule(readAutoConfig(agentDir), path.join(abs, "src")), null);
  assert.equal(resolveProjectRule(readAutoConfig(agentDir), abs).pinned, "cheap");
  assert.equal(resolveProjectRule(readAutoConfig(agentDir), "other"), null);
  assert.equal(resolveProjectRule(readAutoConfig(agentDir), ""), null);
});

step("预览：分类、固定档与项目覆盖", () => {
  updateAuto(ctx, { pinned: null, projects: { "proj-heavy": { pinned: "strong" } } });
  const cheap = previewRoute(ctx, { text: "把错别字改一下" });
  assert.equal(cheap.tier, "cheap");
  assert.equal(cheap.effectiveTier, "cheap");
  assert.equal(cheap.target, "demo#m-cheap");
  assert.equal(cheap.pinnedSource, null);

  const hard = previewRoute(ctx, { text: "重构整个项目的并发架构" });
  assert.equal(hard.tier, "strong");
  assert.equal(hard.target, "demo#m-strong");

  const pinned = previewRoute(ctx, { text: "把错别字改一下" });
  assert.equal(pinned.enabled, true);
  updateAuto(ctx, { pinned: "standard" });
  const fixed = previewRoute(ctx, { text: "把错别字改一下" });
  assert.equal(fixed.tier, "cheap");
  assert.equal(fixed.effectiveTier, "standard");
  assert.equal(fixed.pinnedSource, "global");
  assert.equal(fixed.pinned, "standard");

  const project = previewRoute(ctx, { text: "把错别字改一下", project: "proj-heavy" });
  assert.equal(project.effectiveTier, "strong");
  assert.equal(project.pinnedSource, "project");
  assert.equal(project.projectRule.key, "proj-heavy");

  updateAuto(ctx, { enabled: false, pinned: null });
  const off = previewRoute(ctx, { text: "重构整个项目的并发架构" });
  assert.equal(off.effectiveTier, "standard");
  assert.equal(off.enabled, false);
  updateAuto(ctx, { enabled: true });
});

step("useModelThinking：读取 settings.json 的模型级等级", () => {
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultThinkingLevel: "low",
    modelThinkingLevels: { "demo/m-strong": "high" },
  }, null, 2));
  const before = previewRoute(ctx, { text: "重构整个项目的并发架构" });
  assert.equal(before.thinking, null);
  updateAuto(ctx, { useModelThinking: true, pinned: null });
  const after = previewRoute(ctx, { text: "重构整个项目的并发架构" });
  assert.equal(after.thinking, "high");
  assert.equal(readAutoConfig(agentDir).useModelThinking, true);
});

step("v1 配置读取时迁移为 v2，未知字段被丢弃", () => {
  const file = autoConfigPath(agentDir);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    enabled: false,
    pinned: "cheap",
    tiers: { cheap: "demo#m-cheap" },
    thresholds: { cheap: 0.1, strong: 0.4 },
    upgradeOnRetry: true,
    legacyField: "drop-me",
  }));
  const state = getAutoState(ctx);
  assert.equal(state.version, 2);
  assert.equal(state.enabled, false);
  assert.equal(state.pinned, "cheap");
  assert.equal(state.useModelThinking, false);
  assert.deepEqual(state.projects, {});
  assert.equal("legacyField" in state, false);
  updateAuto(ctx, { enabled: true });
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(disk.version, 2);
  assert.equal("legacyField" in disk, false);
});

step("空项目规则与清除固定档", () => {
  const state = updateAuto(ctx, { projects: {}, pinned: null, useModelThinking: false });
  assert.deepEqual(state.projects, {});
  assert.equal(state.pinned, null);
});

assert.deepEqual(defaultAutoConfig().projects, {});
console.error("auto-service: all checks passed");
