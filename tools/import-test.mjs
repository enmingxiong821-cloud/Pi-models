#!/usr/bin/env node
// 批量导入解析测试：各类文本格式、去重、地址归一、扫描已有配置、订阅拉取的安全边界。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  collectFromCcswitch, collectFromClaude, collectFromCodex, dedupeItems, fetchText, isUrl, itemsFromEnv,
  normalizeApi, normalizeBaseUrl, parseCcswitchUris, parseCodexToml, parseImportText,
} from "../src/import.mjs";

const step = (name, fn) => {
  fn();
  console.error(`  ✔ ${name}`);
};

const stepAsync = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

step("地址归一：补协议、去端点后缀、去 /v1", () => {
  assert.equal(normalizeBaseUrl("api.crow5.com"), "https://api.crow5.com");
  assert.equal(normalizeBaseUrl("https://api.crow5.com/v1/chat/completions"), "https://api.crow5.com");
  assert.equal(normalizeBaseUrl("https://api.crow5.com/v1/"), "https://api.crow5.com");
  assert.equal(normalizeBaseUrl("'https://x.y/v1/messages'"), "https://x.y");
  assert.equal(normalizeBaseUrl("ftp://x.y"), null);
  assert.equal(normalizeBaseUrl(""), null);
});

step("协议归一：别名与启发式", () => {
  assert.equal(normalizeApi("anthropic"), "anthropic-messages");
  assert.equal(normalizeApi("responses"), "openai-responses");
  assert.equal(normalizeApi("openai"), "openai-completions");
  assert.equal(normalizeApi(null, { baseUrl: "https://api.anthropic.com" }), "anthropic-messages");
  assert.equal(normalizeApi(null, { key: "sk-ant-abc" }), "anthropic-messages");
  assert.equal(normalizeApi(null, { baseUrl: "https://x.y" }), "openai-completions");
});

step("JSON：数组 / relays / 单对象 / 嵌套 map", () => {
  const arr = parseImportText(JSON.stringify([
    { name: "crow5", baseUrl: "https://a.crow5.com/v1", apiKey: "sk-1" },
    { baseUrl: "https://b.example.com", key: "sk-2", api: "anthropic" },
  ]));
  assert.equal(arr.format, "json");
  assert.equal(arr.items.length, 2);
  assert.equal(arr.items[0].name, "crow5");
  assert.equal(arr.items[0].api, "openai-completions");
  assert.equal(arr.items[1].api, "anthropic-messages");

  const wrapped = parseImportText(JSON.stringify({ relays: [{ url: "https://c.example.com/v1", key: "sk-3" }] }));
  assert.equal(wrapped.items.length, 1);
  assert.equal(wrapped.items[0].baseUrl, "https://c.example.com");

  const single = parseImportText(JSON.stringify({ base_url: "https://d.example.com", api_key: "sk-4", name: "d" }));
  assert.equal(single.items.length, 1);

  const map = parseImportText(JSON.stringify({
    crow5: { baseUrl: "https://e.crow5.com/v1", apiKey: "sk-5" },
    kimi: { baseUrl: "https://f.kimi.com/v1", apiKey: "sk-6" },
  }));
  assert.equal(map.items.length, 2);
  assert.equal(map.items[1].name, "kimi");
});

step("JSON：pi models.json 的 providers 结构", () => {
  const text = JSON.stringify({
    providers: {
      crow5: { baseUrl: "https://api.crow5.com/v1", apiKey: "sk-a", api: "openai-completions", models: [{ id: "gpt-5" }] },
    },
  });
  const out = parseImportText(text);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].name, "crow5");
  assert.equal(out.items[0].baseUrl, "https://api.crow5.com");
});

step("JSON 解析失败不回显原文（可能含 Key）", () => {
  const out = parseImportText('{"baseUrl": "https://x.test", "key": "sk-secret-123456",}');
  assert.equal(out.items.length, 0);
  assert.ok(out.errors.length);
  assert.ok(!out.errors.join(" ").includes("sk-secret"), out.errors.join(" "));
});

step("JSONL：每行一个对象", () => {
  const text = [
    JSON.stringify({ name: "a", baseUrl: "https://a.example.com", key: "sk-a" }),
    JSON.stringify({ name: "b", baseUrl: "https://b.example.com", key: "sk-b" }),
  ].join("\n");
  const out = parseImportText(text);
  assert.equal(out.format, "jsonl");
  assert.deepEqual(out.items.map((i) => i.name), ["a", "b"]);
});

