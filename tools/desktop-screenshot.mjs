#!/usr/bin/env node
// 用临时 agent 目录启动真实 Electron，截取四页签界面，供 README 使用。
// 不读取真实 ~/.pi，也不会写入任何真实凭据。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { configPaths } from "../src/paths.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-shots-"));
const agentDir = path.join(root, "agent");
const userData = path.join(root, "userdata");
const outDir = path.resolve(import.meta.dirname, "..", "docs", "images", "screenshots");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const paths = configPaths(agentDir);

const providers = {
  relay: {
    name: "Relay Hub",
    baseUrl: "https://api.relay.example/v1",
    api: "openai-completions",
    models: [
      {
        id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5",
        contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
      {
        id: "claude-haiku-4-5", name: "Claude Haiku 4.5",
        contextWindow: 200000, maxTokens: 32000, reasoning: true, input: ["text", "image"],
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      },
      {
        id: "gpt-5", name: "GPT-5",
        contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"],
        cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
      },
      {
        id: "gemini-2.5-pro", name: "Gemini 2.5 Pro",
        contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"],
        cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 0 },
      },
    ],
  },
  local: {
    name: "Local Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    models: [
      { id: "qwen3-coder", name: "Qwen3 Coder", contextWindow: 262144, maxTokens: 32768, cost: { input: 0, output: 0 } },
      { id: "llama3.3", name: "Llama 3.3", contextWindow: 131072, maxTokens: 8192, cost: { input: 0, output: 0 } },
    ],
  },
};

const day = 24 * 60 * 60 * 1000;
const now = Date.now();

fs.writeFileSync(paths.models, JSON.stringify({ providers }, null, 2));
fs.writeFileSync(paths.auth, JSON.stringify({
  relay: { type: "api_key", key: "demo-placeholder" },
  local: { type: "api_key", key: "ollama" },
}, null, 2), { mode: 0o600 });

const mru = (models) => models.map((model) => ({ model, at: new Date(now - 2 * 60 * 60 * 1000).toISOString() }));
fs.writeFileSync(paths.registry, JSON.stringify({
  version: 1,
  groups: {
    cloud: { title: "云端中转", createdAt: new Date(now - 30 * day).toISOString() },
  },
  relays: {
    relay: {
      name: "Relay Hub",
      baseUrl: "https://api.relay.example/v1",
      api: "openai-completions",
      group: "cloud",
      favorites: ["claude-sonnet-4-5", "gpt-5", "gemini-2.5-pro"],
      mru: mru(["claude-sonnet-4-5", "gpt-5", "gemini-2.5-pro", "claude-haiku-4-5"]),
      lastModel: "claude-sonnet-4-5",
      source: "manual",
    },
    local: {
      name: "Local Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      favorites: ["qwen3-coder"],
      mru: mru(["qwen3-coder"]),
      lastModel: "qwen3-coder",
      source: "manual",
    },
  },
  history: [
    { provider: "relay", model: "claude-sonnet-4-5", at: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
  ],
  settings: { widget: "auto" },
}, null, 2));
fs.writeFileSync(paths.settings, JSON.stringify({
  defaultProvider: "relay",
  defaultModel: "claude-sonnet-4-5",
  modelThinkingLevels: {
    "relay/claude-sonnet-4-5": "high",
    "relay/gpt-5": "medium",
  },
}, null, 2));

fs.mkdirSync(path.join(agentDir, "extension-settings"), { recursive: true });
fs.writeFileSync(path.join(agentDir, "extension-settings", "pmh-auto.json"), JSON.stringify({
  version: 2,
  enabled: true,
  pinned: null,
  tiers: {
    cheap: { provider: "relay", model: "claude-haiku-4-5" },
    standard: { provider: "relay", model: "claude-sonnet-4-5" },
    strong: { provider: "relay", model: "gpt-5" },
  },
  thresholds: { cheap: 0.18, strong: 0.55 },
  upgradeOnRetry: true,
  useModelThinking: true,
  projects: {
    "relay-gateway": { pinned: "strong" },
    "docs-site": { pinned: "cheap" },
  },
}, null, 2));

fs.mkdirSync(paths.sessions, { recursive: true });
const sessions = [
  {
    id: "shot-1", daysAgo: 0, project: "relay-gateway", model: "claude-sonnet-4-5", provider: "relay",
    rows: [
      { input: 120000, output: 16800, cacheRead: 640000, cacheWrite: 28000, cost: 2.54 },
      { input: 62400, output: 8000, cacheRead: 320000, cacheWrite: 14000, cost: 1.28 },
    ],
  },
  {
    id: "shot-2", daysAgo: 1, project: "desktop-shell", model: "gpt-5", provider: "relay",
    rows: [
      { input: 60000, output: 9200, cacheRead: 330000, cacheWrite: 13000, cost: 1.35 },
      { input: 36000, output: 5000, cacheRead: 210000, cacheWrite: 8000, cost: 0.79 },
    ],
  },
  {
    id: "shot-3", daysAgo: 2, project: "relay-gateway", model: "claude-sonnet-4-5", provider: "relay",
    rows: [
      { input: 85000, output: 11800, cacheRead: 420000, cacheWrite: 22000, cost: 1.82 },
      { input: 60000, output: 8000, cacheRead: 300000, cacheWrite: 16000, cost: 1.24 },
    ],
  },
  {
    id: "shot-4", daysAgo: 3, project: "docs-site", model: "claude-haiku-4-5", provider: "relay",
    rows: [{ input: 62000, output: 8900, cacheRead: 310000, cacheWrite: 12000, cost: 1.21 }],
  },
  {
    id: "shot-5", daysAgo: 4, project: "desktop-shell", model: "claude-sonnet-4-5", provider: "relay",
    rows: [
      { input: 120000, output: 18200, cacheRead: 680000, cacheWrite: 32000, cost: 3.05 },
      { input: 90000, output: 13000, cacheRead: 500000, cacheWrite: 24000, cost: 1.6 },
    ],
  },
  {
    id: "shot-6", daysAgo: 5, project: "docs-site", model: "gemini-2.5-pro", provider: "relay",
    rows: [{ input: 78000, output: 10500, cacheRead: 420000, cacheWrite: 18000, cost: 1.73 }],
  },
];

for (const session of sessions) {
  const stamp = new Date(now - session.daysAgo * day).toISOString();
  const lines = [{
    type: "session", id: session.id, version: 3, timestamp: stamp,
    cwd: path.join("C:\\work", session.project),
  }];
  session.rows.forEach((row, index) => {
    lines.push({
      type: "message", id: `${session.id}-m${index}`, parentId: index ? `${session.id}-m${index - 1}` : null,
      timestamp: stamp,
      message: {
        role: "assistant", provider: session.provider, model: session.model,
        usage: {
          input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
          totalTokens: row.input + row.output + row.cacheRead + row.cacheWrite,
          cost: { total: row.cost },
        },
      },
    });
  });
  fs.writeFileSync(
    path.join(paths.sessions, `${session.id}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

const port = 9800 + Math.floor(Math.random() * 200);
const child = spawn(electronPath, [
  ".",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userData}`,
  "--disable-gpu",
], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: { ...process.env, PMH_AGENT_DIR: agentDir, PMH_E2E: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron 尚未启动，继续等。
    }
    await sleep(150);
  }
  throw new Error(`Electron 未暴露调试页面\n${output.slice(-2000)}`);
}

let ws;
let seq = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const reply = await send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (reply.result?.exceptionDetails) {
    throw new Error(reply.result.exceptionDetails.exception?.description ?? "页面脚本异常");
  }
  return reply.result?.result?.value;
}

