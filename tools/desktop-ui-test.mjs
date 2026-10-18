#!/usr/bin/env node
// 桌面 UI 冒烟测试：启动真实 Electron，用 CDP 驱动四页签，断言表单与脱敏。
// 使用临时 agent 目录与临时 userData，不读写真实 ~/.pi。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { configPaths } from "../src/paths.mjs";

const SECRET = "sk-ui-test-secret-987654";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-ui-"));
const agentDir = path.join(root, "agent");
const userData = path.join(root, "userdata");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
const paths = configPaths(agentDir);

fs.writeFileSync(paths.models, JSON.stringify({
  providers: {
    demo: {
      name: "Demo",
      baseUrl: "https://demo.invalid/v1",
      api: "openai-completions",
      models: [
        { id: "alpha", contextWindow: 128000, cost: { input: 1, output: 2 } },
        { id: "beta", contextWindow: 200000, reasoning: true },
      ],
    },
  },
}));
fs.writeFileSync(paths.settings, JSON.stringify({ defaultProvider: "demo", defaultModel: "alpha" }));

fs.mkdirSync(paths.sessions, { recursive: true });
const sessionNow = new Date().toISOString();
const usageRows = [
  { type: "session", id: "ui-s1", version: 3, timestamp: sessionNow, cwd: agentDir },
  {
    type: "message", id: "ui-m1", parentId: null, timestamp: sessionNow,
    message: {
      role: "assistant", provider: "demo", model: "alpha",
      usage: { input: 1000, output: 200, totalTokens: 1200, cost: { total: 0.01 } },
    },
  },
  {
    type: "message", id: "ui-m2", parentId: "ui-m1", timestamp: sessionNow,
    message: {
      role: "assistant", provider: "demo", model: "unpriced-ui-model",
      usage: { input: 10, output: 10, totalTokens: 20 },
    },
  },
];
fs.writeFileSync(
  path.join(paths.sessions, "ui.jsonl"),
  `${usageRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
);

const port = 9300 + Math.floor(Math.random() * 500);
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
  for (let i = 0; i < 100; i += 1) {
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
  throw new Error(`Electron 未在端口 ${port} 暴露调试页面\n${output.slice(-2000)}`);
}

let ws;
let seq = 0;
const pending = new Map();
const errors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const reply = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (reply.result?.exceptionDetails) {
    throw new Error(reply.result.exceptionDetails.exception?.description ?? "页面脚本异常");
  }
  return reply.result?.result?.value;
}

async function waitFor(expression, label, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  let pageState = "";
  try {
    pageState = await evaluate(`JSON.stringify({
      status: document.querySelector('.status')?.textContent ?? '',
      dialogOpen: document.getElementById('dialog')?.open ?? null,
      submitFired: window.__submitFired ?? 0,
      errors: window.__uiErrors ?? [],
    })`);
  } catch {
    // 页面可能已关闭。
  }
  throw new Error(`等待超时：${label}\n页面状态：${pageState}${errors.length ? `\n页面异常：\n${errors.join("\n")}` : ""}`);
}

const step = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

try {
  const page = await findPage();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id).resolve(message);
      pending.delete(message.id);
    } else if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.exception?.description ?? "未知异常");
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  await send("Runtime.enable");
  await evaluate(`(() => {
    window.__uiErrors = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.__uiErrors.push(String(event.reason?.stack ?? event.reason));
    });
  })()`);
  await waitFor("Boolean(window.pmh) && document.querySelectorAll('.tab').length === 4", "应用加载");

  await step("四页签与模型列表", async () => {
    const tabs = await evaluate("[...document.querySelectorAll('.tab')].map((node) => node.textContent)");
    assert.deepEqual(tabs, ["模型", "站点", "自动路由", "用量"]);
    assert.equal(await evaluate("document.getElementById('view-models').hidden"), false);
    await waitFor("document.querySelectorAll('#list .row').length === 2", "模型列表渲染");
    assert.equal(await evaluate("document.getElementById('detail').textContent.includes('思考等级')"), true);
  });

  await step("站点页加载与详情", async () => {
    await evaluate("document.querySelector('[data-tab=\"sites\"]').click()");
    await waitFor("document.querySelectorAll('#provider-list .side-row').length === 1", "站点列表");
    await evaluate("document.querySelector('#provider-list .side-row').click()");
    await waitFor("document.getElementById('f-baseurl').value.includes('demo.invalid')", "站点详情");
    assert.equal(await evaluate("document.getElementById('f-provider').readOnly"), true);
    assert.match(await evaluate("document.getElementById('key-status').textContent"), /未配置/);
    assert.equal(await evaluate("document.querySelectorAll('#model-rows tr').length"), 2);
  });

  await step("写入 Key 后不残留明文", async () => {
    await evaluate(`(() => {
      const input = document.getElementById('f-key');
      input.value = ${JSON.stringify(SECRET)};
      document.getElementById('provider-form').requestSubmit();
    })()`);
    await waitFor("document.getElementById('f-key').value === '' && document.querySelector('.status').textContent.includes('已保存')", "Key 保存");
    assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(SECRET)})`), false);
    assert.match(await evaluate("document.getElementById('key-status').textContent"), /已配置 · auth\.json/);
  });

  await step("添加模型并显示成本", async () => {
    await evaluate("document.getElementById('model-add').click()");
    await waitFor("document.getElementById('dialog').open", "模型对话框");
    await evaluate(`(() => {
      const inputs = document.querySelectorAll('#dialog-body .field-grid input');
      inputs[0].value = 'gamma';
      inputs[1].value = 'Gamma';
      inputs[2].value = '64000';
      inputs[3].value = '8192';
      inputs[4].value = '0.5';
      inputs[5].value = '1';
      document.getElementById('dialog-ok').click();
    })()`);
    await waitFor("document.getElementById('dialog').open === false", "模型对话框关闭", 2500);
    await waitFor("document.querySelectorAll('#model-rows tr').length === 3", "模型行更新");
    assert.match(await evaluate("document.getElementById('model-rows').textContent"), /gamma/);
  });

  await step("删除模型需要原文确认", async () => {
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('#model-rows tr')].find((tr) => tr.dataset.model === 'gamma');
      row.querySelector('.button.danger').click();
    })()`);
    await waitFor("document.getElementById('dialog').open", "删除确认框");
    const expected = await evaluate("document.getElementById('dialog-body').textContent");
    assert.match(expected, /demo#gamma/);
    await evaluate(`(() => {
      const input = document.querySelector('#dialog-body input');
      input.value = 'demo#gamma';
      document.getElementById('dialog-ok').click();
    })()`);
    await waitFor("document.querySelectorAll('#model-rows tr').length === 2", "模型删除完成");
  });

  await step("模型页思考等级写入", async () => {
    await evaluate("document.querySelector('[data-tab=\"models\"]').click()");
    await waitFor("document.getElementById('view-models').hidden === false", "模型页显示");
    await evaluate("document.querySelectorAll('#list .row')[1].click()");
    await waitFor("document.querySelector('.detail-block select') !== null", "思考等级下拉");
    const saved = await evaluate(`(async () => {
      const select = document.querySelector('.detail-block select');
      select.value = 'high';
      select.dispatchEvent(new Event('change'));
      for (let i = 0; i < 50; i += 1) {
        const state = await window.pmh.thinkingGet({ provider: 'demo', model: 'beta' });
        if (state.ok && state.state.effective === 'high') return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })()`);
    assert.equal(saved, true);
  });

  await step("自动路由编辑、保存与预览", async () => {
    await evaluate("document.querySelector('[data-tab=\"auto\"]').click()");
    await waitFor("document.querySelectorAll('#auto-tiers tr').length === 3", "自动路由档位");
    assert.match(await evaluate("document.getElementById('auto-thresholds').textContent"), /轻量档/);
    assert.equal(await evaluate("document.querySelectorAll('#auto-tiers select[data-tier]').length"), 3);

    await evaluate(`(() => {
      const selects = [...document.querySelectorAll('#auto-tiers select[data-tier]')];
      for (const select of selects) select.value = select.dataset.tier === 'cheap' ? 'demo#alpha' : 'demo#beta';
      document.getElementById('auto-cheap-threshold').value = '0.2';
      document.getElementById('auto-strong-threshold').value = '0.6';
      document.getElementById('auto-project-key').value = 'ui-proj';
      document.getElementById('auto-project-tier').value = 'standard';
      document.getElementById('auto-project-add').click();
    })()`);
    await waitFor("document.querySelectorAll('#auto-projects tr').length === 1", "项目规则渲染");

    await evaluate("document.getElementById('auto-save').click()");
    await waitFor(
      "document.getElementById('status-text').textContent.includes('自动路由配置已保存')",
      "自动路由保存",
    );
    assert.equal(await evaluate("document.querySelectorAll('#auto-tiers select[data-tier]')[0].value"), "demo#alpha");
    assert.equal(await evaluate("document.querySelectorAll('#auto-tiers select[data-tier]')[2].value"), "demo#beta");
    assert.equal(await evaluate("document.getElementById('auto-state').textContent"), "已开启");

    await evaluate(`(() => {
      document.getElementById('auto-preview-text').value = '把错别字改一下';
      document.getElementById('auto-preview-project').value = 'ui-proj';
      document.getElementById('auto-preview-btn').click();
    })()`);
    await waitFor("document.getElementById('auto-preview').hidden === false", "路由预览");
    const preview = await evaluate("document.getElementById('auto-preview').textContent");
    assert.match(preview, /轻量/);
    assert.match(preview, /标准/);
    assert.match(preview, /项目固定/);
    assert.match(preview, /demo#beta/);
    assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(SECRET)})`), false);
  });

  await step("用量页渲染会话统计", async () => {
    await evaluate("document.querySelector('[data-tab=\"usage\"]').click()");
    await waitFor("document.getElementById('view-usage').hidden === false", "用量页显示");
    await waitFor("document.querySelectorAll('#usage-rows tr').length === 1", "用量按日渲染");
    const cards = await evaluate("document.getElementById('usage-cards').textContent");
    assert.match(cards, /1,220/);
    assert.match(cards, /0\.010/);
    assert.match(await evaluate("document.getElementById('usage-rows').textContent"), /1,220/);
    assert.match(await evaluate("document.getElementById('usage-note').textContent"), /含放弃分支/);
    assert.equal(await evaluate("document.getElementById('usage-missing-card').hidden"), false);
    assert.match(await evaluate("document.getElementById('usage-missing').textContent"), /unpriced-ui-model/);

    await evaluate(`(() => {
      const select = document.getElementById('usage-group');
      select.value = 'model';
      select.dispatchEvent(new Event('change'));
    })()`);
    await waitFor("document.querySelectorAll('#usage-rows tr').length === 2", "按模型分组");
    const rows = await evaluate("document.getElementById('usage-rows').textContent");
    assert.match(rows, /demo#alpha/);
    assert.match(rows, /demo#unpriced-ui-model/);
    assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(SECRET)})`), false);
  });

  await step("页面无未捕获异常", async () => {
    assert.deepEqual(errors, []);
  });

  const settings = JSON.parse(fs.readFileSync(paths.settings, "utf8"));
  assert.equal(settings.modelThinkingLevels["demo/beta"], "high");
  assert.equal(fs.readFileSync(paths.auth, "utf8").includes(SECRET), true);
  console.error("桌面 UI 测试全部通过 ✅");
} finally {
  try {
    ws?.close();
  } catch {
    // 忽略关闭错误。
  }
  child.kill();
  await sleep(400);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 上 Electron 可能尚未释放文件，留给系统临时目录清理。
  }
}