step("env 块：Anthropic / OpenAI 两套变量", () => {
  const text = [
    "export ANTHROPIC_BASE_URL=https://api.a.com",
    "ANTHROPIC_AUTH_TOKEN=sk-ant-1",
    "",
    "OPENAI_BASE_URL=https://api.b.com/v1",
    "OPENAI_API_KEY=sk-b",
  ].join("\n");
  const out = parseImportText(text);
  assert.equal(out.format, "env");
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].api, "anthropic-messages");
  assert.equal(out.items[0].key, "sk-ant-1");
  assert.equal(out.items[1].baseUrl, "https://api.b.com");
  assert.equal(out.items[1].api, "openai-completions");
});

step("env：基础变量兜底 + 无地址返回空", () => {
  const items = itemsFromEnv({ API_BASE_URL: "https://x.example.com", API_KEY: "sk-x" });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, "sk-x");
  assert.deepEqual(itemsFromEnv({ FOO: "bar" }), []);
});

step("YAML 块：key: value", () => {
  const out = parseImportText([
    "name: crow5",
    "baseUrl: https://api.crow5.com/v1",
    "apiKey: sk-yaml",
    "api: anthropic",
  ].join("\n"));
  assert.equal(out.format, "yaml");
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].name, "crow5");
  assert.equal(out.items[0].api, "anthropic-messages");
});

step("curl：Bearer / x-api-key / responses 判定", () => {
  const bearer = parseImportText(
    "curl https://api.a.com/v1/chat/completions -H 'Authorization: Bearer sk-a' -d '{}'",
  );
  assert.equal(bearer.format, "curl");
  assert.equal(bearer.items[0].baseUrl, "https://api.a.com");
  assert.equal(bearer.items[0].key, "sk-a");

  const anthropic = parseImportText(
    "curl https://api.b.com/v1/messages -H 'x-api-key: sk-ant-b' -d '{\"messages\":[]}'",
  );
  assert.equal(anthropic.items[0].api, "anthropic-messages");
  assert.equal(anthropic.items[0].key, "sk-ant-b");

  const responses = parseImportText("curl https://api.c.com/v1/responses -H 'Authorization: Bearer sk-c' -d '{\"input\":\"hi\"}'");
  assert.equal(responses.items[0].api, "openai-responses");
});

step("纯文本：url key / name|url|key / url,key", () => {
  const a = parseImportText("https://api.a.com sk-aaaaaaaa");
  assert.equal(a.items[0].key, "sk-aaaaaaaa");
  assert.equal(a.items[0].name, "a");

  const b = parseImportText("myrelay | https://api.b.com/v1 | sk-bbbbbbbb");
  assert.equal(b.items[0].name, "myrelay");
  assert.equal(b.items[0].baseUrl, "https://api.b.com");

  const c = parseImportText("https://api.c.com,sk-cccccccc");
  assert.equal(c.items[0].key, "sk-cccccccc");

  const d = parseImportText("crow5 https://api.crow5.com sk-dddddddd");
  assert.equal(d.items[0].name, "crow5");
});

step("纯文本：版本号 / markdown 表格不会被误认成站点", () => {
  assert.equal(parseImportText("node 20.10.2 installed").items.length, 0);
  assert.equal(parseImportText("v1.2.3").items.length, 0);
  assert.equal(parseImportText("| 模型 | 上下文 | 价格 |").items.length, 0);
  assert.equal(parseImportText("foo | bar | baz").items.length, 0);
  assert.equal(parseImportText("https://api.a.com sk-aaaaaaaa").items.length, 1);
});

step("pmh:// 链接", () => {
  const out = parseImportText("pmh://import?name=my&base=https%3A%2F%2Fapi.my.com%2Fv1&key=sk-z&api=anthropic&group=work&tag=a,b");
  assert.equal(out.format, "pmh-uri");
  assert.equal(out.items[0].name, "my");
  assert.equal(out.items[0].baseUrl, "https://api.my.com");
  assert.equal(out.items[0].api, "anthropic-messages");
  assert.equal(out.items[0].group, "work");
  assert.deepEqual(out.items[0].tags, ["a", "b"]);
});

