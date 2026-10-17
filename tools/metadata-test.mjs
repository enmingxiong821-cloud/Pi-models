#!/usr/bin/env node
// 元数据适配测试：OpenRouter / LiteLLM / NewAPI / Anthropic / 通用形状、单位归一、
// 合理性丢弃、合并优先级、reasoning compat 条件、倍率换算。
import assert from "node:assert/strict";
import {
  extractUpstreamMeta, mergeMeta, ratioCosts, scaleCost, thinkingCompat, toPerMillion,
} from "../src/metadata.mjs";

const step = (name, fn) => {
  fn();
  console.error(`  ✔ ${name}`);
};

const openrouter = {
  id: "anthropic/claude-sonnet-4.5",
  name: "Anthropic: Claude Sonnet 4.5",
  context_length: 1000000,
  architecture: { input_modalities: ["text", "image", "file"] },
  pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
  supported_parameters: ["tools", "reasoning", "reasoning_effort"],
};

const litellm = {
  id: "gpt-4o",
  model_info: {
    max_input_tokens: 128000,
    max_output_tokens: 16384,
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    supports_vision: true,
    supports_reasoning: false,
  },
};

const newapi = {
  id: "deepseek-v3",
  context_length: 128000,
  max_tokens: 8192,
  supports_reasoning: true,
  supports_vision: false,
  supports_reasoning_effort: true,
};

const anthropic = {
  id: "claude-opus-4-1",
  type: "model",
  display_name: "Claude Opus 4.1",
  created_at: "2025-08-05T00:00:00Z",
};

