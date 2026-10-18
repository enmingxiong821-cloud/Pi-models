#!/usr/bin/env node
// 价格快照与匹配测试：只读本地快照，不联网。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeCost, loadPricing, lookupPrice, normalizeModelId, resetPricingCache,
} from "../src/pricing/loader.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshotFile = path.join(here, "..", "src", "pricing", "snapshot.json");

const step = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

await step("快照存在、体积受控、模型数量足够", async () => {
  const stat = fs.statSync(snapshotFile);
  assert.ok(stat.size > 0, "快照为空");
  assert.ok(stat.size < 2 * 1024 * 1024, `快照过大：${stat.size} 字节`);
  const pricing = loadPricing();
  assert.ok(pricing.exact.size >= 5000, `模型过少：${pricing.exact.size}`);
  assert.equal(pricing.version, 1);
});

await step("精确匹配 openai/gpt-4o", async () => {
  const price = lookupPrice("openai", "gpt-4o");
  assert.ok(price);
  assert.equal(price.source, "snapshot");
  assert.deepEqual(
    [price.input, price.output, price.cacheRead, price.cacheWrite],
    [2.5, 10, 1.25, 0],
  );
});

await step("日期后缀与 latest 归一化", async () => {
  assert.equal(normalizeModelId("gpt-4o-2099-01-01"), "gpt-4o");
  assert.equal(normalizeModelId("claude-sonnet-4-5-latest"), "claude-sonnet-4-5");
  assert.equal(normalizeModelId("deepseek/deepseek-chat"), "deepseek-chat");
  const price = lookupPrice("openai", "gpt-4o-2099-01-01");
  assert.ok(price, "日期后缀应回退到基础模型");
  assert.equal(price.input, 2.5);
});

await step("站点别名与模型自带前缀", async () => {
  const viaAlias = lookupPrice("claude", "claude-sonnet-4-5-20250929");
  assert.ok(viaAlias, "claude 应映射到 anthropic");
  assert.equal(viaAlias.output, 15);
  assert.equal(viaAlias.cacheWrite, 3.75);

  const viaPrefixed = lookupPrice("myrelay", "openai/gpt-4o");
  assert.ok(viaPrefixed, "模型自带 provider 前缀时应命中");
  assert.equal(viaPrefixed.input, 2.5);
});

await step("未知模型返回 null，不影响已有匹配", async () => {
  assert.equal(lookupPrice("nope", "zzz-unknown-model-xyz"), null);
  assert.equal(lookupPrice("", ""), null);
  resetPricingCache();
  assert.ok(lookupPrice("google", "gemini-2.5-flash"));
});

await step("按四类 token 计算费用（USD / 百万）", async () => {
  const price = { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 4 };
  const cost = computeCost({ input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 250_000 }, price);
  assert.equal(cost, 2 + 5 + 1 + 1);
  assert.equal(computeCost({ input: 0, output: 0 }, price), 0);
  assert.equal(computeCost({ input: 1 }, null), null);
});
