#!/usr/bin/env node
// 用量聚合测试：临时目录构造 pi 会话 JSONL，不触碰真实 agent 目录。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectUsage, localDateKey, resetUsageCache, resolveRange } from "../src/usage-service.mjs";
import { configPaths } from "../src/paths.mjs";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-usage-"));
const paths = configPaths(agentDir);
fs.mkdirSync(paths.sessions, { recursive: true });

fs.writeFileSync(paths.models, JSON.stringify({
  providers: {
    demo: {
      models: [{ id: "alpha", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }],
    },
    relay: { models: [{ id: "zzz-unknown-model-xyz" }] },
  },
}));

const lines = [
  { type: "session", id: "s1", version: 3, timestamp: "2026-10-18T01:00:00Z", cwd: "C:\\work\\projA" },
  { type: "message", id: "m1", parentId: null, timestamp: "2026-10-18T01:00:10Z", message: { role: "user", content: "hi" } },
  {
    type: "message", id: "m2", parentId: "m1", timestamp: "2026-10-18T01:01:00Z",
    message: {
      role: "assistant", provider: "demo", model: "alpha",
      usage: {
        input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, reasoning: 50,
        totalTokens: 1800, cost: { input: 0.0025, output: 0.005, cacheRead: 0.00025, cacheWrite: 0.00375, total: 0.0123 },
      },
    },
  },
  {
    type: "message", id: "m2", parentId: "m1", timestamp: "2026-10-18T01:01:00Z",
    message: {
      role: "assistant", provider: "demo", model: "alpha",
      usage: { input: 1000, output: 500, totalTokens: 1800, cost: { total: 0.0123 } },
    },
  },
  {
    type: "message", id: "m3", parentId: "m2", timestamp: "2026-10-18T01:02:00Z",
    message: {
      role: "assistant", provider: "demo", model: "alpha",
      usage: { input: 100, output: 50, totalTokens: 150 },
    },
  },
  {
    type: "message", id: "m3b", parentId: "m2", timestamp: "2026-10-18T01:02:30Z",
    message: {
      role: "assistant", provider: "demo", model: "alpha",
      usage: { input: 300, output: 100, totalTokens: 400 },
    },
  },
  {
    type: "message", id: "m4", parentId: "m3b", timestamp: "2026-10-18T01:03:00Z",
    message: {
      role: "assistant", provider: "relay", model: "zzz-unknown-model-xyz",
      usage: { input: 10, output: 10, totalTokens: 20 },
    },
  },
  {
    type: "usage", id: "u1", parentId: "m4", timestamp: "2026-10-18T01:04:00Z",
    provider: "demo", model: "alpha",
    usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0.001 } },
  },
];
fs.writeFileSync(path.join(paths.sessions, "a.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{not json\n`);

const other = [
  { type: "session", id: "s2", version: 3, timestamp: "2020-01-01T00:00:00Z", cwd: "C:\\work\\projB" },
  {
    type: "message", id: "b1", parentId: null, timestamp: "2020-01-01T00:01:00Z",
    message: {
      role: "assistant", provider: "demo", model: "alpha",
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.000002 } },
    },
  },
];
fs.writeFileSync(path.join(paths.sessions, "b.jsonl"), `${other.map((line) => JSON.stringify(line)).join("\n")}\n`);

