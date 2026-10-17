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

fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { crow5: { baseUrl: "https://x/v1" } } }, null, 2));
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
  const switches = [];
  const notices = [];
  const pi = {
    registerCommand: (name, opts) => commands.set(name, opts),
    registerShortcut: (key, opts) => shortcuts.set(key, opts),
    setModel: async () => true,
  };
  ext.default(pi);
  const ctx = {
    model: MODELS[0],
    modelRegistry: { getAvailable: () => MODELS },
    setModel: async (model) => {
      switches.push(model);
      return true;
    },
    ui: {
      notify: (msg) => notices.push(msg),
      select: async (title, options = []) => {
        notices.push(`select:${title}`);
        return pickIndex == null ? undefined : options[pickIndex];
      },
    },
  };
  return { commands, shortcuts, switches, notices, ctx };
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

fs.rmSync(agentDir, { recursive: true, force: true });
console.error("\n扩展测试全部通过 ✅");


