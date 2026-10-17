import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { listDir, readJson } from "./util.mjs";

/** pi 的 agent 目录：--agent-dir > PMH_AGENT_DIR > PI_CODING_AGENT_DIR（pi 官方变量）> ~/.pi/agent */
export function resolveAgentDir(override) {
  const dir = override ?? process.env.PMH_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR;
  return dir ? path.resolve(dir) : path.join(os.homedir(), ".pi", "agent");
}

export function configPaths(agentDir) {
  return {
    dir: agentDir,
    models: path.join(agentDir, "models.json"),
    auth: path.join(agentDir, "auth.json"),
    settings: path.join(agentDir, "settings.json"),
    modelsStore: path.join(agentDir, "models-store.json"),
    extensionSettings: path.join(agentDir, "extension-settings", "provider-newapi.json"),
  };
}

/** 找到当前安装的 pi 版本目录（managed install）。 */
export function findPiInstall(agentDir) {
  const installRoot = path.join(agentDir, "install");
  const currentFile = path.join(installRoot, "current-version");
  let version = null;
  try {
    version = fs.readFileSync(currentFile, "utf8").trim();
  } catch {
    version = null;
  }
  const candidates = [];
  if (version) candidates.push(path.join(installRoot, "releases", version));
  for (const v of listDir(path.join(installRoot, "releases")).sort().reverse()) {
    candidates.push(path.join(installRoot, "releases", v));
  }
  for (const dir of candidates) {
    const pkgDir = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (fs.existsSync(path.join(pkgDir, "package.json"))) {
      const pkg = readJson(path.join(pkgDir, "package.json"), {});
      return { root: dir, version: pkg.version ?? version, pkgDir, agentDir };
    }
  }
  return { root: null, version, pkgDir: null, agentDir };
}

/** pi 自带的模型目录（元数据来源），返回目录列表。 */
export function catalogDirs(agentDir, explicit) {
  const dirs = [];
  if (explicit) dirs.push(path.resolve(explicit));
  // 即使 --agent-dir 指向别处（测试 / 多份配置），也去默认位置找一次 pi 安装：
  // 官方模型目录是公共数据，复用它能给中转站模型补全上下文窗口、价格等元数据。
  const candidates = [agentDir, path.join(os.homedir(), ".pi", "agent")];
  for (const dir of [...new Set(candidates.filter(Boolean))]) {
    const install = findPiInstall(dir);
    if (install.root) {
      dirs.push(path.join(install.root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"));
    }
  }
  return dirs.filter((d) => fs.existsSync(d));
}

/**
 * 找到 pi 的启动器。跨平台：Windows 看 pi.cmd，类 Unix 看无扩展名的 pi，
 * 也会看常见的全局安装位置（Homebrew / ~/.local/bin），最后才回退到 PATH。
 */
export function findPiLauncher(agentDir, { exists = (p) => fs.existsSync(p), home = os.homedir() } = {}) {
  const candidates = [
    process.env.PMH_PI_BIN,
    path.join(agentDir, "bin", "pi.cmd"),
    path.join(agentDir, "bin", "pi"),
    path.join(home, ".local", "bin", "pi"),
    "/usr/local/bin/pi",
    "/opt/homebrew/bin/pi",
  ].filter(Boolean);
  for (const p of candidates) {
    if (exists(p)) return { command: p, kind: p.endsWith(".cmd") ? "cmd" : "bin" };
  }
  // 兜底交给 PATH：Windows 需要 shell 才能解析 pi.cmd（PATHEXT），类 Unix 直接 exec。
  return { command: "pi", kind: process.platform === "win32" ? "cmd" : "path", fromPath: true };
}

/** 启动器是否需要在 shell 里跑（Windows 的 .cmd 需要）。 */
export function launcherNeedsShell(launcher) {
  return launcher?.kind === "cmd";
}

/**
 * 交给 shell 启动时，路径里有空格必须加引号，
 * 否则 C:\Users\John Doe\.pi\... 会被 cmd 从空格处截断。
 */
export function launcherCommand(launcher) {
  if (!launcher) return "";
  if (launcherNeedsShell(launcher) && /\s/.test(launcher.command)) return `"${launcher.command}"`;
  return launcher.command;
}
