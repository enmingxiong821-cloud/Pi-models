#!/usr/bin/env node
// v0.2 CLI 端到端：批量导入 → 分组/收藏/MRU → Key 别名 → 元数据差异 → 清理。
// 进程内打桩 fetch，不依赖网络；所有写入都在临时 agent 目录。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CATALOG = path.join(here, "fixtures", "catalog");
const KEY_A = "sk-alpha-123456";
const KEY_B = "sk-beta-123456";
const KEY_C = "sk-gamma-123456";

process.env.PMH_NO_PROXY = "1";
process.env.PMH_NONINTERACTIVE = "1";

const MODELS = [
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 (upstream)",
    context_length: 300000,
    max_tokens: 64000,
    supports_reasoning: true,
    supports_vision: true,
    pricing: { prompt: "0.000003", completion: "0.000015" },
  },
  {
    id: "gpt-5.5",
    context_length: 400000,
    max_tokens: 128000,
    supports_reasoning: true,
    supported_parameters: ["tools", "reasoning_effort"],
  },
];

globalThis.fetch = async (url, init = {}) => {
  const auth = init.headers?.authorization ?? init.headers?.Authorization ?? "";
  const key = String(auth).replace(/^Bearer\s+/i, "");
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (!/\/v1\/models$/.test(String(url))) return json(404, { error: { message: "not found" } });
  if (![KEY_A, KEY_B, KEY_C].includes(key)) return json(401, { error: { message: "invalid api key" } });
  return json(200, { data: MODELS });
};

const {
  cmdAdd, cmdCurrent, cmdFav, cmdGroup, cmdImport, cmdKey, cmdLs, cmdMeta, cmdRecent, cmdRelay, cmdRm, cmdSync, cmdUse,
  makeContext,
} = await import("../src/commands.mjs");
const { completionCandidates, completionScript, detectShell, SHELLS } = await import("../src/completion.mjs");

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-v02-"));
const file = (name) => path.join(agentDir, name);
const read = (name) => JSON.parse(fs.readFileSync(file(name), "utf8"));
const write = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value, null, 2));
const raw = (name) => fs.readFileSync(file(name), "utf8");

const ctx = () => makeContext({ agentDir, catalog: FIXTURE_CATALOG });
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

const run = {
  import: (sources, flags = {}) => capture(() => cmdImport(ctx(), sources, flags)),
  ls: (flags = {}) => capture(() => cmdLs(ctx(), flags)),
  current: (flags = {}) => capture(() => cmdCurrent(ctx(), flags)),
  use: (target, flags = {}) => capture(() => cmdUse(ctx(), target, flags)),
  key: (args, flags = {}) => capture(() => cmdKey(ctx(), args, flags)),
  group: (args, flags = {}) => capture(() => cmdGroup(ctx(), args, flags)),
  relay: (args) => capture(() => cmdRelay(ctx(), args)),
  fav: (args, flags = {}) => capture(() => cmdFav(ctx(), args, flags)),
  recent: (flags = {}) => capture(() => cmdRecent(ctx(), flags)),
  meta: (name, flags = {}) => capture(() => cmdMeta(ctx(), name, flags)),
  rm: (name, flags = {}) => capture(() => cmdRm(ctx(), name, flags)),
  add: (name, flags = {}) => capture(() => cmdAdd(ctx(), name, flags)),
  sync: (name, flags = {}) => capture(() => cmdSync(ctx(), name, flags)),
};

const step = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

