#!/usr/bin/env node
// 真实集成测试：让 pi 本体以 RPC 模式加载 extensions/quick-switch.js，
// 然后通过 JSONL 命令验证 /switch 确实注册成功、并且真的切换了模型。
//   node tools/rpc-test.mjs             隔离配置目录 + 显式 --extension
//   node tools/rpc-test.mjs --discover  用真实 ~/.pi/agent，验证自动发现已安装的扩展
// 没装 pi 的环境（CI）会自动跳过并返回 0。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const extension = path.join(repo, "extensions", "quick-switch.js");

const piRoot = path.join(os.homedir(), ".pi", "agent");
const installRoot = path.join(piRoot, "install");
let cli = null;
try {
  const version = fs.readFileSync(path.join(installRoot, "current-version"), "utf8").trim();
  const candidate = path.join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  if (fs.existsSync(candidate)) cli = candidate;
} catch {
  cli = null;
}
if (!cli) {
  console.error("跳过：本机没有找到 pi 安装（CI 环境正常跳过），未做 RPC 集成测试。");
  process.exit(0);
}

// 造一个带中转站的隔离配置目录：provider "relay" + 两个模型 + 一把假 key
const DISCOVER = process.argv.includes("--discover");
const agentDir = DISCOVER ? piRoot : fs.mkdtempSync(path.join(os.tmpdir(), "pmh-rpc-"));
const model = (id, name, extra = {}) => ({
  id,
  name,
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 64000,
  ...extra,
});
if (!DISCOVER) {
  fs.writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        relay: { baseUrl: "https://relay.invalid/v1", api: "openai-completions", models: [model("claude-sonnet-4-5", "Sonnet 4.5"), model("gemini-3-pro", "Gemini 3 Pro")] },
      },
    },
    null,
    2,
  ),
  );
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ relay: { type: "api_key", key: "sk-fake" } }, null, 2));
}

const args = ["--mode", "rpc", "--offline", "--no-session", ...(DISCOVER ? [] : ["--extension", extension])];
const child = spawn(process.execPath, [cli, ...args], {
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_MANAGED_INSTALL_ROOT: installRoot, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "response" && record.id) responses.set(record.id, record);
  }
});

const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

const send = (record) => child.stdin.write(`${JSON.stringify(record)}\n`);
const waitFor = async (id, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (responses.has(id)) return responses.get(id);
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`等待 ${id} 超时。stderr 片段：${stderr.join("").slice(-800)}`);
};

const step = (name, fn) => {
  fn();
  console.error(`  \u2714 ${name}`);
};

try {
  send({ id: "1", type: "get_commands" });
  const commands = await waitFor("1");
  const list = commands.data?.commands ?? [];
  const names = list.map((c) => c.name);

  if (DISCOVER) {
    step("真实配置下 pi 自动发现了已安装的扩展", () => {
      const relay = list.find((c) => c.name === "switch");
      assert.ok(relay, `命令列表里没有 /switch：${names.join(", ")}`);
      console.error(`    /switch 描述：${relay.description ?? "(无)"}`);
    });
    console.error("\n真实配置发现测试通过 ✅");
  } else {
    step("扩展被 pi 加载，/switch 与 /switch-save 出现在命令列表", () => {
      assert.ok(names.includes("switch"), `命令列表：${names.join(", ")}`);
      assert.ok(names.includes("switch-save"));
    });

    send({ id: "2", type: "get_state" });
    const before = await waitFor("2");

    send({ id: "3", type: "prompt", message: "/switch gemini" });
    const promptResponse = await waitFor("3");
    assert.equal(promptResponse.success, true, JSON.stringify(promptResponse));
    await new Promise((r) => setTimeout(r, 800)); // 等命令处理完

    send({ id: "4", type: "get_state" });
    const after = await waitFor("4");
    step("/switch gemini 真的切换了当前会话的模型", () => {
      const text = JSON.stringify(after.data);
      assert.match(text, /gemini-3-pro/, `切换后状态：${text.slice(0, 300)}（切换前：${JSON.stringify(before.data).slice(0, 200)}）`);
    });

    send({ id: "5", type: "prompt", message: "/switch 不存在的模型xyz" });
    await waitFor("5");
    send({ id: "6", type: "get_state" });
    const unchanged = await waitFor("6");
    step("无匹配时不会乱切模型", () => {
      assert.match(JSON.stringify(unchanged.data), /gemini-3-pro/);
    });

    console.error("\nRPC 集成测试全部通过 ✅");
  }
} finally {
  child.kill();
  if (!DISCOVER) fs.rmSync(agentDir, { recursive: true, force: true });
}

