#!/usr/bin/env node
// 快速切换扩展的测试：直接 import 扩展文件（Node 24 能跑 TypeScript），
// 用一个假的 ExtensionAPI / 上下文把命令跑起来，断言它确实切到了正确的模型。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-ext-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const ext = await import("../extensions/quick-switch.js");

const MODELS = [
  { provider: "openai", id: "gpt-5.5", name: "GPT 5.5", reasoning: true, input: ["text", "image"], contextWindow: 400000 },
  { provider: "crow5", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, input: ["text", "image"], contextWindow: 200000 },
  { provider: "crow5", id: "gemini-3-pro", name: "Gemini 3 Pro", reasoning: true, input: ["text", "image"], contextWindow: 1000000 },
  { provider: "kimi-coding", id: "kimi-k2", name: "Kimi K2", reasoning: false, input: ["text"], contextWindow: 256000 },
];

fs.writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      crow5: { baseUrl: "https://x/v1", models: [{ id: "claude-sonnet-4-5" }, { id: "gemini-3-pro" }] },
    },
  }, null, 2),
);
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.5", theme: "keep-me" }, null, 2));

const step = async (name, fn) => {
  await fn();
  console.error(`  \u2714 ${name}`);
};

// ---- 纯函数 ----
await step("relayProviders 只认 models.json 里的中转站", () => {
  assert.deepEqual(ext.relayProviders(), ["crow5"]);
});

await step("rankModels 把中转站排在最前，其次当前 provider", () => {
  const ranked = ext.rankModels(MODELS, ["crow5"], "kimi-coding").map((m) => `${m.provider}/${m.id}`);
  assert.deepEqual(ranked, ["crow5/claude-sonnet-4-5", "crow5/gemini-3-pro", "kimi-coding/kimi-k2", "openai/gpt-5.5"]);
});

await step("filterModels 支持 id 片段与 provider 前缀", () => {
  assert.deepEqual(ext.filterModels(MODELS, "sonnet").map((m) => m.id), ["claude-sonnet-4-5"]);
  assert.equal(ext.filterModels(MODELS, "crow5/gemini")[0].id, "gemini-3-pro");
  assert.equal(ext.filterModels(MODELS, "不存在的模型").length, 0);
});

await step("labelOf 带上下文与能力标记", () => {
  const label = ext.labelOf(MODELS[1], { current: true, isRelay: true });
  assert.match(label, /^● crow5\/claude-sonnet-4-5/);
  assert.match(label, /200K/);
  assert.match(label, /中转/);
});

await step("persistDefault 改默认值并保留其他设置", () => {
  ext.persistDefault(MODELS[2]);
  const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "crow5");
  assert.equal(settings.defaultModel, "gemini-3-pro");
  assert.equal(settings.theme, "keep-me");
  assert.ok(fs.readdirSync(agentDir).some((f) => f.startsWith("settings.json.bak-")));
});

// ---- 用假 API 跑命令 ----
function makeHarness({ pickIndex } = {}) {
  const commands = new Map();
  const shortcuts = new Map();
  const events = new Map();
  const switches = [];
  const notices = [];
  const statuses = [];
  const widgets = [];
  const pi = {
    registerCommand: (name, opts) => commands.set(name, opts),
    registerShortcut: (key, opts) => shortcuts.set(key, opts),
    on: (name, handler) => events.set(name, handler),
    setModel: async () => true,
  };
  ext.default(pi);
  const ctx = {
    model: MODELS[0],
    modelRegistry: { getAvailable: () => MODELS },
    setModel: async (model) => {
      switches.push(model);
      ctx.model = model;
      return true;
    },
    ui: {
      notify: (msg) => notices.push(msg),
      select: async (title, options = []) => {
        notices.push(`select:${title}`);
        return pickIndex == null ? undefined : options[pickIndex];
      },
      setStatus: (key, text) => statuses.push([key, text]),
      setWidget: (key, lines, opts) => widgets.push([key, lines, opts]),
    },
  };
  return { commands, shortcuts, events, switches, notices, statuses, widgets, ctx };
}

