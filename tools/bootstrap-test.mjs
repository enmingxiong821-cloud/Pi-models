#!/usr/bin/env node
// bootstrap 与安装脚本自测：命令组合、非交互降级、本地假中转站、脚本文法。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.PMH_NO_PROXY = "1";
process.env.PMH_NONINTERACTIVE = "1";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { cmdBootstrap, makeContext } = await import("../src/commands.mjs");

const step = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

const tempAgent = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmh-bootstrap-"));
  return { dir, ctx: makeContext({ agentDir: dir }) };
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const exists = (file) => fs.existsSync(file);

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

await step("--no-extension --no-config：完全不写盘", async () => {
  const { dir, ctx } = tempAgent();
  const out = await capture(() => cmdBootstrap(ctx, "", "", { noExtension: true, noConfig: true }));
  assert.match(out, /初始化/);
  assert.match(out, /跳过中转站配置/);
  assert.equal(exists(path.join(dir, "settings.json")), false);
  assert.equal(exists(path.join(dir, "models.json")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

await step("默认：登记 pi 包，非交互无地址时跳过配置", async () => {
  const { dir, ctx } = tempAgent();
  const out = await capture(() => cmdBootstrap(ctx, "", "", {}));
  const settings = readJson(path.join(dir, "settings.json"));
  assert.ok(settings.packages.some((p) => p.includes("pi-model")));
  assert.match(out, /没有提供中转站地址/);
  assert.equal(exists(path.join(dir, "models.json")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

await step("--copy：扩展复制到 agent 目录，不登记包", async () => {
  const { dir, ctx } = tempAgent();
  const out = await capture(() => cmdBootstrap(ctx, "", "", { copy: true, noConfig: true }));
  assert.ok(exists(path.join(dir, "extensions", "quick-switch.js")));
  assert.ok(exists(path.join(dir, "extensions", "pmh-auto", "index.js")));
  assert.ok(exists(path.join(dir, "extensions", "pmh-auto", "router.mjs")));
  const settings = exists(path.join(dir, "settings.json"))
    ? readJson(path.join(dir, "settings.json"))
    : { packages: [] };
  assert.equal((settings.packages ?? []).some((p) => p.includes("pi-model")), false);
  assert.match(out, /跳过中转站配置/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await step("给定地址：发现模型并写入配置，密钥不回显", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const { dir, ctx } = tempAgent();
  const key = "test-key-should-not-print";
  try {
    const out = await capture(() => cmdBootstrap(ctx, `http://127.0.0.1:${port}`, key, { noExtension: true }));
    assert.match(out, /初始化完成/);
    assert.equal(out.includes(key), false);
    const models = readJson(path.join(dir, "models.json"));
    const provider = Object.values(models.providers)[0];
    assert.deepEqual(provider.models.map((m) => m.id).sort(), ["alpha", "beta"]);
    const auth = readJson(path.join(dir, "auth.json"));
    assert.equal(Object.values(auth)[0].key, key);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await step("安装脚本包含下载、PATH 与 bootstrap 入口", async () => {
  const sh = fs.readFileSync(path.join(ROOT, "install.sh"), "utf8");
  assert.match(sh, /archive\/refs\/tags/);
  assert.match(sh, /releases\/latest/);
  assert.match(sh, /\/dev\/tty/);
  assert.match(sh, /bootstrap/);
  const ps = fs.readFileSync(path.join(ROOT, "install.ps1"), "utf8");
  assert.ok(ps.charCodeAt(0) === 0xfeff, "install.ps1 需要 UTF-8 BOM，否则 Windows PowerShell 5.1 会乱码");
  assert.match(ps, /releases\/latest/);
  assert.match(ps, /bootstrap/);
  for (const file of ["install.cmd", "一键安装.cmd", "install.command", "bin/pmh", "bin/pmh.cmd"]) {
    assert.ok(exists(path.join(ROOT, file)), `缺少 ${file}`);
  }
});

await step("install.sh 通过 sh -n 语法检查", async () => {
  const result = spawnSync("bash", ["-n", path.join(ROOT, "install.sh")], { encoding: "utf8" });
  if (result.error) return; // 没有 bash 的环境跳过
  assert.equal(result.status, 0, result.stderr);
});

await step("install.ps1 通过 PowerShell 语法解析（Windows）", async () => {
  if (process.platform !== "win32") return;
  const script = path.join(ROOT, "install.ps1").replace(/'/g, "''");
  const result = spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    `$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$null,[ref]$e) | Out-Null; if ($e.Count) { exit 1 }`,
  ], { encoding: "utf8" });
  if (result.error) return;
  assert.equal(result.status, 0, result.stderr);
});

console.error("bootstrap: all checks passed");
