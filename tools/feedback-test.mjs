#!/usr/bin/env node
// 反馈模块自测：脱敏、诊断计数、URL 编码与长度、跨平台打开、CLI 输出。
// 全部在临时目录里跑，不联网、不真正打开浏览器。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PMH_NO_PROXY = "1";
process.env.PMH_NONINTERACTIVE = "1";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pmh-feedback-"));
const write = (file, content = "") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const {
  FEEDBACK_URL, buildFeedback, buildIssueUrl, collectDiagnostics, feedbackTitle,
  formatReport, openUrl, pmhVersion, redact,
} = await import("../src/feedback.mjs");
const { configPaths } = await import("../src/paths.mjs");
const { cmdFeedback } = await import("../src/commands.mjs");

const step = (name, fn) => {
  fn();
  console.error(`  ✔ ${name}`);
};
const stepAsync = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

const SECRET = "sk-live-abcdef1234567890";
const HOME = path.join(os.tmpdir(), "home-with-user");

function fixture() {
  const agentDir = temp();
  write(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "relay-secret-name": {
        baseUrl: "https://relay-secret.example/v1",
        models: [{ id: "model-alpha" }, { id: "model-beta" }],
      },
      "relay-two": { baseUrl: "https://two.example", models: [{ id: "model-gamma" }] },
    },
  }));
  write(path.join(agentDir, "auth.json"), JSON.stringify({
    "relay-secret-name": { type: "api_key", key: SECRET },
    "relay-two": { type: "api_key", key: SECRET },
  }));
  write(path.join(agentDir, "pmh-relays.json"), JSON.stringify({
    relays: {
      "relay-secret-name": {
        name: "relay-secret-name",
        group: "secret-group",
        favorites: ["model-alpha", "model-beta"],
        keyAliases: ["default", "backup"],
      },
      "relay-two": { name: "relay-two", favorites: ["model-gamma"] },
    },
    groups: { "secret-group": { title: "Secret Group" } },
  }));
  write(path.join(agentDir, "extension-settings", "pmh-auto.json"), JSON.stringify({
    enabled: true,
    pinned: "strong",
    tiers: { cheap: { provider: "relay-secret-name", model: "model-alpha" } },
  }));
  return { agentDir, paths: configPaths(agentDir), flags: {} };
}

step("pmhVersion 读取 package.json", () => {
  assert.match(pmhVersion(), /^\d+\.\d+\.\d+/);
});

step("redact：密钥、Bearer、主目录都被替换", () => {
  const home = path.join("C:", "Users", "alice");
  const input = `key=${SECRET} Authorization: Bearer abc.def.ghi path=${path.join(home, ".pi", "agent")}`;
  const out = redact(input, { home });
  assert.equal(out.includes(SECRET), false);
  assert.equal(out.includes("abc.def.ghi"), false);
  assert.equal(out.includes("C:\\Users\\alice"), false);
  assert.match(out, /sk-\*\*\*/);
  assert.match(out, /Bearer \*\*\*/);
  assert.match(out, /~[\\/]\.pi[\\/]agent/);
  // 8.3 短路径与另一套 home 写法（非当前用户主目录）也要遮住用户名
  assert.equal(redact("C:\\Users\\CASPIA~1\\AppData", { home: "D:\\other" }), "~\\AppData");
  assert.equal(redact("/home/bob/.pi", { home: "/root" }), "~/.pi");
});

step("redact：api_key=... 与超长输入截断", () => {
  const out = redact("api_key=super-secret-value", { home: "" });
  assert.equal(out.includes("super-secret-value"), false);
  const long = redact("x".repeat(5000), { home: "", max: 100 });
  assert.equal(long.length, 100 + "…（已截断）".length);
  assert.match(long, /已截断/);
});

step("collectDiagnostics：只给计数，不含站点/模型/密文", () => {
  const ctx = fixture();
  const d = collectDiagnostics(ctx, { home: HOME, platform: "win32", arch: "x64", nodeVersion: "v24.0.0", osRelease: "10.0" });
  assert.equal(d.counts.providers, 2);
  assert.equal(d.counts.models, 3);
  assert.equal(d.counts.relays, 2);
  assert.equal(d.counts.groups, 1);
  assert.equal(d.counts.favorites, 3);
  assert.equal(d.counts.keyAliases, 1);
  assert.equal(d.installMode, "none");
  assert.equal(d.auto.enabled, true);
  assert.equal(d.auto.pinned, "strong");
  assert.equal(d.auto.configured, 1);
  const json = JSON.stringify(d);
  for (const secret of ["relay-secret-name", "model-alpha", "secret-group", SECRET, "relay-secret.example"]) {
    assert.equal(json.includes(secret), false, `诊断泄露了 ${secret}`);
  }
});

