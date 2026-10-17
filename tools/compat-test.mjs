#!/usr/bin/env node
// pi 兼容检测与扩展自同步：全部在临时目录里跑，不碰真实 ~/.pi。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.PMH_NO_PROXY = "1";
process.env.PMH_NONINTERACTIVE = "1";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pmh-compat-"));
const write = (file, content = "") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const typesFile = (agentDir, version, source) => {
  const pkgDir = path.join(agentDir, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
  write(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
  write(path.join(pkgDir, "dist", "core", "extensions", "types.d.ts"), source);
  // 真实 pi 把 hasConfiguredAuth 放在另一个声明文件里
  write(path.join(pkgDir, "dist", "core", "model-registry.d.ts"), "hasConfiguredAuth(model: Model): boolean;\n");
};
const setVersion = (agentDir, version) => write(path.join(agentDir, "install", "current-version"), `${version}\n`);
const FULL_API = "/** registerVirtualModel registerCommand \"session_start\" hasConfiguredAuth */\n";

/** 假仓库：两份扩展源文件，供复制/同步测试。 */
function fakeRepo(contents = "v1") {
  const repo = temp();
  write(path.join(repo, "extensions", "quick-switch.js"), `// quick ${contents}\n`);
  for (const file of ["index.js", "router.mjs", "compat.mjs"]) {
    write(path.join(repo, "extensions", "auto-router", file), `// ${file} ${contents}\n`);
  }
  return repo;
}

const {
  AUTO_FILES, checkCompat, compatStatePath, installedMode, packageEntry, piAgentDir,
  probePiApi, readPiVersion, readSourceMarker, repoAvailable, sourceMarkerPath, staleCopies,
  syncCopiedExtensions, writeSourceMarker,
} = await import("../extensions/auto-router/compat.mjs");

const step = (name, fn) => {
  fn();
  console.error(`  ✔ ${name}`);
};
const stepAsync = async (name, fn) => {
  await fn();
  console.error(`  ✔ ${name}`);
};

step("probePiApi：读 current-version 与类型声明里的 API", () => {
  const agentDir = temp();
  setVersion(agentDir, "1.3.0");
  typesFile(agentDir, "1.3.0", FULL_API);
  const probe = probePiApi(agentDir);
  assert.equal(probe.version, "1.3.0");
  assert.equal(probe.known, true);
  assert.deepEqual(probe.apis, {
    virtualModels: true, commands: true, sessionStart: true, modelRegistryAuth: true,
  });
});

step("probePiApi：非 managed install 不报错，known=false", () => {
  const probe = probePiApi(temp());
  assert.equal(probe.version, null);
  assert.equal(probe.known, false);
  assert.equal(probe.apis, null);
});

step("probePiApi：缺 current-version 时退回最新 release", () => {
  const agentDir = temp();
  write(path.join(agentDir, "install", "releases", "1.2.0", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "{}");
  typesFile(agentDir, "1.2.0", FULL_API);
  assert.equal(readPiVersion(agentDir), null);
  assert.equal(probePiApi(agentDir).version, "1.2.0");
});

step("checkCompat：首次记录、无变化不写、版本升级才报 changed", () => {
  const agentDir = temp();
  setVersion(agentDir, "1.3.0");
  typesFile(agentDir, "1.3.0", FULL_API);
  const first = checkCompat(agentDir);
  assert.equal(first.changed, true);
  assert.equal(first.firstRun, true);
  assert.equal(first.previousVersion, null);
  assert.deepEqual(first.missing, []);
  assert.ok(fs.existsSync(compatStatePath(agentDir)));

  const second = checkCompat(agentDir);
  assert.equal(second.changed, false);
  assert.equal(second.firstRun, false);
  assert.equal(second.previousVersion, "1.3.0");

  setVersion(agentDir, "1.4.0");
  typesFile(agentDir, "1.4.0", FULL_API);
  const upgraded = checkCompat(agentDir);
  assert.equal(upgraded.changed, true);
  assert.equal(upgraded.version, "1.4.0");
  assert.equal(upgraded.previousVersion, "1.3.0");
});

step("checkCompat：API 消失时 missing 非空", () => {
  const agentDir = temp();
  setVersion(agentDir, "2.0.0");
  typesFile(agentDir, "2.0.0", '/** registerCommand "session_start" hasConfiguredAuth */');
  const result = checkCompat(agentDir);
  assert.deepEqual(result.missing, ["virtualModels"]);
});

step("packageEntry / installedMode：本地路径与 git 包都能识别", () => {
  const repo = fakeRepo();
  assert.equal(packageEntry({ packages: [repo] }, repo), true);
  assert.equal(packageEntry({ packages: [{ source: repo }] }, repo), true);
  assert.equal(packageEntry({ packages: ["npm:other"] }, repo), false);
  assert.equal(
    packageEntry({ packages: [`git:github.com/someone/${path.basename(repo)}@main`] }, repo),
    true,
  );

  const agentDir = temp();
  assert.equal(installedMode(agentDir, repo), "none");
  write(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [repo] }));
  assert.equal(installedMode(agentDir, repo), "package");

  write(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [path.relative(agentDir, repo)] }));
  assert.equal(installedMode(agentDir, repo), "package"); // 相对路径按 settings 所在目录解析

  write(path.join(agentDir, "extensions", "quick-switch.js"), "// copy\n");
  assert.equal(installedMode(agentDir, repo), "package"); // settings 优先于复制残留

  const staleMarker = temp();
  writeSourceMarker(staleMarker, { repoRoot: repo, mode: "package" });
  assert.equal(installedMode(staleMarker, repo), "none"); // pi remove 后不误报
});