step("base64 订阅内容", () => {
  const inner = "https://api.a.com sk-base64aa\nhttps://api.b.com sk-base64bb";
  const encoded = Buffer.from(inner, "utf8").toString("base64");
  const out = parseImportText(encoded);
  assert.match(out.format, /^base64\//);
  assert.equal(out.items.length, 2);
});

step("空内容 / 无法识别的内容给出错误", () => {
  assert.deepEqual(parseImportText("   ").items, []);
  assert.ok(parseImportText("").errors.length);
  const junk = parseImportText("这是一段普通文字，没有地址");
  assert.equal(junk.items.length, 0);
  assert.ok(junk.errors.length);
});

step("去重：同站同 Key 合并、同站不同 Key 标别名、重名加后缀", () => {
  const items = dedupeItems([
    { name: "crow5", baseUrl: "https://api.crow5.com/v1", key: "sk-1", root: undefined, tags: ["a"] },
    { name: "crow5", baseUrl: "https://api.crow5.com/v1/", key: "sk-1", tags: ["b"] },
    { name: "crow5-other", baseUrl: "https://api.crow5.com/v1", key: "sk-2" },
    { name: "crow5", baseUrl: "https://api.kimi.com/v1", key: "sk-3" },
  ]);
  assert.equal(items.length, 3);
  assert.equal(items[0].root, "https://api.crow5.com");
  assert.deepEqual(items[0].tags, ["a", "b"]);
  assert.equal(items[0].duplicate, true);
  assert.equal(items[1].aliasOf, "crow5");
  assert.equal(items[1].note, "同站不同 Key");
  assert.equal(items[2].name, "crow5-2");
  assert.equal(items[2].renamedFrom, "crow5");
});

step("Codex config.toml：api_key 与 env_key", () => {
  const text = [
    'model = "gpt-5"',
    "",
    "[model_providers.crow5]",
    'name = "Crow5"',
    'base_url = "https://api.crow5.com/v1"',
    'env_key = "CROW5_KEY"',
    'wire_api = "responses"',
    "",
    '[model_providers."kimi k2"]',
    'base_url = "https://api.kimi.com/v1"',
    'api_key = "sk-kimi"',
    'wire_api = "chat"',
  ].join("\n");
  const items = parseCodexToml(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, "Crow5");
  assert.equal(items[0].api, "openai-responses");
  assert.equal(items[0].envKey, "CROW5_KEY");
  assert.equal(items[0].key, null);
  assert.equal(items[1].name, "kimi-k2");
  assert.equal(items[1].key, "sk-kimi");
});

step("扫描 Claude Code 配置（临时 home，不碰真实文件）", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-import-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "settings.local.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.local.com", ANTHROPIC_AUTH_TOKEN: "sk-local" } }),
  );
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ env: {} }));
  const out = collectFromClaude({ home });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].key, "sk-local");
  assert.equal(out.items[0].source, "claude");
  assert.ok(out.files[0].endsWith("settings.local.json"));

  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-import-empty-"));
  assert.deepEqual(collectFromClaude({ home: emptyHome }).items, []);

  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "config.toml"),
    '[model_providers.a]\nbase_url = "https://api.codex.com/v1"\napi_key = "sk-cx"\n',
  );
  const codex = collectFromCodex({ home });
  assert.equal(codex.items.length, 1);
  assert.equal(codex.items[0].baseUrl, "https://api.codex.com");

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(emptyHome, { recursive: true, force: true });
});

step("isUrl", () => {
  assert.equal(isUrl("https://x.y"), true);
  assert.equal(isUrl("x.y"), false);
});

step("ccswitch:// 深链：普通参数、apiFormat 映射、model 清单", () => {
  const url = "ccswitch://v1/import?resource=provider&app=pi&name=Crow5&endpoint=https%3A%2F%2Fapi.crow5.com%2Fv1&apiKey=sk-abc123&model=claude-sonnet-4-5%2Cgemini-3-pro&apiFormat=openai_chat";
  const parsed = parseImportText(url);
  assert.equal(parsed.format, "ccswitch");
  assert.equal(parsed.items.length, 1);
  const item = parsed.items[0];
  assert.equal(item.baseUrl, "https://api.crow5.com");
  assert.equal(item.name, "Crow5");
  assert.equal(item.key, "sk-abc123");
  assert.equal(item.api, "openai-completions");
  assert.deepEqual(item.models, ["claude-sonnet-4-5", "gemini-3-pro"]);
  assert.equal(parseCcswitchUris("ccswitch://v1/import?endpoint=api.x.com&apiFormat=anthropic").items[0].api, "anthropic-messages");
  assert.equal(parseCcswitchUris("ccswitch://v1/import?endpoint=api.x.com&apiFormat=openai_responses").items[0].api, "openai-responses");
});

