#!/usr/bin/env node
// 参数解析单测：重复标量取最后、重复数组保留、--no-x、`--` 透传。
import assert from "node:assert/strict";
import { parseArgs } from "../src/args.mjs";

const step = (name, fn) => {
  fn();
  console.error(`  ✔ ${name}`);
};

step("普通值与位置参数", () => {
  const { flags, positional } = parseArgs(["add", "crow5", "--base", "https://x.test/v1", "--api=openai-responses"]);
  assert.deepEqual(positional, ["add", "crow5"]);
  assert.equal(flags.base, "https://x.test/v1");
  assert.equal(flags.api, "openai-responses");
});

step("重复标量取最后一个，不会把数组传给下游", () => {
  const { flags } = parseArgs(["--api", "a", "--api", "b", "--model", "m1", "--model=m2"]);
  assert.equal(flags.api, "b");
  assert.equal(flags.model, "m2");
});

step("可重复参数保留数组", () => {
  const { flags } = parseArgs(["--api-rule", "^claude=x", "--api-rule", "^gpt=y", "--tag", "a", "--tag", "b"]);
  assert.deepEqual(flags.apiRule, ["^claude=x", "^gpt=y"]);
  assert.deepEqual(flags.tag, ["a", "b"]);
});

step("--no-x 同时给出新旧两种写法", () => {
  const { flags } = parseArgs(["--no-cost", "--no-reasoning-compat"]);
  assert.equal(flags.noCost, true);
  assert.equal(flags.cost, false);
  assert.equal(flags.noReasoningCompat, true);
  assert.equal(flags.reasoningCompat, false);
});

step("`--` 之后的参数原样透传给 pi", () => {
  const { flags, positional, rest } = parseArgs(["run", "sonnet", "--agent-dir", "/tmp/a", "--", "--foo", "bar baz"]);
  assert.deepEqual(positional, ["run", "sonnet"]);
  assert.equal(flags.agentDir, "/tmp/a");
  assert.deepEqual(rest, ["--foo", "bar baz"]);
});

step("短横线只作为无值开关", () => {
  const { flags, positional } = parseArgs(["-h", "-v"]);
  assert.equal(flags.h, true);
  assert.equal(flags.v, true);
  assert.deepEqual(positional, []);
});

console.error("\n参数解析测试全部通过 ✅");
