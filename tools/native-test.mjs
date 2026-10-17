#!/usr/bin/env node
// pi 原生能力测试：本机服务预设、内置 provider 解析、models.json 校验、pmh model 增删改。
// 全部在临时目录里跑，不发网络请求。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.PMH_NO_PROXY = "1";
process.env.PMH_NONINTERACTIVE = "1";
delete process.env.PMH_TEST_MISSING_KEY;

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CATALOG = path.join(here, "fixtures", "catalog");

const {
  loadBuiltinProviders, parseCost, parseCount, providerHasContent, resolveLocalPreset, validateModelsConfig,
} = await import("../src/native.mjs");
const { cmdLocal, cmdModel, makeContext } = await import("../src/commands.mjs");
const { completionCandidates } = await import("../src/completion.mjs");

const step = (name, fn) => {
  fn();
  console.error(`  ✔ ${name}`);
};
const stepAsync = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

// ---- 假的 pi 安装目录：只放 pi-ai 的 provider 元数据，够静态解析用 ----
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-native-"));
const installRoot = path.join(agentDir, "install", "releases", "1.3.0");
const providersDir = path.join(installRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "providers");
const pkgDir = path.join(installRoot, "node_modules", "@earendil-works", "pi-coding-agent");
fs.mkdirSync(providersDir, { recursive: true });
fs.mkdirSync(pkgDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "install", "current-version"), "1.3.0");
fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.3.0" }));
fs.writeFileSync(
  path.join(providersDir, "openai.js"),
  'export const openaiProvider = {\n  id: "openai",\n  name: "OpenAI",\n  baseUrl: "https://api.openai.com/v1",\n  api: openAIResponsesApi(),\n};\n',
);
fs.writeFileSync(
  path.join(providersDir, "acme.js"),
  'const ACME_BASE_URL = "https://acme.test/v1";\nexport const acmeProvider = {\n  id: "acme",\n  name: "Acme",\n  baseUrl: ACME_BASE_URL,\n  api: openAICompletionsApi(),\n};\n',
);
fs.writeFileSync(path.join(providersDir, "index.js"), 'export const bogus = { id: "bogus" };\n');
fs.writeFileSync(path.join(providersDir, "all.js"), 'export const bogus = { id: "bogus" };\n');

const modelsFile = path.join(agentDir, "models.json");
fs.writeFileSync(modelsFile, JSON.stringify({
  providers: { demo: { name: "Demo", baseUrl: "http://127.0.0.1:9999/v1", api: "openai-completions" } },
}, null, 2));

const ctx = () => makeContext({ agentDir, catalog: FIXTURE_CATALOG });
const readModels = () => JSON.parse(fs.readFileSync(modelsFile, "utf8"));
const capture = async (fn) => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
};

const has = (list, at, pattern) => list.some((item) => item.path === at && pattern.test(item.message));

step("parseCount：k/m 后缀与非法输入", () => {
  assert.equal(parseCount("200k"), 200000);
  assert.equal(parseCount("1m"), 1000000);
  assert.equal(parseCount("128000"), 128000);
  assert.equal(parseCount("1.5k"), 1500);
  assert.throws(() => parseCount("0"), /大于 0/);
  assert.throws(() => parseCount("abc"), /需要数字/);
});

step("parseCost：非负数字并保留 6 位小数", () => {
  assert.equal(parseCost("3"), 3);
  assert.equal(parseCost("0.1234567"), 0.123457);
  assert.throws(() => parseCost("-1"), /非负数字/);
  assert.throws(() => parseCost("free"), /非负数字/);
});

step("resolveLocalPreset：别名、--port、--base", () => {
  assert.equal(resolveLocalPreset("ollama").root, "http://127.0.0.1:11434");
  assert.equal(resolveLocalPreset("LM Studio").id, "lmstudio");
  assert.equal(resolveLocalPreset("llama.cpp").id, "llama-cpp");
  assert.equal(resolveLocalPreset("ollama", { port: "11500" }).root, "http://127.0.0.1:11500");
  assert.equal(resolveLocalPreset("vllm", { base: "http://192.168.1.8:8001/" }).root, "http://192.168.1.8:8001/");
  assert.throws(() => resolveLocalPreset("nope"), /不认识的本机服务/);
  assert.throws(() => resolveLocalPreset("", {}), /缺少本机服务名/);
  assert.throws(() => resolveLocalPreset("ollama", { port: "70000" }), /1-65535/);
});