await step("注册了 /switch、/switch-save 和 Ctrl+Shift+M", () => {
  const h = makeHarness();
  assert.ok(h.commands.has("switch"));
  assert.ok(h.commands.has("switch-save"));
  assert.ok(h.shortcuts.has("ctrl+shift+m"));
});

await step("/switch sonnet 唯一命中时直接切换，不弹选择器", async () => {
  const h = makeHarness();
  await h.commands.get("switch").handler("sonnet", h.ctx);
  assert.equal(h.switches.length, 1);
  assert.equal(h.switches[0].provider, "crow5");
  assert.ok(!h.notices.some((n) => n.startsWith("select:")), "不应该弹选择器");
  assert.match(h.notices.at(-1), /已切换到 crow5\/claude-sonnet-4-5/);
});

await step("/switch 无参数时弹选择器，选中即切换", async () => {
  // 排序后：0=crow5/claude-sonnet-4-5，1=crow5/gemini-3-pro，2=kimi，3=openai
  const h = makeHarness({ pickIndex: 1 });
  await h.commands.get("switch").handler("", h.ctx);
  assert.ok(h.notices.some((n) => n.startsWith("select:")), "应该弹选择器");
  assert.equal(h.switches.at(-1).id, "gemini-3-pro");
});

await step("/switch 带关键词但多命中时，选择器只列匹配项", async () => {
  const h = makeHarness({ pickIndex: 0 });
  await h.commands.get("switch").handler("crow5", h.ctx);
  const title = h.notices.find((n) => n.startsWith("select:"));
  assert.match(title, /匹配 "crow5"（2 个）/);
  assert.equal(h.switches.at(-1).provider, "crow5");
});

await step("/switch-save 切换后写入默认模型", async () => {
  const h = makeHarness();
  await h.commands.get("switch-save").handler("kimi", h.ctx);
  const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "kimi-coding");
  assert.match(h.notices.at(-1), /设为新会话默认/);
});

await step("没有匹配时给出提示而不是静默", async () => {
  const h = makeHarness();
  await h.commands.get("switch").handler("zzzz", h.ctx);
  assert.equal(h.switches.length, 0);
  assert.match(h.notices.at(-1), /没有匹配/);
});

await step("凭据缺失时提示而不是假装成功", async () => {
  const h = makeHarness();
  h.ctx.setModel = async () => false;
  await h.commands.get("switch").handler("sonnet", h.ctx);
  assert.match(h.notices.at(-1), /还没有可用凭据/);
});

// ---- v0.2：过滤语法、收藏/MRU 排序、状态栏与 widget ----
const registryPath = path.join(agentDir, "pmh-relays.json");
const writeRegistry = (data) => fs.writeFileSync(registryPath, JSON.stringify(data, null, 2));
const readRegistryFile = () => JSON.parse(fs.readFileSync(registryPath, "utf8"));

const REGISTRY = {
  version: 1,
  groups: { code: { title: "写代码" } },
  relays: {
    crow5: {
      id: "crow5",
      group: "code",
      favorites: ["gemini-3-pro"],
      mru: [{ model: "claude-sonnet-4-5", at: "2026-10-01T00:00:00.000Z" }],
      lastModel: "claude-sonnet-4-5",
      activeKey: "backup",
    },
    "kimi-coding": {
      id: "kimi-coding",
      group: null,
      favorites: [],
      mru: [{ model: "kimi-k2", at: "2026-10-02T00:00:00.000Z" }],
      lastModel: "kimi-k2",
      activeKey: "default",
    },
  },
  settings: { widget: "auto" },
};

await step("parseQuery 支持分组/收藏/最近/能力/上下文/站点", () => {
  const spec = ext.parseQuery("@code @fav recent reasoning image ctx:>=200k provider: crow5 sonnet");
  assert.deepEqual(spec.groups, ["code"]);
  assert.equal(spec.fav, true);
  assert.equal(spec.recent, true);
  assert.equal(spec.reasoning, true);
  assert.equal(spec.image, true);
  assert.equal(spec.minContext, 200000);
  assert.deepEqual(spec.providers, ["crow5"]);
  assert.deepEqual(spec.terms, ["sonnet"]);
  assert.equal(ext.parseQuery("ctx:1m").minContext, 1000000);
  assert.equal(ext.parseQuery("思考 图片").reasoning, true);
  assert.equal(ext.parseQuery("relay crow5").relay, "crow5");
});