try {
  console.error(`v0.2 CLI 测试 | agent 目录: ${agentDir}`);

  let importOut = "";
  await step("import：两份 YAML 块（同站不同 Key）→ provider + Key 别名 + 分组", async () => {
    importOut = await run.import([
      `name: alpha\nbaseUrl: https://relay.test/v1\napiKey: ${KEY_A}\ngroup: work`,
      `name: alpha-backup\nbaseUrl: https://relay.test/v1\napiKey: ${KEY_B}`,
    ], { yes: true });
    assert.match(importOut, /导入完成/);
    const models = read("models.json");
    assert.ok(models.providers.alpha, "应写入 provider alpha");
    assert.deepEqual(models.providers.alpha.models.map((m) => m.id).sort(), ["claude-sonnet-4-5", "gpt-5.5"]);
    const auth = read("auth.json");
    assert.equal(auth.alpha.key, KEY_A);
    assert.equal(auth["alpha@alpha-backup"].key, KEY_B, "同站不同 Key 应存成别名");
    const registry = read("pmh-relays.json");
    assert.equal(registry.relays.alpha.group, "work");
    assert.ok(registry.groups.work);
    assert.deepEqual(registry.relays.alpha.keyAliases.sort(), ["alpha-backup", "default"]);
    assert.equal(registry.relays.alpha.source, "参数");
  });

  await step("import：上游元数据覆盖目录值，并记录来源", () => {
    const models = read("models.json");
    const sonnet = models.providers.alpha.models.find((m) => m.id === "claude-sonnet-4-5");
    assert.equal(sonnet.contextWindow, 300000);
    assert.equal(sonnet.maxTokens, 64000);
    assert.deepEqual(sonnet.input, ["text", "image"]);
    assert.equal(sonnet.cost.input, 3);
    assert.equal(sonnet.cost.output, 15);
    const gpt = models.providers.alpha.models.find((m) => m.id === "gpt-5.5");
    assert.equal(gpt.compat?.supportsReasoningEffort, true);
    assert.equal(gpt.thinkingLevelMap?.max, "high");
    const registry = read("pmh-relays.json");
    assert.equal(registry.relays.alpha.metaSources.contextWindow.upstream, 2);
    assert.ok(registry.relays.alpha.lastSyncedAt);
  });

  await step("ls --group / --json", async () => {
    const grouped = await run.ls({ group: "work" });
    assert.match(grouped, /alpha/);
    const other = await run.ls({ group: "nope" });
    assert.match(other, /还没有站点|0 个/);
    const parsed = JSON.parse(await run.ls({ json: true }));
    assert.equal(parsed.relays.length, 1);
    assert.equal(parsed.relays[0].id, "alpha");
    assert.equal(parsed.relays[0].group, "work");
    assert.equal(parsed.relays[0].modelCount, 2);
  });

  await step("key ls：打码并标出活动别名", async () => {
    const out = await run.key(["ls", "alpha"]);
    assert.match(out, /alpha-backup/);
    assert.match(out, /←活动/);
    assert.ok(!out.includes(KEY_A), "不能把完整 Key 打印出来");
    assert.ok(!out.includes(KEY_B));
  });

  await step("key add / use / rm：切换活动 Key 时旧 Key 自动留档", async () => {
    await run.key(["add", "alpha", "backup", KEY_C]);
    assert.equal(read("auth.json")["alpha@backup"].key, KEY_C);
    assert.equal(read("auth.json").alpha.key, KEY_A, "已有活动 Key 时新增别名不应抢占");

    await run.key(["use", "alpha", "alpha-backup"]);
    let auth = read("auth.json");
    assert.equal(auth.alpha.key, KEY_B);
    assert.equal(auth["alpha@default"].key, KEY_A, "原 Key 应存档为 default");
    assert.equal(read("pmh-relays.json").relays.alpha.activeKey, "alpha-backup");

    await assert.rejects(() => run.key(["rm", "alpha", "alpha-backup"]), /活动/);
    await run.key(["rm", "alpha", "backup"]);
    auth = read("auth.json");
    assert.equal(auth["alpha@backup"], undefined);
    assert.ok(auth["alpha@default"]);

    await run.key(["use", "alpha", "default"]);
    assert.equal(read("auth.json").alpha.key, KEY_A);
    assert.equal(read("pmh-relays.json").relays.alpha.activeKey, "default");
    await assert.rejects(() => run.key(["rm", "alpha", "default"]), /不能删除/);
  });

  await step("group add / relay group / group ls", async () => {
    await run.group(["add", "code"], { title: "写代码" });
    let registry = read("pmh-relays.json");
    assert.equal(registry.groups.code.title, "写代码");
    await run.relay(["group", "alpha", "code"]);
    registry = read("pmh-relays.json");
    assert.equal(registry.relays.alpha.group, "code");
    const out = await run.group(["ls"]);
    assert.match(out, /code/);
    assert.match(out, /写代码/);
    await run.relay(["group", "alpha", "-"]);
    assert.equal(read("pmh-relays.json").relays.alpha.group, null);
    await run.relay(["group", "alpha", "code"]);
    await assert.rejects(() => run.group(["add", "bad name"]), /分组名/);
    await assert.rejects(() => run.relay(["group", "alpha", "missing"]), /不存在/);
  });

  await step("fav / recent：收藏与最近使用", async () => {
    const added = await run.fav(["add", "alpha#sonnet"]);
    assert.match(added, /已收藏/);
    assert.ok(read("pmh-relays.json").relays.alpha.favorites.includes("claude-sonnet-4-5"));
    const listed = await run.fav(["ls"]);
    assert.match(listed, /claude-sonnet-4-5/);
    await run.fav(["rm", "alpha#sonnet"]);
    assert.deepEqual(read("pmh-relays.json").relays.alpha.favorites, []);
    await run.fav(["toggle", "alpha#gpt-5"]);
    assert.deepEqual(read("pmh-relays.json").relays.alpha.favorites, ["gpt-5.5"]);

    await run.use("alpha#gpt-5.5");
    assert.equal(read("settings.json").defaultModel, "gpt-5.5");
    const registry = read("pmh-relays.json");
    assert.equal(registry.relays.alpha.mru[0].model, "gpt-5.5");
    assert.equal(registry.relays.alpha.lastModel, "gpt-5.5");
    const recent = await run.recent({ limit: 5 });
    assert.match(recent, /gpt-5\.5/);
  });

  await step("use <provider>：同时修正 defaultModel，不留下别的站的陈旧值", async () => {
    write("settings.json", { defaultProvider: "alpha", defaultModel: "ghost-model", theme: "keep-me" });
    await run.use("alpha");
    let settings = read("settings.json");
    assert.equal(settings.defaultProvider, "alpha");
    assert.equal(settings.defaultModel, "gpt-5.5", "应换成该站最近使用的模型");
    assert.equal(settings.theme, "keep-me");

    write("settings.json", { defaultProvider: "alpha", defaultModel: "claude-sonnet-4-5" });
    await run.use("alpha");
    settings = read("settings.json");
    assert.equal(settings.defaultModel, "claude-sonnet-4-5", "已属于该站的模型应保留");
  });

  await step("meta --json：上游与配置不一致时给出 drift", async () => {
    const models = read("models.json");
    models.providers.alpha.models.find((m) => m.id === "claude-sonnet-4-5").contextWindow = 199999;
    write("models.json", models);
    const detail = JSON.parse(await run.meta("alpha", { json: true }));
    const sonnet = detail.find((d) => d.model === "claude-sonnet-4-5");
    assert.equal(sonnet.upstream.contextWindow, 300000);
    assert.ok(sonnet.drift.some((d) => d.startsWith("context 199999→300000")), sonnet.drift.join(";"));
    const driftOut = await run.meta("alpha", { drift: true });
    assert.match(driftOut, /context 199999→300000/);
    assert.doesNotMatch(driftOut, /gpt-5\.5/);
  });

  await step("import --dry-run / 非交互未加 --yes：都不写盘", async () => {
    const before = raw("models.json");
    const dry = await run.import([`name: dry\nbaseUrl: https://dry.test/v1\napiKey: ${KEY_C}`], { dryRun: true, yes: true });
    assert.match(dry, /只预览/);
    assert.equal(raw("models.json"), before);
    assert.equal(read("models.json").providers.dry, undefined);

    const noYes = await run.import([`name: noyes\nbaseUrl: https://noyes.test/v1\napiKey: ${KEY_C}`]);
    assert.match(noYes, /--yes/);
    assert.equal(raw("models.json"), before);
  });

  await step("scan：只列候选，不写盘", async () => {
    const before = raw("models.json");
    const out = await run.import([`name: scanned\nbaseUrl: https://scan.test/v1\napiKey: ${KEY_C}`], { scan: true });
    assert.match(out, /只预览/);
    assert.match(out, /scanned/);
    assert.ok(!out.includes(KEY_C), "预览里的 Key 必须打码");
    assert.equal(raw("models.json"), before);
  });

  await step("import：32 字符同名 Key 别名冲突时能推出新名字（不会死循环）", async () => {
    const long = "x".repeat(32);
    const blocks = (providerKey, aliasKey) => [
      `name: aliasroot\nbaseUrl: https://alias.test/v1\napiKey: ${providerKey}`,
      `name: ${long}\nbaseUrl: https://alias.test/v1\napiKey: ${aliasKey}`,
    ];
    await run.import(blocks(KEY_A, KEY_B), { yes: true });
    assert.equal(read("auth.json")[`aliasroot@${long}`].key, KEY_B);

    const out = await run.import(blocks(KEY_C, KEY_A), { yes: true });
    assert.match(out, /导入完成/);
    const auth = read("auth.json");
    assert.equal(auth[`aliasroot@${"x".repeat(30)}-2`].key, KEY_A, "冲突时应截短 base 再拼后缀");
  });

  await step("import：ccswitch:// 深链直接建 provider，并采用链接里的 model", async () => {
    const link = `ccswitch://v1/import?resource=provider&app=pi&name=ccsw&endpoint=${encodeURIComponent("https://api.relay.local/v1/chat/completions")}&apiKey=${KEY_A}&model=claude-sonnet-4-5&apiFormat=openai_chat`;
    const out = await run.import([link], { yes: true });
    assert.match(out, /导入完成/);
    const models = read("models.json");
    assert.equal(models.providers.ccsw.baseUrl, "https://api.relay.local/v1");
    assert.deepEqual(models.providers.ccsw.models.map((m) => m.id), ["claude-sonnet-4-5"], "应只写链接里指定的模型");
    assert.equal(read("auth.json").ccsw.key, KEY_A);
  });

  await step("import 更新已有 provider 时保留手改的 provider 级字段", async () => {
    const models = read("models.json");
    models.providers.aliasroot.name = "Alias 显示名";
    models.providers.aliasroot.headers = { "X-Test": "keep" };
    write("models.json", models);

    await run.import([`name: aliasroot\nbaseUrl: https://alias.test/v1\napiKey: ${KEY_B}`], { yes: true });
    const after = read("models.json").providers.aliasroot;
    assert.equal(after.name, "Alias 显示名", "显示名不应被覆盖");
    assert.deepEqual(after.headers, { "X-Test": "keep" }, "自定义 headers 不应丢失");
    assert.deepEqual(after.models.map((m) => m.id).sort(), ["claude-sonnet-4-5", "gpt-5.5"]);
  });

  await step("use -：在最近两个默认之间来回切，失效历史自动跳过", async () => {
    write("settings.json", { defaultProvider: "alpha", defaultModel: "gpt-5.5", theme: "keep-me" });
    const reset = read("pmh-relays.json");
    reset.history = [];
    write("pmh-relays.json", reset);

    await run.use("alpha#claude-sonnet-4-5");
    assert.equal(read("settings.json").defaultModel, "claude-sonnet-4-5");
    const history = read("pmh-relays.json").history;
    assert.equal(history[0].provider, "alpha");
    assert.equal(history[0].model, "gpt-5.5", "被替换的默认模型应入历史");

    await run.use("-");
    assert.equal(read("settings.json").defaultModel, "gpt-5.5");
    assert.equal(read("settings.json").theme, "keep-me");

    await run.use("-");
    assert.equal(read("settings.json").defaultModel, "claude-sonnet-4-5");

    const stale = read("pmh-relays.json");
    stale.history = [{ provider: "ghost", model: "gone", at: new Date().toISOString() }];
    write("pmh-relays.json", stale);
    await assert.rejects(() => run.use("-"), /没有可回退/);
  });

  await step("current：一行摘要 / --json，且不泄露 Key", async () => {
    const line = await run.current();
    assert.match(line, /alpha\/claude-sonnet-4-5/);
    assert.match(line, /200K/);

    const detail = JSON.parse(await run.current({ json: true }));
    assert.equal(detail.provider, "alpha");
    assert.equal(detail.model, "claude-sonnet-4-5");
    assert.equal(detail.contextWindow, 199999);
    assert.equal(detail.source, "settings");
    assert.ok(!JSON.stringify(detail).includes(KEY_A), "JSON 里不能出现完整 Key");

    write("settings.json", {});
    const fallback = JSON.parse(await run.current({ json: true }));
    assert.equal(fallback.source, "recent", "settings 没有默认值时退回 MRU");

    const registry = read("pmh-relays.json");
    for (const relay of Object.values(registry.relays)) {
      relay.mru = [];
      relay.lastModel = null;
    }
    write("pmh-relays.json", registry);
    assert.equal(JSON.parse(await run.current({ json: true })).provider, null);
    assert.match(await run.current(), /还没有默认模型/);
  });

  await step("use @组 关键词：唯一命中直接切，多命中在非交互环境报错", async () => {
    await run.use("@code sonnet");
    assert.equal(read("settings.json").defaultModel, "claude-sonnet-4-5");
    await assert.rejects(() => run.use("@code 5"), /匹配 2 个/);
  });

  await step("current --format：按模板输出，未知变量原样保留", async () => {
    const out = await run.current({ format: "{{provider}}:{{model}}@{{group}} {{nope}}" });
    assert.equal(out, "alpha:claude-sonnet-4-5@code {{nope}}");
  });

  await step("sync：默认保留手改元数据，--refresh-meta 才刷新", async () => {
    const models = read("models.json");
    models.providers.alpha.models.find((m) => m.id === "claude-sonnet-4-5").contextWindow = 123456;
    write("models.json", models);

    await run.sync("alpha");
    assert.equal(
      read("models.json").providers.alpha.models.find((m) => m.id === "claude-sonnet-4-5").contextWindow,
      123456,
      "默认不应覆盖手动值",
    );

    await run.sync("alpha", { refreshMeta: true });
    assert.equal(
      read("models.json").providers.alpha.models.find((m) => m.id === "claude-sonnet-4-5").contextWindow,
      300000,
      "--refresh-meta 应换成上游值",
    );
  });

  await step("add 更新已有 provider：省略 --base/--api 时沿用原值", async () => {
    const before = read("models.json").providers.alpha;
    await run.add("alpha", { noSync: true, force: true, yes: true, batch: true });
    const after = read("models.json").providers.alpha;
    assert.equal(after.baseUrl, before.baseUrl);
    assert.equal(after.api, before.api);
    assert.deepEqual(after.models.map((m) => m.id).sort(), before.models.map((m) => m.id).sort());
  });

  await step("add --key-ref：models.json 写引用，auth.json 不存明文", async () => {
    process.env.PMH_TEST_KEY = KEY_C;
    await run.add("refrelay", {
      base: "https://ref.test", keyRef: "PMH_TEST_KEY", yes: true, batch: true,
    });
    assert.equal(read("models.json").providers.refrelay.apiKey, "$PMH_TEST_KEY");
    assert.equal(read("auth.json").refrelay, undefined);
    assert.ok(!raw("auth.json").includes(KEY_C), "auth.json 不应出现实际 Key");
  });

  await step("add --prompt-cache：从官方目录透传缓存策略", async () => {
    await run.add("cachetest", {
      base: "https://cache.test", key: KEY_C, yes: true, batch: true, promptCache: true,
    });
    const sonnet = read("models.json").providers.cachetest.models.find((m) => m.id === "claude-sonnet-4-5");
    assert.deepEqual(sonnet.promptCache, { short: 300, long: 3600 });
  });

  await step("import：同名但不同站自动加后缀，不覆盖已有 provider", async () => {
    const before = read("models.json").providers.alpha.baseUrl;
    const out = await run.import([`name: alpha\nbaseUrl: https://other.test/v1\napiKey: ${KEY_C}`], { yes: true });
    assert.match(out, /重名/);
    const models = read("models.json");
    assert.equal(models.providers.alpha.baseUrl, before, "原 provider 不能被覆盖");
    assert.ok(models.providers["alpha-2"], "应创建 alpha-2");
    assert.equal(models.providers["alpha-2"].baseUrl, "https://other.test/v1");
  });

  await step("completion：补全候选与四种 shell 脚本", () => {
    const c = ctx();
    const useCands = completionCandidates(c, { command: "use", word: "" });
    assert.ok(useCands.includes("alpha"));
    assert.ok(useCands.includes("@code"));
    assert.ok(useCands.includes("@fav"));
    assert.ok(useCands.includes("recent"));
    assert.ok(useCands.some((v) => v.startsWith("alpha#")), "应补全 provider#model");
    assert.deepEqual(completionCandidates(c, { command: "", word: "us" }), ["use"]);
    assert.deepEqual(completionCandidates(c, { command: "completion", word: "" }), SHELLS);
    assert.ok(completionCandidates(c, { command: "key", word: "--j" }).includes("--json"));
    for (const shell of SHELLS) assert.match(completionScript(shell), /__complete/);
    assert.throws(() => completionScript("tcsh"), /不支持/);
    assert.equal(detectShell({ SHELL: "/usr/bin/zsh" }, "linux"), "zsh");
    assert.equal(detectShell({}, "win32"), "powershell");
  });

  await step("rm --purge-key：清 provider、注册表与全部 Key 别名", async () => {
    write("settings.json", {
      defaultProvider: "alpha",
      defaultModel: "gpt-5.5",
      enabledModels: ["alpha/gpt-5.5", "openai/gpt-5.5"],
      theme: "keep-me",
    });
    const registry = read("pmh-relays.json");
    registry.history = [
      { provider: "alpha", model: "gpt-5.5", at: new Date().toISOString() },
      { provider: "openai", model: "gpt-5.5", at: new Date().toISOString() },
    ];
    write("pmh-relays.json", registry);

    // 旧备份里同样含 Key，--purge-backups 应只清掉与 alpha 相关的那些
    const alphaBackup = "auth.json.bak-20200101-000000";
    fs.writeFileSync(file(alphaBackup), JSON.stringify({ alpha: { key: KEY_A } }));
    const otherBackup = "auth.json.bak-20200101-000001";
    fs.writeFileSync(file(otherBackup), JSON.stringify({ openai: { key: "sk-other-keep" } }));
    const backupsBefore = fs.readdirSync(agentDir).filter((n) => n.startsWith("auth.json.bak-"));
    const alphaBackups = backupsBefore.filter((n) => raw(n).includes('"alpha"'));

    await run.rm("alpha", { purgeKey: true, purgeBackups: true });
    assert.equal(read("models.json").providers.alpha, undefined);
    const auth = read("auth.json");
    assert.deepEqual(Object.keys(auth).filter((k) => k === "alpha" || k.startsWith("alpha@")), []);
    assert.equal(read("pmh-relays.json").relays.alpha, undefined);
    assert.deepEqual(
      read("pmh-relays.json").history.map((e) => e.provider),
      ["openai"],
      "回退历史里指向已删站的条目也应清掉",
    );
    const settings = read("settings.json");
    assert.equal(settings.defaultProvider, undefined, "默认 provider 应被清掉");
    assert.equal(settings.defaultModel, undefined, "默认模型应被清掉");
    assert.deepEqual(settings.enabledModels, ["openai/gpt-5.5"], "只保留其他站的循环项");
    assert.equal(settings.theme, "keep-me");

    const backupsAfter = fs.readdirSync(agentDir).filter((n) => n.startsWith("auth.json.bak-"));
    assert.equal(fs.existsSync(file(alphaBackup)), false, "含 alpha 的旧备份应被删除");
    assert.equal(backupsAfter.length, backupsBefore.length - alphaBackups.length, "不应生成新的 auth 备份");
    assert.ok(backupsAfter.includes(otherBackup), "无关备份必须保留");
    for (const name of backupsAfter) {
      assert.ok(!raw(name).includes('"alpha"'), `${name} 仍含 alpha 凭据`);
    }
  });

  console.error("\nv0.2 CLI 测试全部通过 ✅");
} finally {
  fs.rmSync(agentDir, { recursive: true, force: true });
}