step("loadBuiltinProviders：静态解析 id / baseUrl / api，跳过 index 与 all", () => {
  const { providers, dir } = loadBuiltinProviders(agentDir);
  assert.equal(dir, providersDir);
  assert.deepEqual([...providers.keys()].sort(), ["acme", "openai"]);
  assert.equal(providers.get("openai").baseUrl, "https://api.openai.com/v1");
  assert.equal(providers.get("openai").api, "openai-responses");
  assert.equal(providers.get("acme").baseUrl, "https://acme.test/v1");
  assert.equal(providers.get("acme").api, "openai-completions");
  assert.equal(loadBuiltinProviders(null, { providersDir: path.join(agentDir, "missing") }).providers.size, 0);
});

step("providerHasContent：镜像 pi 的最低要求", () => {
  assert.equal(providerHasContent({ baseUrl: "https://x.test/v1" }), true);
  assert.equal(providerHasContent({ models: [{ id: "m" }] }), true);
  assert.equal(providerHasContent({ modelOverrides: { m: { cost: {} } } }), true);
  assert.equal(providerHasContent({ apiKey: "sk-x" }), true);
  assert.equal(providerHasContent({}), false);
  assert.equal(providerHasContent({ name: "只有名字", models: [] }), false);
  assert.equal(providerHasContent({ modelOverrides: {} }), false);
});

step("validateModelsConfig：合法配置零错误零警告", () => {
  const report = validateModelsConfig({
    models: {
      providers: {
        relay: {
          baseUrl: "https://relay.test/v1",
          api: "openai-completions",
          apiKey: "sk-test",
          models: [{
            id: "gpt-x",
            contextWindow: 128000,
            maxTokens: 8192,
            input: ["text", "image"],
            cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
          }],
          modelOverrides: { "gpt-x": { contextWindow: 64000 } },
        },
      },
    },
    settings: { defaultProvider: "relay", defaultModel: "gpt-x" },
  });
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);
});

step("validateModelsConfig：结构、字段、凭据与默认值问题", () => {
  const report = validateModelsConfig({
    models: {
      providers: {
        empty: {},
        relay: {
          baseUrl: "ftp://relay.test",
          api: "",
          extra: true,
          models: [
            { name: "没有 id" },
            { id: "dup", contextWindow: 0, maxTokens: -1, input: ["audio"], cost: { input: -1 } },
            { id: "dup" },
            { id: "dup2", baseUrl: "not-a-url" },
          ],
          modelOverrides: { ghost: { contextWindow: 0, bogus: 1 } },
        },
      },
    },
    settings: { defaultProvider: "missing", defaultModel: "x" },
  });
  assert.ok(has(report.errors, "providers.empty", /空 provider/));
  assert.ok(has(report.errors, "providers.relay.baseUrl", /http\(s\)/));
  assert.ok(has(report.errors, "providers.relay.api", /非空字符串/));
  assert.ok(has(report.warnings, "providers.relay.extra", /不认识/));
  assert.ok(has(report.errors, "providers.relay.models[0].id", /非空 id/));
  assert.ok(has(report.errors, "providers.relay.models[1].contextWindow", /大于 0/));
  assert.ok(has(report.errors, "providers.relay.models[1].maxTokens", /大于 0/));
  assert.ok(has(report.warnings, "providers.relay.models[1].input", /text/));
  assert.ok(has(report.warnings, "providers.relay.models[1].cost.input", /非负/));
  assert.ok(has(report.errors, "providers.relay.models[2].id", /重复/));
  assert.ok(has(report.errors, "providers.relay.models[3].baseUrl", /http\(s\)/));
  assert.ok(has(report.errors, "providers.relay.modelOverrides.ghost.contextWindow", /大于 0/));
  assert.ok(has(report.warnings, "providers.relay.modelOverrides.ghost.bogus", /不认识/));
  assert.ok(has(report.warnings, "providers.relay.modelOverrides.ghost", /不在本 provider 的 models/));
  assert.ok(has(report.warnings, "providers.relay", /没有可解析的凭据/));
  assert.ok(has(report.warnings, "settings.defaultProvider", /不在 models.json/));
});

step("validateModelsConfig：内置 provider 的 override 不误报凭据", () => {
  const builtins = loadBuiltinProviders(agentDir).providers;
  const report = validateModelsConfig({
    models: { providers: { openai: { modelOverrides: { "gpt-5.5": { contextWindow: 400000, maxTokens: 128000 } } } } },
    builtins,
  });
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);
});

