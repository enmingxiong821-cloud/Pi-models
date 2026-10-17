#!/usr/bin/env node
// 端到端自测：用一个假的 OpenAI 兼容中转站跑通 pmh 的完整流程。
//   node tools/smoke-test.mjs          进程内打桩，不依赖网络（沙箱/CI 友好）
//   node tools/smoke-test.mjs --real   起真实 HTTP 服务并 spawn CLI，验证真实 socket 路径
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bin = path.join(root, "bin", "pmh.mjs");
// 用固定的小目录当"官方模型目录"，这样断言不受本机是否装了 pi 影响（CI 也能跑）。
const FIXTURE_CATALOG = path.join(here, "fixtures", "catalog");
const KEY = "sk-test-123";
const MODELS = ["claude-sonnet-4-5", "gpt-5.5", "vendor/totally-unknown-model-9"];
const REAL = process.argv.includes("--real");

process.env.PMH_NO_PROXY = "1";
process.env.PMH_NONINTERACTIVE = "1"; // 禁掉交互式提问，避免在真终端里跑自测被卡住

const { suggestName } = await import("../src/relay.mjs");
const { parseEndpoint, maskKey } = await import("../src/clipboard.mjs");

/** 假中转站：只实现 /v1/models 与 /v1/chat/completions，并校验 Bearer。 */
function fakeHandler(url, init = {}) {
  const auth = init.headers?.authorization ?? init.headers?.Authorization ?? "";
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (!/\/v1\/models$/.test(url)) {
    if (/\/v1\/chat\/completions$/.test(url)) {
      if (auth !== `Bearer ${KEY}`) return json(401, { error: { message: "invalid api key" } });
      return json(200, { choices: [{ message: { role: "assistant", content: "pong" } }] });
    }
    return json(404, { error: { message: "not found" } });
  }
  if (auth !== `Bearer ${KEY}`) return json(401, { error: { message: "invalid api key" } });
  return json(200, { data: MODELS.map((id) => ({ id })) });
}

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-smoke-"));
const read = (f) => JSON.parse(fs.readFileSync(path.join(agentDir, f), "utf8"));
const step = async (name, fn) => {
  await fn();
  console.error(`  \u2714 ${name}`);
};

let run;
let base;
let cleanup = () => {};