await step("selectModels 条件取交集，无命中返回空", () => {
  writeRegistry(REGISTRY);
  const registry = ext.readRegistry();
  const ids = (q) => ext.selectModels(MODELS, q, { registry }).models.map((m) => m.id);
  assert.deepEqual(ids("@code"), ["claude-sonnet-4-5", "gemini-3-pro"]);
  assert.deepEqual(ids("@fav"), ["gemini-3-pro"]);
  assert.deepEqual(ids("recent"), ["claude-sonnet-4-5", "kimi-k2"]);
  assert.deepEqual(ids("ctx:>=300k"), ["gpt-5.5", "gemini-3-pro"]);
  assert.deepEqual(ids("provider: openai image"), ["gpt-5.5"]);
  assert.deepEqual(ids("@code sonnet"), ["claude-sonnet-4-5"]);
  assert.deepEqual(ids("@nope"), []);
});

await step("参数补全：/switch 与 /switch-save 共用，widget 只补 on/off/auto", () => {
  const h = makeHarness();
  const sw = h.commands.get("switch").getArgumentCompletions;
  assert.equal(typeof h.commands.get("switch-save").getArgumentCompletions, "function");
  const all = sw("").map((o) => o.value);
  assert.ok(all.includes("@code"));
  assert.ok(all.includes("@fav"));
  assert.ok(all.includes("crow5"));
  assert.deepEqual(sw("@c").map((o) => o.value), ["@code"]);
  const widget = h.commands.get("switch-widget").getArgumentCompletions;
  assert.deepEqual(widget("").map((o) => o.value), ["on", "off", "auto"]);
  assert.deepEqual(widget("ff").map((o) => o.value), ["off"]);
});

await step("rankModels：收藏 → MRU → 中转站 → 当前 → 其他", () => {
  const registry = ext.readRegistry();
  const ranked = ext.rankModels(MODELS, ["crow5"], "openai", { registry }).map((m) => `${m.provider}/${m.id}`);
  assert.deepEqual(ranked, [
    "crow5/gemini-3-pro",
    "kimi-coding/kimi-k2",
    "crow5/claude-sonnet-4-5",
    "openai/gpt-5.5",
  ]);
});

await step("session_start 刷新状态栏，MRU 中带 key 别名", () => {
  const h = makeHarness();
  assert.ok(h.events.has("session_start"));
  assert.ok(h.events.has("model_select"));
  h.events.get("session_start")({}, h.ctx);
  assert.deepEqual(h.statuses.at(-1), ["pmh", "pmh · openai/gpt-5.5 · 400K · 思考"]);

  const sonnet = MODELS.find((m) => m.id === "claude-sonnet-4-5");
  h.events.get("model_select")({ model: sonnet }, h.ctx);
  assert.match(h.statuses.at(-1)[1], /crow5\/claude-sonnet-4-5/);
  assert.match(h.statuses.at(-1)[1], /key:backup/);
});

await step("model_select 记录 MRU，内置厂商不写进注册表", () => {
  const h = makeHarness();
  h.events.get("model_select")({ model: MODELS[2] }, h.ctx);
  let registry = readRegistryFile();
  assert.equal(registry.relays.crow5.mru[0].model, "gemini-3-pro");
  assert.equal(registry.relays.crow5.lastModel, "gemini-3-pro");
  assert.ok(registry.relays.crow5.mru.length <= 20);

  h.events.get("model_select")({ model: MODELS[0] }, h.ctx);
  registry = readRegistryFile();
  assert.equal(registry.relays.openai, undefined);
});

await step("model_select 的 source=restore 不写 MRU", () => {
  const before = readRegistryFile();
  const h = makeHarness();
  h.events.get("model_select")({ model: MODELS[3], source: "restore" }, h.ctx);
  assert.deepEqual(readRegistryFile().relays, before.relays, "恢复会话不应算最近使用");
  assert.match(h.statuses.at(-1)[1], /kimi-coding\/kimi-k2/);
});