step("OpenRouter：上下文/模态/价格（per-token → per-million）", () => {
  const meta = extractUpstreamMeta(openrouter);
  assert.equal(meta.source, "openrouter");
  assert.equal(meta.contextWindow, 1000000);
  assert.deepEqual(meta.input, ["text", "image"]);
  assert.equal(meta.reasoning, true);
  assert.equal(meta.supportsReasoningEffort, true);
  assert.deepEqual(meta.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
});

step("LiteLLM：model_info 嵌套字段", () => {
  const meta = extractUpstreamMeta(litellm);
  assert.equal(meta.source, "litellm");
  assert.equal(meta.contextWindow, 128000);
  assert.equal(meta.maxTokens, 16384);
  assert.deepEqual(meta.input, ["text", "image"]);
  assert.equal(meta.reasoning, false);
  assert.equal(meta.cost.input, 2.5);
  assert.equal(meta.cost.output, 10);
});

step("NewAPI：supports_* 布尔字段", () => {
  const meta = extractUpstreamMeta(newapi);
  assert.equal(meta.source, "newapi");
  assert.equal(meta.contextWindow, 128000);
  assert.equal(meta.maxTokens, 8192);
  assert.equal(meta.reasoning, true);
  assert.equal(meta.supportsReasoningEffort, true);
  assert.equal(meta.input, null); // supports_vision=false 不推翻默认
});

step("Anthropic：只补显示名，不编造能力", () => {
  const meta = extractUpstreamMeta(anthropic);
  assert.equal(meta.source, "anthropic");
  assert.equal(meta.name, "Claude Opus 4.1");
  assert.equal(meta.contextWindow, null);
  assert.equal(meta.reasoning, null);
});

step("没有可用字段时返回 null", () => {
  assert.equal(extractUpstreamMeta({ id: "x", object: "model" }), null);
  assert.equal(extractUpstreamMeta(null), null);
});

step("合理性：上下文过小/过大、maxTokens 超上限、价格为负都丢弃", () => {
  const bad = extractUpstreamMeta({
    id: "bad",
    context_length: 10,
    max_tokens: 99999999,
    pricing: { prompt: -1, completion: 0.00001 },
  });
  // 所有字段都不合理 → 整个条目视为没有可用元数据
  assert.equal(bad, null);
});

step("maxTokens 不超过 contextWindow", () => {
  const meta = extractUpstreamMeta({ id: "x", context_length: 4096, max_tokens: 8192 });
  assert.equal(meta.maxTokens, 4096);
});

step("toPerMillion 单位换算", () => {
  assert.equal(toPerMillion(0.000003, "per_token"), 3);
  assert.equal(toPerMillion(3, "per_million"), 3);
  assert.equal(toPerMillion("0.00001", "per_token"), 10);
  assert.equal(toPerMillion(-1, "per_token"), null);
  assert.equal(toPerMillion("abc", "per_million"), null);
});

const heuristic = { reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 32000 };
const catalogMeta = {
  name: "Catalog Name",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 64000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

step("合并优先级：上游 > 官方目录 > 启发式", () => {
  const merged = mergeMeta({
    modelId: "m",
    upstream: extractUpstreamMeta({ id: "m", context_length: 1000000, supports_reasoning: false }),
    catalogMeta,
    heuristic,
  });
  assert.equal(merged.meta.contextWindow, 1000000);
  assert.equal(merged.meta.reasoning, false);
  assert.equal(merged.meta.maxTokens, 64000); // 上游没给 → 目录
  assert.deepEqual(merged.meta.input, ["text", "image"]); // 上游没给 → 目录
  assert.equal(merged.sources.contextWindow, "upstream");
  assert.equal(merged.sources.maxTokens, "catalog");
  assert.equal(merged.primarySource, "upstream");
});

step("合并优先级：上游价格压过目录价，off 时不写价", () => {
  const upstream = extractUpstreamMeta({ id: "m", pricing: { prompt: 0.000001, completion: 0.000002 } });
  const merged = mergeMeta({ modelId: "m", upstream, catalogMeta, heuristic });
  assert.equal(merged.meta.cost.input, 1);
  assert.equal(merged.sources.cost, "upstream");
  const off = mergeMeta({ modelId: "m", upstream, catalogMeta, heuristic, costMode: "off" });
  assert.equal(off.meta.cost, undefined);
});

step("scaled 价格按倍率折算", () => {
  const cost = scaleCost({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, "scaled", 0.2);
  assert.equal(cost.input, 0.6);
  assert.equal(cost.output, 3);
  assert.equal(scaleCost(cost, "off"), null);
});

step("reasoning compat：只在有把握时打开", () => {
  assert.deepEqual(
    thinkingCompat("gpt-5", "openai-completions", { reasoning: true, supportsReasoningEffort: false }).compat,
    { supportsReasoningEffort: true },
  );
  assert.equal(thinkingCompat("deepseek-v3", "openai-completions", { reasoning: true }), null);
  assert.ok(thinkingCompat("deepseek-v3", "openai-completions", { reasoning: true, supportsReasoningEffort: true }));
  assert.equal(thinkingCompat("gpt-5", "anthropic-messages", { reasoning: true }), null);
  assert.equal(thinkingCompat("gpt-5", "openai-completions", { reasoning: false }), null);
});

step("倍率换算：input/output 与 group ratio", () => {
  const cost = ratioCosts("gpt-4o", {
    data: {
      model_ratio: { "gpt-4o": 1.25 },
      completion_ratio: { "gpt-4o": 4 },
      group_ratio: { default: 1 },
    },
  });
  assert.equal(cost.input, 2.5);
  assert.equal(cost.output, 10);
  assert.equal(cost.estimated, true);
});

step("倍率换算：缺字段或负值不猜", () => {
  assert.equal(ratioCosts("x", { data: { model_ratio: {}, completion_ratio: {} } }), null);
  assert.equal(ratioCosts("x", { data: { model_ratio: { x: -1 } } }), null);
  assert.equal(ratioCosts("x", null), null);
});

step("倍率换算：completion_ratio 是数字时也认", () => {
  const cost = ratioCosts("gpt-4o", { data: { model_ratio: { "gpt-4o": 1 }, completion_ratio: 3, group_ratio: 1 } });
  assert.equal(cost.input, 2);
  assert.equal(cost.output, 6);
});

step("负数或 0 的缩放倍率不会算出负价格", () => {
  const cost = scaleCost({ input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }, "scaled", -0.5);
  assert.deepEqual([cost.input, cost.output], [2, 4]);
  const zero = scaleCost({ input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }, "scaled", 0);
  assert.deepEqual([zero.input, zero.output], [2, 4]);
});

step("倍率换算：模型名带 vendor 前缀也能匹配", () => {
  const cost = ratioCosts("openai/gpt-4o", { data: { model_ratio: { "gpt-4o": 1 }, completion_ratio: { "gpt-4o": 2 } } });
  assert.equal(cost.input, 2);
  assert.equal(cost.output, 4);
});

console.error("\nmetadata-test: 全部通过");