step("validateModelsConfig：缺 providers 直接报错", () => {
  const report = validateModelsConfig({ models: {} });
  assert.ok(has(report.errors, "providers", /缺少 providers/));
});

await stepAsync("pmh model add：补全元数据并写入 models", async () => {
  await capture(() => cmdModel(ctx(), ["add", "demo", "demo-chat"], {
    ctx: "200k", maxOutput: "64k", costIn: "1.5", costOut: "3", reasoning: true, image: true,
  }));
  const provider = readModels().providers.demo;
  const entry = provider.models.find((m) => m.id === "demo-chat");
  assert.ok(entry);
  assert.equal(entry.contextWindow, 200000);
  assert.equal(entry.maxTokens, 64000);
  assert.equal(entry.reasoning, true);
  assert.deepEqual(entry.input, ["text", "image"]);
  assert.deepEqual(entry.cost, { input: 1.5, output: 3, cacheRead: 0, cacheWrite: 0 });
});

await stepAsync("pmh model override：只写元数据，不动 models 条目", async () => {
  await capture(() => cmdModel(ctx(), ["override", "demo", "demo-chat"], { ctx: "100k" }));
  const provider = readModels().providers.demo;
  assert.equal(provider.models.find((m) => m.id === "demo-chat").contextWindow, 200000);
  assert.deepEqual(provider.modelOverrides["demo-chat"], { contextWindow: 100000 });
});

await stepAsync("pmh model override：价格可以只改一个字段（按字段合并）", async () => {
  await capture(() => cmdModel(ctx(), ["override", "demo", "demo-chat"], { costOut: "9" }));
  assert.deepEqual(readModels().providers.demo.modelOverrides["demo-chat"], {
    contextWindow: 100000,
    cost: { output: 9 },
  });
});

await stepAsync("pmh model add：同 id 重复添加是替换而非追加", async () => {
  await capture(() => cmdModel(ctx(), ["add", "demo", "demo-chat"], { name: "Demo Chat" }));
  const entries = readModels().providers.demo.models.filter((m) => m.id === "demo-chat");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "Demo Chat");
});

await stepAsync("pmh model override：--base/--api 被拒绝", async () => {
  await assert.rejects(
    () => capture(() => cmdModel(ctx(), ["override", "demo", "demo-chat"], { api: "anthropic-messages" })),
    /只改模型元数据/,
  );
});

await stepAsync("pmh model rm：同时清掉 override，provider 仍有 baseUrl 时保留", async () => {
  await capture(() => cmdModel(ctx(), ["rm", "demo", "demo-chat"], {}));
  const provider = readModels().providers.demo;
  assert.equal(provider.models, undefined);
  assert.equal(provider.modelOverrides, undefined);
  assert.equal(provider.baseUrl, "http://127.0.0.1:9999/v1");
});

await stepAsync("pmh model：内置 provider 用 modelOverrides，清空后整条配置移除", async () => {
  await capture(() => cmdModel(ctx(), ["override", "openai", "gpt-5.5"], { ctx: "400k" }));
  assert.deepEqual(readModels().providers.openai.modelOverrides["gpt-5.5"], { contextWindow: 400000 });
  await capture(() => cmdModel(ctx(), ["rm", "openai", "gpt-5.5", "--override-only"], { overrideOnly: true }));
  assert.equal(readModels().providers.openai, undefined);
});

await stepAsync("pmh local：写占位 Key 到 models.json，不碰 auth.json", async () => {
  await capture(() => cmdLocal(ctx(), "ollama", { model: "llama3.2", port: "11500" }));
  const provider = readModels().providers.ollama;
  assert.equal(provider.baseUrl, "http://127.0.0.1:11500/v1");
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.apiKey, "ollama");
  assert.deepEqual(provider.models.map((m) => m.id), ["llama3.2"]);
  assert.equal(fs.existsSync(path.join(agentDir, "auth.json")), false);
});

step("补全：local / model 的子命令与 preset", () => {
  assert.ok(completionCandidates(ctx(), { command: "local", word: "" }).includes("ollama"));
  assert.ok(completionCandidates(ctx(), { command: "local", word: "llama" }).includes("llama-cpp"));
  assert.ok(completionCandidates(ctx(), { command: "model", word: "ov" }).includes("override"));
  assert.ok(completionCandidates(ctx(), { command: "model", word: "" }).includes("demo"));
  assert.ok(completionCandidates(ctx(), { command: "model", word: "--c" }).includes("--ctx"));
});

console.error("native: all checks passed");