async function waitFor(expression, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

async function shot(name) {
  await evaluate(`(() => {
    const node = document.getElementById('agent-dir');
    if (node) {
      node.textContent = '配置 ~/.pi/agent';
      node.title = '~/.pi/agent';
    }
  })()`);
  await sleep(250);
  const reply = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(reply.result.data, "base64"));
  console.log(`${path.relative(path.resolve(import.meta.dirname, ".."), file)}`);
}

try {
  const page = await findPage();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id).resolve(message);
      pending.delete(message.id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1180, height: 900, deviceScaleFactor: 1.5, mobile: false,
  });
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await waitFor("Boolean(window.pmh) && document.querySelectorAll('.tab').length === 4", "应用加载");

  await waitFor("document.querySelectorAll('#list .row').length === 6", "模型列表");
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('#list .row')]
      .find((node) => node.textContent.includes('claude-sonnet-4-5'));
    row?.click();
  })()`);
  await waitFor("document.getElementById('detail').textContent.includes('思考等级')", "模型详情");
  await shot("desktop-models");

  await evaluate("document.querySelector('[data-tab=\"sites\"]').click()");
  await waitFor("document.querySelectorAll('#provider-list .side-row').length === 2", "站点列表");
  await evaluate("document.querySelector('#provider-list .side-row').click()");
  await waitFor("document.getElementById('f-baseurl').value.includes('relay.example')", "站点详情");
  await waitFor("document.querySelectorAll('#model-rows tr').length === 4", "站点模型");
  await shot("desktop-sites");

  await evaluate("document.querySelector('[data-tab=\"auto\"]').click()");
  await waitFor("document.querySelectorAll('#auto-tiers tr').length === 3", "自动路由");
  await waitFor("document.querySelectorAll('#auto-projects tr').length === 2", "项目规则");
  await evaluate(`(() => {
    document.getElementById('auto-preview-text').value = '重构网关的并发处理与错误恢复';
    document.getElementById('auto-preview-project').value = 'relay-gateway';
    document.getElementById('auto-preview-btn').click();
  })()`);
  await waitFor("document.getElementById('auto-preview').hidden === false", "路由预览");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1180, height: 1210, deviceScaleFactor: 1.5, mobile: false,
  });
  await evaluate(`(() => {
    const page = document.querySelector('#view-auto .page');
    const card = page.querySelectorAll('.card')[1];
    page.scrollTop += card.getBoundingClientRect().top - page.getBoundingClientRect().top - 20;
  })()`);
  await shot("desktop-auto");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1180, height: 900, deviceScaleFactor: 1.5, mobile: false,
  });

  await evaluate("document.querySelector('[data-tab=\"usage\"]').click()");
  await waitFor("document.querySelectorAll('#usage-rows tr').length === 6", "用量页");
  await shot("desktop-usage");

  console.log("截图完成");
} finally {
  try { ws?.close(); } catch { /* 忽略关闭错误。 */ }
  child.kill();
  await sleep(400);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 上 Electron 可能尚未释放文件，留给系统临时目录清理。
  }
}