if (REAL) {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (auth !== `Bearer ${KEY}`) return json(401, { error: { message: "invalid api key" } });
    if (req.url.startsWith("/v1/models")) return json(200, { data: MODELS.map((id) => ({ id })) });
    if (req.url.startsWith("/v1/chat/completions")) return json(200, { choices: [{ message: { content: "pong" } }] });
    return json(404, { error: { message: "not found" } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  cleanup = () => server.close();
  run = (args) => {
    const r = spawnSync(process.execPath, [bin, ...args, "--agent-dir", agentDir, "--catalog", FIXTURE_CATALOG], { encoding: "utf8", env: { ...process.env, PMH_NO_PROXY: "1" } });
    assert.equal(r.status, 0, `pmh ${args.join(" ")} 失败:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
} else {
  base = "https://mock.relay.local";
  let fetchCalls = 0;
  globalThis.fetch = async (url, init) => {
    fetchCalls += 1;
    return fakeHandler(String(url), init);
  };
  const { cmdAdd, cmdInstallExtension, cmdQuick, cmdKey, cmdLs, cmdRm, cmdScope, cmdSync, cmdTest, cmdUse, makeContext } = await import("../src/commands.mjs");
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
  const ctx = () => makeContext({ agentDir, catalog: FIXTURE_CATALOG });
  run = {
    add: (name, flags) => capture(() => cmdAdd(ctx(), name, flags)),
    sync: (name, flags = {}) => capture(() => cmdSync(ctx(), name, flags)),
    test: (name, flags = {}) => capture(() => cmdTest(ctx(), name, flags)),
    ls: () => capture(() => cmdLs(ctx(), {})),
    use: (target, flags = {}) => capture(() => cmdUse(ctx(), target, flags)),
    scope: (patterns, flags = {}) => capture(() => cmdScope(ctx(), patterns, flags)),
    key: (name, k) => capture(() => cmdKey(ctx(), name, k)),
    rm: (name, flags = {}) => capture(() => cmdRm(ctx(), name, flags)),
    installExtension: () => capture(() => cmdInstallExtension(ctx(), {})),
    quick: (url, key, flags = {}) => capture(() => cmdQuick(ctx(), url, key, flags)),
    addNoArgs: async () => {
      try {
        await capture(() => cmdAdd(ctx(), undefined, {}));
        return "(没有报错)";
      } catch (err) {
        return err.message;
      }
    },
    fetchCalls: () => fetchCalls,
  };
}

const cli = REAL
  ? {
      add: (name, flags) => run(["add", name, ...flagArgs(flags)]),
      sync: (name, flags) => run(["sync", name, ...flagArgs(flags ?? {})]),
      test: (name) => run(["test", name]),
      ls: () => run(["ls"]),
      use: (target, flags) => run(["use", target, ...flagArgs(flags ?? {})]),
      scope: (patterns, flags) => run(["scope", ...patterns, ...flagArgs(flags ?? {})]),
      key: (name, k) => run(["key", name, k]),
      rm: (name, flags) => run(["rm", name, ...flagArgs(flags ?? {})]),
      installExtension: () => run(["install-extension"]),
      quick: (url, key, flags = {}) => run(["quick", url, key, ...flagArgs(flags)]),
      addNoArgs: () => {
        const r = spawnSync(process.execPath, [bin, "add", "--agent-dir", agentDir, "--catalog", FIXTURE_CATALOG], {
          encoding: "utf8",
          env: { ...process.env, PMH_NO_PROXY: "1", PMH_NONINTERACTIVE: "1" },
        });
        return `${r.stdout ?? ""}${r.stderr ?? ""}`;
      },
    }
  : run;

/** 把 {base:"x", key:"y"} 转成 --base x --key y，重复键保留数组。 */
function flagArgs(flags) {
  const out = [];
  for (const [k, v] of Object.entries(flags ?? {})) {
    const name = `--${k.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`;
    for (const item of [].concat(v)) {
      if (item === true) out.push(name);
      else if (item !== false && item !== undefined) out.push(name, String(item));
    }
  }
  return out;
}

try {
  console.error(`假中转站: ${base}  |  agent 目录: ${agentDir}`);

  await cli.add("demo", { base, key: KEY, name: "演示中转站" });

  await step("models.json 写入 provider 与模型清单", () => {
    const models = read("models.json");
    const p = models.providers.demo;
    assert.equal(p.baseUrl, `${base}/v1`);
    assert.equal(p.api, "openai-completions");
    assert.equal(p.models.length, 3);
    assert.deepEqual(p.models.map((m) => m.id), MODELS);
  });

  await step("元数据从 pi 官方目录自动补全", () => {
    const models = read("models.json");
    const sonnet = models.providers.demo.models.find((m) => m.id === "claude-sonnet-4-5");
    assert.equal(sonnet.contextWindow, 200000);
    assert.equal(sonnet.reasoning, true);
    assert.equal(sonnet.cost?.input, 3); // 来自 fixtures/catalog，锁定来源与数值
    assert.equal(sonnet.name, "Claude Sonnet 4.5 (fixture)");
    const unknown = models.providers.demo.models.find((m) => m.id.includes("unknown"));
    assert.equal(unknown.contextWindow, 128000);
    assert.ok(unknown.name.length > 0);
    assert.equal(unknown.cost, undefined, "官方目录里没有的模型不应凭空编价格");
  });

  await step("密钥写入 auth.json 而不是 models.json", () => {
    assert.equal(read("auth.json").demo.key, KEY);
    assert.equal(read("models.json").providers.demo.apiKey, undefined);
  });

  await step("ls / use / scope 正常", async () => {
    assert.match(await run.ls(), /demo/);
    await run.use("demo#claude-sonnet-4-5");
    assert.equal(read("settings.json").defaultProvider, "demo");
    assert.equal(read("settings.json").defaultModel, "claude-sonnet-4-5");
    await run.scope(["demo/*"]);
    assert.deepEqual(read("settings.json").enabledModels, ["demo/*"]);
  });

  await step("关键词模糊切换：pmh use sonnet", async () => {
    await run.use("sonnet");
    const settings = read("settings.json");
    assert.equal(settings.defaultProvider, "demo");
    assert.equal(settings.defaultModel, "claude-sonnet-4-5");
    await run.use("demo#gpt-5"); // provider 内模糊
    assert.equal(read("settings.json").defaultModel, "gpt-5.5");
  });

  await step("install-extension 把扩展放进 pi 的扩展目录", async () => {
    const out = await cli.installExtension();
    assert.match(out, /扩展已安装/);
    assert.ok(fs.existsSync(path.join(agentDir, "extensions", "quick-switch.js")));
  });

  await step("按地址推断 provider 名称", () => {
    assert.equal(suggestName("https://tbyunyi-router.crow5.com"), "crow5");
    assert.equal(suggestName("https://api.openai.com/v1"), "openai");
    assert.equal(suggestName("http://localhost:11434"), "localhost");
    assert.equal(suggestName("https://ai.example.com"), "example");
    assert.equal(suggestName("https://mock.relay.local"), "relay");
    assert.equal(suggestName("https://gw.example.invalid"), "example");
  });

  await step("从剪贴板文本里认出地址与 Key", () => {
    assert.deepEqual(parseEndpoint("https://xxx.crow5.com  sk-abc1234567890"), { url: "https://xxx.crow5.com", key: "sk-abc1234567890" });
    assert.equal(parseEndpoint("Base URL: https://api.foo.com/v1\nAPI Key: sk-xyz9876543210").url, "https://api.foo.com/v1");
    assert.equal(parseEndpoint("https://api.foo.com/v1").key, "");
    assert.equal(parseEndpoint("什么也没有").url, "");
    assert.match(maskKey("sk-abcdefghijklmn"), /^sk-ab…/);
  });

  await step("一键配置：quick 从 URL+Key 到可用 provider 一气呵成", async () => {
    const out = await cli.quick(base, KEY, { as: "quickdemo" });
    assert.match(out, /读取到 3 个模型/);
    const models = read("models.json");
    assert.equal(models.providers.quickdemo.models.length, 3);
    assert.equal(read("auth.json").quickdemo.key, KEY);
  });

  await step("非交互环境缺参数时给出明确指引，且不写坏配置", async () => {
    const before = fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
    const out = await cli.addNoArgs();
    assert.match(out, /缺少 --base/);
    assert.equal(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"), before);
  });

  await step("test 能连通并试聊成功", async () => {
    const out = await cli.test("demo");
    assert.match(out, /GET \/v1\/models 正常：3 个模型/);
    assert.match(out, /试聊成功/);
  });

  await step("sync 幂等且保留手工字段", async () => {
    const models = read("models.json");
    models.providers.demo.models[0].compat = { sendSessionAffinityHeaders: true };
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(models, null, 2));
    await cli.sync("demo");
    assert.deepEqual(read("models.json").providers.demo.models[0].compat, { sendSessionAffinityHeaders: true });
  });

  await step("密钥错误时报错但不清空配置", async () => {
    const bad = await cli.add("baddie", { base, key: "wrong-key" });
    assert.match(bad, /拉取模型列表失败/);
    assert.ok(read("models.json").providers.baddie);
  });

  await step("备份文件生成，可回滚", () => {
    const files = fs.readdirSync(agentDir);
    assert.ok(files.some((f) => /^models\.json\.bak-/.test(f)), files.join(","));
  });

  await step("rm --purge-key 清干净", async () => {
    await run.rm("demo", { purgeKey: true });
    assert.equal(read("models.json").providers.demo, undefined);
    assert.equal(read("auth.json").demo, undefined);
  });

  console.error("\n全部通过 ✅");
} finally {
  cleanup();
  fs.rmSync(agentDir, { recursive: true, force: true });
}
