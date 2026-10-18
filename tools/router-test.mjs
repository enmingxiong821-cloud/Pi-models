#!/usr/bin/env node
// 自动选模型：分类器、配置、扩展路由、CLI。全部在临时目录里跑，不发网络请求。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.PMH_NO_PROXY = "1";
process.env.PMH_NONINTERACTIVE = "1";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CATALOG = path.join(here, "fixtures", "catalog");
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-router-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
  TIERS, autoConfigPath, classifyTask, defaultAutoConfig, formatTierSpec, normalizeAutoConfig,
  parseTierSpec, readAutoConfig, tierForScore, writeAutoConfig,
} = await import("../extensions/auto-router/router.mjs");
const { cmdAuto, makeContext } = await import("../src/commands.mjs");
const { default: autoRouter } = await import("../extensions/auto-router/index.js");

const step = (name, fn) => {
  fn();
  console.error(`  ✔ ${name}`);
};
const stepAsync = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

const capture = async (fn) => {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines.join("\n");
};

// 一份最小的 models.json，供 CLI 校验 provider 与档位。
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

step("parseTierSpec / formatTierSpec：provider#model 与 provider/model", () => {
  assert.deepEqual(parseTierSpec("openai#gpt-5.5"), { provider: "openai", model: "gpt-5.5" });
  assert.deepEqual(parseTierSpec("openrouter/anthropic/claude"), { provider: "openrouter", model: "anthropic/claude" });
  assert.deepEqual(parseTierSpec("demo#meta-llama/Llama-3"), { provider: "demo", model: "meta-llama/Llama-3" });
  assert.equal(formatTierSpec({ provider: "a", model: "b" }), "a#b");
  assert.throws(() => parseTierSpec("nope"), /provider#model/);
  assert.throws(() => parseTierSpec(""), /缺少/);
});

step("normalizeAutoConfig：容错、字符串档位与非法阈值", () => {
  const cfg = normalizeAutoConfig({
    enabled: "yes",
    pinned: "turbo",
    tiers: { cheap: "demo#m-cheap", strong: { provider: "demo", model: "m-strong" } },
    thresholds: { cheap: 0.9, strong: 0.2 },
    upgradeOnRetry: false,
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.pinned, null);
  assert.equal(cfg.tiers.cheap.model, "m-cheap");
  assert.equal(cfg.tiers.strong.model, "m-strong");
  assert.deepEqual(cfg.thresholds, defaultAutoConfig().thresholds);
  assert.equal(cfg.upgradeOnRetry, false);
});

step("writeAutoConfig / readAutoConfig：原子写并回读", () => {
  const file = writeAutoConfig({ ...defaultAutoConfig(), enabled: false, tiers: { cheap: { provider: "demo", model: "m-cheap" } } }, agentDir);
  assert.equal(file, autoConfigPath(agentDir));
  const back = readAutoConfig(agentDir);
  assert.equal(back.enabled, false);
  assert.equal(formatTierSpec(back.tiers.cheap), "demo#m-cheap");
  assert.equal(back.tiers.standard, null);
});

step("classifyTask：简单任务降档", () => {
  for (const text of [
    "把 README 里的错别字改一下",
    "帮我翻译这段话",
    "解释一下这个函数是干什么的",
    "格式化 src/index.js",
    "rename this variable",
    "summarize this paragraph",
  ]) {
    const result = classifyTask(text);
    assert.equal(result.tier, "cheap", `${text} -> ${result.tier} (${result.score})`);
  }
});

step("classifyTask：中性 / 常规任务落在 standard", () => {
  const result = classifyTask("帮我修复登录页的 bug，顺便补一条回归测试");
  assert.equal(result.tier, "standard", `${result.tier} ${result.score}`);
});

step("classifyTask：架构、并发、多文件升到 strong", () => {
  const result = classifyTask("设计多模块的插件架构，重构整个项目的并发处理，涉及 src/a.mjs 和 src/b.mjs");
  assert.equal(result.tier, "strong", `${result.tier} ${result.score}`);
  assert.ok(result.reasons.some((r) => r.includes("架构") || r.includes("并发")));
});

step("classifyTask：堆栈与测试失败加权", () => {
  const trace = classifyTask("Traceback (most recent call last):\n  File \"app.py\", line 1\nError: boom\n帮我修一下");
  assert.ok(trace.score >= 0.25);
  const failing = classifyTask("测试失败了，帮我看看怎么修");
  assert.equal(failing.tier, "standard");
  assert.ok(failing.reasons.includes("测试/构建失败"));
});

step("classifyTask：空输入、图片、自定义阈值", () => {
  assert.equal(classifyTask("").tier, "standard");
  const withImage = classifyTask("看看这张图", { images: 1 });
  assert.ok(withImage.reasons.includes("含图片"));
  const strict = classifyTask("帮我修复登录页的 bug", { thresholds: { cheap: 0.05, strong: 0.2 } });
  assert.equal(strict.tier, "strong");
  assert.equal(tierForScore(0.5), "strong");
  assert.equal(tierForScore(0.0), "cheap");
});

// ---- 扩展：用假的 pi / modelRegistry 驱动 route() ----
const physical = {
  cheap: { provider: "demo", id: "m-cheap" },
  standard: { provider: "demo", id: "m-standard" },
  strong: { provider: "demo", id: "m-strong" },
};
const config = {
  ...defaultAutoConfig(),
  tiers: {
    cheap: { provider: "demo", model: "m-cheap" },
    standard: { provider: "demo", model: "m-standard" },
    strong: { provider: "demo", model: "m-strong" },
  },
};
writeAutoConfig(config, agentDir);

const commands = new Map();
let virtualModel = null;
const pi = {
  modelRegistry: {
    find: (provider, id) => Object.values(physical).find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
    getAvailable: () => Object.values(physical),
  },
  registerVirtualModel: (definition) => { virtualModel = definition; },
  registerCommand: (name, options) => { commands.set(name, options); },
  registerShortcut: () => {},
  setModel: async () => true,
};
autoRouter(pi);

const notes = [];
const ctx = {
  model: physical.standard,
  modelRegistry: pi.modelRegistry,
  ui: { notify: (message, type = "info") => notes.push({ message, type }) },
  hasUI: true,
  sessionManager: { getBranch: () => [] },
};
const userRequest = (text, extra = {}) => ({
  model: { provider: "pmh", id: "auto" },
  thinkingLevel: "medium",
  reason: "user",
  messages: [{ role: "user", content: text }],
  ...extra,
});

step("扩展：注册成 pmh/auto 虚拟模型", () => {
  assert.ok(virtualModel);
  assert.equal(virtualModel.provider, "pmh");
  assert.equal(virtualModel.id, "auto");
  assert.ok(commands.has("auto"));
});

step("扩展：首轮按难度选档并返回状态", () => {
  notes.length = 0;
  const simple = virtualModel.route(userRequest("把错别字改一下"), ctx);
  assert.equal(simple.model, physical.cheap);
  assert.equal(simple.state.tier, "cheap");
  assert.ok(notes.some((n) => n.message.includes("轻量")));

  notes.length = 0;
  const hard = virtualModel.route(userRequest("重构整个项目的并发架构", { state: { tier: "cheap" } }), ctx);
  assert.equal(hard.model, physical.strong);
  assert.equal(hard.state.tier, "strong");
  assert.ok(notes.some((n) => n.message.includes("强力")));
});

step("扩展：continuation 沿用上一轮物理模型与思考档", () => {
  const routed = virtualModel.route({
    reason: "continuation",
    thinkingLevel: "medium",
    previous: { model: physical.strong, thinkingLevel: "high" },
    messages: [],
    state: { tier: "strong" },
  }, ctx);
  assert.equal(routed.model, physical.strong);
  assert.equal(routed.thinkingLevel, "high");
});

step("扩展：关闭后固定 standard，且不做过早分类", () => {
  writeAutoConfig({ ...config, enabled: false }, agentDir);
  notes.length = 0;
  const routed = virtualModel.route(userRequest("重构整个项目", { state: { tier: "strong" } }), ctx);
  assert.equal(routed.model, physical.standard);
  assert.equal(routed.state.tier, "standard");
  assert.equal(notes.length, 0);
  writeAutoConfig(config, agentDir);
});

step("扩展：pin 固定档位", () => {
  writeAutoConfig({ ...config, pinned: "strong" }, agentDir);
  const routed = virtualModel.route(userRequest("把错别字改一下"), ctx);
  assert.equal(routed.model, physical.strong);
  assert.equal(routed.state.tier, "strong");
  writeAutoConfig(config, agentDir);
});

step("扩展：失败重试升一档，且只升一次", () => {
  notes.length = 0;
  const first = virtualModel.route({
    reason: "retry",
    thinkingLevel: "medium",
    failed: { model: physical.cheap, thinkingLevel: "low" },
    messages: [],
    state: { tier: "cheap", escalated: false },
  }, ctx);
  assert.equal(first.model, physical.standard);
  assert.equal(first.state.escalated, true);
  assert.ok(notes.some((n) => n.message.includes("升档")));

  const second = virtualModel.route({
    reason: "retry",
    thinkingLevel: "medium",
    failed: { model: physical.standard, thinkingLevel: "low" },
    messages: [],
    state: { tier: "standard", escalated: true },
  }, ctx);
  assert.equal(second.model, physical.standard);
});

step("扩展：未配置档位时退回第一个可用模型并提醒", () => {
  writeAutoConfig({ ...defaultAutoConfig() }, agentDir);
  notes.length = 0;
  const routed = virtualModel.route(userRequest("重构整个项目"), ctx);
  assert.equal(routed.model, physical.cheap); // getAvailable() 的第一个
  assert.ok(notes.some((n) => n.message.includes("还没配置档位")));
  writeAutoConfig(config, agentDir);
});

step("扩展：项目级固定档与 useModelThinking", () => {
  const cwdKey = path.basename(process.cwd());
  writeAutoConfig({
    ...config,
    pinned: null,
    projects: { [cwdKey]: { pinned: "strong" } },
  }, agentDir);
  const routed = virtualModel.route(userRequest("把错别字改一下"), ctx);
  assert.equal(routed.model, physical.strong);
  assert.equal(routed.state.why, "项目固定档");

  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    modelThinkingLevels: { "demo/m-strong": "high" },
  }));
  writeAutoConfig({ ...config, useModelThinking: true }, agentDir);
  const thinking = virtualModel.route(userRequest("把错别字改一下"), ctx);
  assert.equal(thinking.model, physical.cheap);
  assert.equal(thinking.thinkingLevel, "medium");
  const strong = virtualModel.route(userRequest("重构整个项目的并发架构"), ctx);
  assert.equal(strong.thinkingLevel, "high");
  writeAutoConfig(config, agentDir);
});

