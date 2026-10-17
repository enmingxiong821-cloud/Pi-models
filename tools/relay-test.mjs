#!/usr/bin/env node
// 中转站请求层：响应体流式读取与大小上限。
import assert from "node:assert/strict";
import { baseUrlFor, readTextCapped } from "../src/relay.mjs";
import { rootOf } from "../src/util.mjs";

const step = (name, fn) => {
  fn();
  console.error(`  ✔ ${name}`);
};

const stepAsync = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

await stepAsync("正常读取字符串响应", async () => {
  const res = new Response("{\"data\":[]}");
  assert.equal(await readTextCapped(res, 1024), "{\"data\":[]}");
});

await stepAsync("UTF-8 多字节内容不会被截断成乱码", async () => {
  const body = JSON.stringify({ name: "中转站" });
  assert.equal(await readTextCapped(new Response(body), 1024), body);
});

await stepAsync("超过上限时中止，而不是先全量读进来", async () => {
  const res = new Response("x".repeat(4096));
  await assert.rejects(() => readTextCapped(res, 1024), /超过 1024 字节/);
});

await stepAsync("没有 body 的响应走 text() 兜底", async () => {
  const fake = { body: null, text: async () => "ok" };
  assert.equal(await readTextCapped(fake, 1024), "ok");
  const tooBig = { body: null, text: async () => "y".repeat(2048) };
  await assert.rejects(() => readTextCapped(tooBig, 1024), /超过 1024 字节/);
});

step("rootOf 去掉完整端点，避免拼出 /v1/chat/completions/v1", () => {
  assert.equal(rootOf("https://x.test/v1/chat/completions"), "https://x.test");
  assert.equal(rootOf("https://x.test/v1/responses"), "https://x.test");
  assert.equal(rootOf("https://x.test/v1/messages/"), "https://x.test");
  assert.equal(rootOf("https://x.test/api/models"), "https://x.test/api");
  assert.equal(rootOf("https://x.test/v1"), "https://x.test");
  assert.equal(rootOf("https://x.test/"), "https://x.test");
});

step("baseUrlFor 对完整端点输入仍产出正确的 /v1 根地址", () => {
  assert.equal(baseUrlFor("https://x.test/v1/chat/completions", "openai-completions"), "https://x.test/v1");
  assert.equal(baseUrlFor("https://x.test/v1/messages", "anthropic-messages"), "https://x.test");
  assert.equal(baseUrlFor("https://x.test", "openai-responses"), "https://x.test/v1");
});

console.error("\nrelay-test: 全部通过");