step("buildFeedback：报告脱敏、标题来自首行、链接可解码", () => {
  const ctx = fixture();
  const message = `切换模型失败 ${SECRET}\n报错在 ${path.join(HOME, ".pi", "agent")}`;
  const data = buildFeedback(ctx, message, { home: HOME });
  assert.equal(data.message.includes(SECRET), false);
  assert.equal(data.message.includes(HOME), false);
  assert.match(data.title, /^\[反馈\] 切换模型失败/);
  assert.ok(data.issueUrl.startsWith(`${FEEDBACK_URL}?`));
  const url = new URL(data.issueUrl);
  assert.equal(url.searchParams.get("title"), data.title);
  assert.equal(url.searchParams.get("body"), data.report);
  assert.equal(url.searchParams.get("body").includes(SECRET), false);
});

step("buildFeedback：空描述有占位标题，报告提示补充", () => {
  const ctx = fixture();
  const data = buildFeedback(ctx, "   ", { home: HOME });
  assert.match(data.title, /^\[反馈\] pmh \d+\.\d+\.\d+ 使用问题$/);
  assert.match(data.report, /请补充/);
});

step("buildIssueUrl：超长正文截断到 URL 上限内", () => {
  const body = `### 问题描述\n\n${"中文描述".repeat(800)}`;
  const url = buildIssueUrl("[反馈] 很长的问题", body, { limit: 7000 });
  assert.ok(url.length <= 7000);
  const decoded = new URL(url).searchParams.get("body");
  assert.match(decoded, /报告过长已截断/);
  assert.ok(decoded.length < body.length);
});

step("formatReport：包含版本、安装方式与脱敏声明", () => {
  const ctx = fixture();
  const data = buildFeedback(ctx, "测试", { home: HOME });
  for (const text of ["pmh:", "Node:", "pi:", "扩展安装:", "已脱敏"]) {
    assert.ok(data.report.includes(text), `报告缺少 ${text}`);
  }
});

step("openUrl：按平台选择命令，URL 原样传入", () => {
  const calls = [];
  const fakeSpawn = (command, args, opts) => {
    calls.push({ command, args, opts });
    return { unref() {} };
  };
  assert.equal(openUrl("https://example.com/a?b=1&c=2", { spawnFn: fakeSpawn, platform: "win32" }), true);
  assert.equal(calls[0].command, "rundll32");
  assert.deepEqual(calls[0].args, ["url.dll,FileProtocolHandler", "https://example.com/a?b=1&c=2"]);

  assert.equal(openUrl("https://example.com", { spawnFn: fakeSpawn, platform: "darwin" }), true);
  assert.equal(calls[1].command, "open");
  assert.deepEqual(calls[1].args, ["https://example.com"]);

  assert.equal(openUrl("https://example.com", { spawnFn: fakeSpawn, platform: "linux" }), true);
  assert.equal(calls[2].command, "xdg-open");

  const boom = () => { throw new Error("no browser"); };
  assert.equal(openUrl("https://example.com", { spawnFn: boom, platform: "linux" }), false);
});

const capture = async (fn) => {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines.join("\n");
};

await stepAsync("CLI --json：输出结构化数据且不含密钥", async () => {
  const ctx = fixture();
  const out = await capture(() => cmdFeedback(ctx, `坏了 ${SECRET}`, { json: true }));
  const data = JSON.parse(out);
  assert.ok(data.report.includes("已脱敏"));
  assert.ok(data.issueUrl.startsWith(FEEDBACK_URL));
  assert.equal(out.includes(SECRET), false);
});

await stepAsync("CLI --print：打印报告与链接，不尝试打开浏览器", async () => {
  const ctx = fixture();
  const out = await capture(() => cmdFeedback(ctx, "打印模式", { print: true }));
  assert.match(out, /反馈报告/);
  assert.match(out, /https:\/\/github\.com\/enmingxiong821-cloud\/pi-model\/issues\/new\?/);
});

await stepAsync("CLI 默认（非交互）：打印链接而不打开浏览器", async () => {
  const ctx = fixture();
  const out = await capture(() => cmdFeedback(ctx, "默认模式", {}));
  assert.match(out, /issues\/new\?/);
  assert.match(out, /在浏览器打开上面的链接/);
});

console.error("feedback: all checks passed");