step("扩展：/auto off 写配置，/auto explain 输出档位", async () => {
  notes.length = 0;
  await commands.get("auto").handler("explain 重构整个项目的并发处理", ctx);
  assert.ok(notes.at(-1).message.includes("强力"));

  notes.length = 0;
  await commands.get("auto").handler("off", ctx);
  assert.equal(readAutoConfig(agentDir).enabled, false);
  assert.ok(notes.some((n) => n.message.includes("已关闭")));
  await commands.get("auto").handler("on", ctx);
  assert.equal(readAutoConfig(agentDir).enabled, true);
});

// ---- CLI ----
const cliCtx = () => makeContext({ agentDir, catalog: FIXTURE_CATALOG });

await stepAsync("CLI：auto set / status --json / explain --json", async () => {
  await capture(() => cmdAuto(cliCtx(), ["set", "cheap", "demo#m-cheap"]));
  await capture(() => cmdAuto(cliCtx(), ["set", "standard=demo#m-standard", "strong=demo#m-strong"]));
  const stored = readAutoConfig(agentDir);
  assert.equal(formatTierSpec(stored.tiers.cheap), "demo#m-cheap");
  assert.equal(formatTierSpec(stored.tiers.strong), "demo#m-strong");

  const status = JSON.parse(await capture(() => cmdAuto(cliCtx(), ["status"], { json: true })));
  assert.equal(status.enabled, true);
  assert.equal(status.tiers.standard.model, "m-standard");
  assert.ok(status.path.endsWith("pmh-auto.json"));

  const explained = JSON.parse(await capture(() => cmdAuto(cliCtx(), ["explain", "重构整个项目的并发处理"], { json: true })));
  assert.equal(explained.tier, "strong");
  assert.equal(explained.target, "demo#m-strong");
});