step("repoAvailable：源仓库存在性", () => {
  const repo = fakeRepo();
  assert.equal(repoAvailable(repo), true);
  assert.equal(repoAvailable(path.join(repo, "missing")), false);
  assert.equal(repoAvailable(null), false);
});

step("staleCopies / syncCopiedExtensions：先全量复制，再增量并留备份", () => {
  const repo = fakeRepo("v1");
  const agentDir = temp();
  const all = [...AUTO_FILES.map((file) => path.join("extensions", "pmh-auto", file)), path.join("extensions", "quick-switch.js")];
  assert.deepEqual(staleCopies(agentDir, repo).sort(), all.sort());

  const first = syncCopiedExtensions(agentDir, repo);
  assert.equal(first.length, all.length);
  assert.deepEqual(staleCopies(agentDir, repo), []);
  assert.deepEqual(syncCopiedExtensions(agentDir, repo), []);

  write(path.join(repo, "extensions", "auto-router", "router.mjs"), "// router v2\n");
  assert.deepEqual(staleCopies(agentDir, repo), [path.join("extensions", "pmh-auto", "router.mjs")]);
  assert.deepEqual(syncCopiedExtensions(agentDir, repo), [path.join("extensions", "pmh-auto", "router.mjs")]);
  const dir = path.join(agentDir, "extensions", "pmh-auto");
  assert.ok(fs.readdirSync(dir).some((file) => file.startsWith("router.mjs.bak-")));
  assert.equal(fs.readFileSync(path.join(dir, "router.mjs"), "utf8"), "// router v2\n");
});

step("syncCopiedExtensions：scope=auto 不碰 quick-switch", () => {
  const repo = fakeRepo("v1");
  const agentDir = temp();
  const changed = syncCopiedExtensions(agentDir, repo, "auto");
  assert.deepEqual(changed.sort(), AUTO_FILES.map((file) => path.join("extensions", "pmh-auto", file)).sort());
  assert.equal(fs.existsSync(path.join(agentDir, "extensions", "quick-switch.js")), false);
  assert.deepEqual(staleCopies(agentDir, repo, "auto"), []);
});

step("syncCopiedExtensions：源仓库不存在时明确报错，不假装已是最新", () => {
  assert.throws(
    () => syncCopiedExtensions(temp(), path.join(temp(), "gone")),
    /源目录不存在/,
  );
});