const ctx = { agentDir, paths, flags: {} };
const now = new Date("2026-10-18T12:00:00Z");
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}：${actual} ≠ ${expected}`);
const step = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

resetUsageCache();

await step("默认聚合：去重、reported 优先、models.json 回退、缺价单独统计", async () => {
  const report = await collectUsage(ctx, { since: "all", now });
  const t = report.totals;
  assert.equal(t.input, 1416);
  assert.equal(t.output, 666);
  assert.equal(t.cacheRead, 200);
  assert.equal(t.cacheWrite, 100);
  assert.equal(t.reasoning, 50);
  assert.equal(t.totalTokens, 2382);
  near(t.cost, 0.014002, "总费用");
  assert.equal(t.unknownCostTokens, 20);
  assert.equal(report.scan.files, 2);
  assert.equal(report.scan.sessions, 2);
  assert.equal(report.scan.errors, 1);
  assert.equal(report.scan.branch, "all");
  assert.equal(report.groups.reduce((sum, group) => sum + group.records, 0), 6);
  assert.deepEqual(report.missingPrice.map((row) => row.key), ["relay#zzz-unknown-model-xyz"]);
  assert.equal(report.missingPrice[0].tokens, 20);
  assert.equal(report.missingPrice[0].records, 1);
});

await step("按 provider 分组", async () => {
  const report = await collectUsage(ctx, { since: "all", groupBy: "provider", now });
  const demo = report.groups.find((group) => group.key === "demo");
  const relay = report.groups.find((group) => group.key === "relay");
  assert.equal(demo.tokens, 2362);
  assert.equal(demo.records, 5);
  near(demo.cost, 0.014002, "demo 费用");
  assert.equal(relay.tokens, 20);
  assert.equal(relay.cost, 0);
});

await step("按日分组使用本地时区", async () => {
  const report = await collectUsage(ctx, { since: "all", groupBy: "day", now });
  const expected = localDateKey(new Date("2026-10-18T01:01:00Z"));
  const old = localDateKey(new Date("2020-01-01T00:01:00Z"));
  assert.ok(report.groups.some((group) => group.key === expected));
  assert.ok(report.groups.some((group) => group.key === old));
  assert.equal(report.groups.length, 2);
});

await step("branch=active 只统计活动分支", async () => {
  const report = await collectUsage(ctx, { since: "all", branch: "active", now });
  assert.equal(report.totals.input, 1316);
  assert.equal(report.totals.output, 616);
  assert.equal(report.totals.totalTokens, 2232);
  near(report.totals.cost, 0.013802, "活动分支费用");
  assert.equal(report.groups.reduce((sum, group) => sum + group.records, 0), 5);
  assert.equal(report.scan.branch, "active");
});

await step("项目过滤支持 basename 与绝对路径", async () => {
  const byName = await collectUsage(ctx, { since: "all", project: "PROJA", now });
  assert.equal(byName.totals.totalTokens, 2380);
  assert.equal(byName.totals.input, 1415);
  const byPath = await collectUsage(ctx, { since: "all", project: "C:\\work\\projA", now });
  assert.equal(byPath.totals.totalTokens, 2380);
  const none = await collectUsage(ctx, { since: "all", project: "proj-missing", now });
  assert.equal(none.totals.totalTokens, 0);
});

await step("日期范围过滤", async () => {
  const recent = await collectUsage(ctx, { since: "2026-10-01", now });
  assert.equal(recent.totals.totalTokens, 2380);
  const future = await collectUsage(ctx, { since: "2027-01-01", now });
  assert.equal(future.totals.totalTokens, 0);
  const report = await collectUsage(ctx, { since: "7d", now });
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  assert.equal(report.range.from, localDateKey(start));
});

await step("文件上限触发截断标记", async () => {
  resetUsageCache();
  const report = await collectUsage(ctx, { since: "all", now, limits: { maxFiles: 1 } });
  assert.equal(report.scan.truncated, true);
  assert.equal(report.scan.files, 1);
});

await step("resolveRange 校验非法输入", async () => {
  assert.equal(resolveRange("all", now).from, null);
  assert.throws(() => resolveRange("0d", now), /1–365/);
  assert.throws(() => resolveRange("400d", now), /1–365/);
  assert.throws(() => resolveRange("2026-02-30", now), /日期无效/);
  assert.throws(() => resolveRange("yesterday", now), /时间范围无效/);
});

await step("空目录返回零值而不是报错", async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-usage-empty-"));
  const empty = await collectUsage({ agentDir: emptyDir, paths: configPaths(emptyDir), flags: {} }, { now });
  assert.equal(empty.totals.totalTokens, 0);
  assert.equal(empty.groups.length, 0);
  assert.equal(empty.scan.files, 0);
});