await stepAsync("CLI：auto on/off/pin/unset", async () => {
  await capture(() => cmdAuto(cliCtx(), ["off"]));
  assert.equal(readAutoConfig(agentDir).enabled, false);
  await capture(() => cmdAuto(cliCtx(), ["on"]));
  assert.equal(readAutoConfig(agentDir).enabled, true);

  await capture(() => cmdAuto(cliCtx(), ["pin", "cheap"]));
  assert.equal(readAutoConfig(agentDir).pinned, "cheap");
  await capture(() => cmdAuto(cliCtx(), ["pin", "off"]));
  assert.equal(readAutoConfig(agentDir).pinned, null);

  await capture(() => cmdAuto(cliCtx(), ["unset", "cheap"]));
  assert.equal(readAutoConfig(agentDir).tiers.cheap, null);
  assert.ok(TIERS.includes("strong"));

  await capture(() => cmdAuto(cliCtx(), ["thresholds", "0.2", "0.6"]));
  assert.deepEqual(readAutoConfig(agentDir).thresholds, { cheap: 0.2, strong: 0.6 });
  await assert.rejects(() => capture(() => cmdAuto(cliCtx(), ["thresholds", "0.7", "0.3"])), /阈值/);
  await capture(() => cmdAuto(cliCtx(), ["thresholds", "0.12", "0.5"]));
});

await stepAsync("CLI：未知档位 / 自己的虚拟模型 / 未配置 provider 被拒绝或提醒", async () => {
  await assert.rejects(() => capture(() => cmdAuto(cliCtx(), ["set", "turbo", "demo#m-cheap"])), /未知档位/);
  await assert.rejects(() => capture(() => cmdAuto(cliCtx(), ["set", "cheap", "pmh#auto"])), /不能把 pmh\/auto/);
  const out = await capture(() => cmdAuto(cliCtx(), ["set", "cheap", "ghost#m"]));
  assert.match(out, /不认识|不在 models\.json/);
});

await stepAsync("CLI：auto install 复制扩展目录", async () => {
  const installAgent = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-router-install-"));
  await capture(() => cmdAuto({ agentDir: installAgent }, ["install"]));
  for (const file of ["index.js", "router.mjs"]) {
    assert.ok(fs.existsSync(path.join(installAgent, "extensions", "pmh-auto", file)), file);
  }
});

console.error("router: all checks passed");