step("source marker：写读一致，路径固定在 extension-settings 下", () => {
  const agentDir = temp();
  writeSourceMarker(agentDir, { repoRoot: "C:/repo", mode: "copy", scope: "auto" });
  const marker = readSourceMarker(agentDir);
  assert.equal(marker.repoRoot, "C:/repo");
  assert.equal(marker.mode, "copy");
  assert.equal(marker.scope, "auto");
  assert.ok(marker.updatedAt);
  assert.equal(sourceMarkerPath(agentDir), path.join(agentDir, "extension-settings", "pmh-source.json"));
});

// ---- 扩展启动钩子：升级后自动同步且绝不抛错 ----
const agentDir = temp();
process.env.PI_CODING_AGENT_DIR = agentDir;
setVersion(agentDir, "1.3.0");
typesFile(agentDir, "1.3.0", FULL_API);
const repo = fakeRepo("v1");
writeSourceMarker(agentDir, { repoRoot: repo, mode: "copy" });

const { default: autoRouter } = await import("../extensions/auto-router/index.js");

function fakePi() {
  const hooks = new Map();
  return {
    hooks,
    on: (name, handler) => hooks.set(name, handler),
    registerVirtualModel: () => {},
    registerCommand: () => {},
  };
}

await stepAsync("扩展 session_start：首次只记录，不打扰用户", async () => {
  const pi = fakePi();
  autoRouter(pi);
  const notes = [];
  pi.hooks.get("session_start")({}, { ui: { notify: (message, type) => notes.push({ message, type }) } });
  assert.equal(notes.length, 0);
  assert.ok(fs.existsSync(compatStatePath(agentDir)));
});

await stepAsync("扩展 session_start：pi 升级后自动同步复制版扩展并提示", async () => {
  const pi = fakePi();
  autoRouter(pi);
  const notes = [];
  setVersion(agentDir, "1.4.0");
  typesFile(agentDir, "1.4.0", FULL_API);
  write(path.join(repo, "extensions", "auto-router", "index.js"), "// index v2\n");
  pi.hooks.get("session_start")({}, { ui: { notify: (message, type) => notes.push({ message, type }) } });
  assert.ok(notes.some((note) => note.message.includes("1.3.0") && note.message.includes("1.4.0")));
  assert.ok(notes.some((note) => note.message.includes("自动同步")));
  assert.equal(fs.readFileSync(path.join(agentDir, "extensions", "pmh-auto", "index.js"), "utf8"), "// index v2\n");
});

await stepAsync("扩展 session_start：API 缺失只告警，不抛错", async () => {
  const pi = fakePi();
  autoRouter(pi);
  const notes = [];
  setVersion(agentDir, "2.0.0");
  typesFile(agentDir, "2.0.0", '/** registerCommand "session_start" hasConfiguredAuth */');
  pi.hooks.get("session_start")({}, { ui: { notify: (message, type) => notes.push({ message, type }) } });
  assert.ok(notes.some((note) => note.message.includes("缺少 virtualModels") && note.type === "warning"));
  // 连类型声明都读不到时也不能抛
  fs.rmSync(path.join(agentDir, "install"), { recursive: true, force: true });
  pi.hooks.get("session_start")({}, { ui: { notify: () => { throw new Error("ui boom"); } } });
});

await stepAsync("扩展 session_start：源仓库被移动时告警且不抛错", async () => {
  const pi = fakePi();
  autoRouter(pi);
  const notes = [];
  setVersion(agentDir, "3.0.0");
  typesFile(agentDir, "3.0.0", FULL_API);
  writeSourceMarker(agentDir, { repoRoot: path.join(temp(), "gone"), mode: "copy" });
  pi.hooks.get("session_start")({}, { ui: { notify: (message, type) => notes.push({ message, type }) } });
  assert.ok(notes.some((note) => note.message.includes("仓库路径不存在") && note.type === "warning"));
  writeSourceMarker(agentDir, { repoRoot: repo, mode: "copy" });
});

// ---- CLI ----
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureCatalog = path.join(here, "fixtures", "catalog");
const { cmdAuto, cmdInstallExtension, makeContext } = await import("../src/commands.mjs");

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