step("ccswitch:// 深链：缺 endpoint / Gemini 原生协议会明确报错", () => {
  const missing = parseImportText("ccswitch://v1/import?resource=provider&name=x&apiKey=sk-abc");
  assert.equal(missing.items.length, 0);
  assert.match(missing.errors.join("\n"), /缺少有效 endpoint/);

  const gemini = parseImportText("ccswitch://v1/import?resource=provider&endpoint=https%3A%2F%2Fapi.x.com&apiKey=sk-abc&apiFormat=gemini_native");
  assert.equal(gemini.items.length, 0);
  assert.match(gemini.errors.join("\n"), /Gemini 原生协议/);
});

step("ccswitch:// 深链：config 参数是 Base64 编码的配置", () => {
  const config = Buffer.from(JSON.stringify({
    ANTHROPIC_BASE_URL: "https://api.cc.com",
    ANTHROPIC_AUTH_TOKEN: "sk-ant-ccc",
  })).toString("base64");
  const parsed = parseImportText(`ccswitch://v1/import?resource=provider&app=claude&config=${encodeURIComponent(config)}`);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].baseUrl, "https://api.cc.com");
  assert.equal(parsed.items[0].api, "anthropic-messages");
});

step("cc-switch config.json：claude / codex / 直填字段都能读", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-ccs-"));
  fs.mkdirSync(path.join(home, ".cc-switch"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cc-switch", "config.json"), JSON.stringify({
    version: 2,
    claude: {
      providers: {
        p1: { name: "Crow5", settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://api.crow5.com", ANTHROPIC_AUTH_TOKEN: "sk-ant-1" } } },
        p2: { name: "Kimi", settingsConfig: { env: { OPENAI_BASE_URL: "https://api.kimi.com/v1", OPENAI_API_KEY: "sk-kimi" } } },
      },
      current: "p1",
    },
    codex: {
      providers: {
        p3: { name: "GPT", settingsConfig: "[model_providers.gpt]\nbase_url = \"https://api.gpt.com/v1\"\napi_key = \"sk-gpt\"" },
      },
    },
  }));
  try {
    const found = collectFromCcswitch({ home });
    assert.equal(found.items.length, 3);
    assert.equal(found.hasDatabase, false);
    const byName = Object.fromEntries(found.items.map((i) => [i.name, i]));
    assert.equal(byName.Crow5.baseUrl, "https://api.crow5.com");
    assert.equal(byName.Crow5.api, "anthropic-messages");
    assert.equal(byName.Kimi.baseUrl, "https://api.kimi.com");
    assert.equal(byName.GPT.baseUrl, "https://api.gpt.com");
    assert.equal(found.files.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

step("cc-switch v4：只有 SQLite 时标记 hasDatabase（由命令层提示）", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-ccs-"));
  fs.mkdirSync(path.join(home, ".cc-switch"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cc-switch", "cc-switch.db"), "SQLite format 3");
  try {
    const found = collectFromCcswitch({ home });
    assert.equal(found.items.length, 0);
    assert.equal(found.hasDatabase, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const startServer = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://localhost:${server.address().port}/ok` });
      res.end();
      return;
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-length": "2048" });
      res.end("x".repeat(2048));
      return;
    }
    if (req.url === "/bad") {
      res.writeHead(500);
      res.end("nope");
      return;
    }
    res.writeHead(200);
    res.end("https://api.a.com sk-aaaaaaaa");
  });
  server.listen(0, "127.0.0.1", () => resolve(server));
});

await stepAsync("fetchText：正常拉取、跨域跳转拒绝、大小限制、非 2xx", async () => {
  const server = await startServer();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const text = await fetchText(`${base}/ok`);
    assert.match(text, /api\.a\.com/);

    await assert.rejects(() => fetchText(`${base}/redirect`), /其他域名/);
    await assert.rejects(() => fetchText(`${base}/big`, { maxBytes: 1024 }), /超过/);
    await assert.rejects(() => fetchText(`${base}/bad`), /HTTP 500/);
  } finally {
    server.close();
  }
});

console.error("\nimport-test: 全部通过");