await step("/switch @code sonnet 唯一命中直接切", async () => {
  const h = makeHarness();
  await h.commands.get("switch").handler("@code sonnet", h.ctx);
  assert.equal(h.switches.length, 1);
  assert.equal(h.switches[0].id, "claude-sonnet-4-5");
  assert.ok(!h.notices.some((n) => n.startsWith("select:")), "不应该弹选择器");
});

await step("/switch @code 多命中时弹选择器，收藏排最前", async () => {
  const h = makeHarness({ pickIndex: 0 });
  await h.commands.get("switch").handler("@code", h.ctx);
  const title = h.notices.find((n) => n.startsWith("select:"));
  assert.match(title, /匹配 "@code"（2 个）/);
  assert.equal(h.switches.at(-1).id, "gemini-3-pro", "收藏的 gemini 应排第一");
});

await step("/switch relay <id> 切到该站上次用的模型，失效时回退并提示", async () => {
  const reset = readRegistryFile();
  reset.relays.crow5.lastModel = "claude-sonnet-4-5";
  writeRegistry(reset);
  const h = makeHarness();
  await h.commands.get("switch").handler("relay crow5", h.ctx);
  assert.equal(h.switches.at(-1).id, "claude-sonnet-4-5");
  assert.ok(!h.notices.some((n) => n.startsWith("select:")));

  const registry = readRegistryFile();
  registry.relays.crow5.lastModel = "gone-model";
  writeRegistry(registry);
  const h2 = makeHarness();
  await h2.commands.get("switch").handler("relay crow5", h2.ctx);
  assert.match(h2.notices.find((n) => n.includes("已不可用")), /gone-model/);
  assert.equal(h2.switches.at(-1).provider, "crow5");

  const h3 = makeHarness();
  await h3.commands.get("switch").handler("relay nope", h3.ctx);
  assert.equal(h3.switches.length, 0);
  assert.match(h3.notices.at(-1), /没有名为 "nope"/);
});

await step("/switch-fav 收藏与取消收藏当前模型", async () => {
  const h = makeHarness();
  h.ctx.model = MODELS[2];
  await h.commands.get("switch-fav").handler("", h.ctx);
  assert.match(h.notices.at(-1), /已取消收藏 crow5\/gemini-3-pro/);
  assert.ok(!readRegistryFile().relays.crow5.favorites.includes("gemini-3-pro"));
  await h.commands.get("switch-fav").handler("", h.ctx);
  assert.match(h.notices.at(-1), /已收藏 crow5\/gemini-3-pro/);
  assert.ok(readRegistryFile().relays.crow5.favorites.includes("gemini-3-pro"));
  assert.ok(fs.readdirSync(agentDir).some((f) => f.startsWith("pmh-relays.json.bak-")), "显式操作应留备份");

  h.ctx.model = MODELS[0];
  await h.commands.get("switch-fav").handler("", h.ctx);
  assert.match(h.notices.at(-1), /不是中转站/);
});

await step("/switch-widget on/off/auto 控制站点 widget", async () => {
  const h = makeHarness();
  await h.commands.get("switch-widget").handler("", h.ctx);
  assert.equal(readRegistryFile().settings.widget, "on");
  const lines = h.widgets.at(-1)[1];
  assert.equal(lines.length, 2);
  assert.match(lines[0], /crow5 \[code\] 2 模型 · 上次 gemini-3-pro/);

  await h.commands.get("switch-widget").handler("off", h.ctx);
  assert.equal(readRegistryFile().settings.widget, "off");
  assert.equal(h.widgets.at(-1)[1], undefined);

  await h.commands.get("switch-widget").handler("auto", h.ctx);
  assert.equal(readRegistryFile().settings.widget, "auto");
  assert.equal(h.widgets.at(-1)[1].length, 2);

  await h.commands.get("switch-widget").handler("bogus", h.ctx);
  assert.match(h.notices.at(-1), /用法/);
});

fs.rmSync(agentDir, { recursive: true, force: true });
console.error("\n扩展测试全部通过 ✅");