await stepAsync("CLI auto status --json：包含 pi 版本、API 与安装方式", async () => {
  const cliAgent = temp();
  setVersion(cliAgent, "1.3.0");
  typesFile(cliAgent, "1.3.0", FULL_API);
  writeSourceMarker(cliAgent, { repoRoot: repo, mode: "copy" });
  const status = JSON.parse(await capture(() => cmdAuto(makeContext({ agentDir: cliAgent, catalog: fixtureCatalog }), ["status"], { json: true })));
  assert.equal(status.pi.version, "1.3.0");
  assert.equal(status.pi.missing.length, 0);
  assert.equal(status.extension.mode, "copy");
  assert.ok(Array.isArray(status.extension.stale));
});

await stepAsync("CLI auto sync：复制模式同步仓库最新文件；包模式直接说明", async () => {
  const cliAgent = temp();
  setVersion(cliAgent, "1.3.0");
  typesFile(cliAgent, "1.3.0", FULL_API);
  writeSourceMarker(cliAgent, { repoRoot: repo, mode: "copy", scope: "auto" });
  const out = await capture(() => cmdAuto(makeContext({ agentDir: cliAgent, catalog: fixtureCatalog }), ["sync"]));
  assert.match(out, /已同步/);
  assert.ok(fs.existsSync(path.join(cliAgent, "extensions", "pmh-auto", "index.js")));
  assert.equal(fs.existsSync(path.join(cliAgent, "extensions", "quick-switch.js")), false);

  const pkgAgent = temp();
  write(path.join(pkgAgent, "settings.json"), JSON.stringify({ packages: [repo] }));
  writeSourceMarker(pkgAgent, { repoRoot: repo, mode: "package" });
  const pkgOut = await capture(() => cmdAuto(makeContext({ agentDir: pkgAgent, catalog: fixtureCatalog }), ["sync"]));
  assert.match(pkgOut, /包模式/);
});

await stepAsync("CLI install-extension --link：登记包、停用复制版；--dry-run 不写盘", async () => {
  const cliAgent = temp();
  write(path.join(cliAgent, "settings.json"), JSON.stringify({ packages: [] }, null, 2));
  write(path.join(cliAgent, "extensions", "quick-switch.js"), "// old copy\n");
  const ctx = () => makeContext({ agentDir: cliAgent, catalog: fixtureCatalog });

  const before = fs.readFileSync(path.join(cliAgent, "settings.json"), "utf8");
  await capture(() => cmdInstallExtension(ctx(), { link: true, dryRun: true }));
  assert.equal(fs.readFileSync(path.join(cliAgent, "settings.json"), "utf8"), before);

  await capture(() => cmdInstallExtension(ctx(), { link: true }));
  const settings = JSON.parse(fs.readFileSync(path.join(cliAgent, "settings.json"), "utf8"));
  assert.ok(settings.packages.length === 1);
  assert.equal(readSourceMarker(cliAgent).mode, "package");
  assert.equal(installedMode(cliAgent, settings.packages[0]), "package");
  const files = fs.readdirSync(path.join(cliAgent, "extensions"));
  assert.ok(files.some((file) => file.startsWith("quick-switch.js.disabled-")));
  assert.equal(files.includes("quick-switch.js"), false);
});

await stepAsync("CLI install-extension --copy：已登记为包时拒绝重复加载", async () => {
  const cliAgent = temp();
  const repoRoot = path.resolve(here, "..");
  write(path.join(cliAgent, "settings.json"), JSON.stringify({ packages: [repoRoot] }));
  const ctx = () => makeContext({ agentDir: cliAgent, catalog: fixtureCatalog });
  await assert.rejects(() => capture(() => cmdInstallExtension(ctx(), { copy: true })), /加载两次/);
  assert.equal(fs.existsSync(path.join(cliAgent, "extensions", "quick-switch.js")), false);
  await capture(() => cmdInstallExtension(ctx(), { copy: true, force: true }));
  assert.ok(fs.existsSync(path.join(cliAgent, "extensions", "quick-switch.js")));
});

console.error("compat: all checks passed");
