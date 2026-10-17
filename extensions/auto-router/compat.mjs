// pi 版本/API 兼容探测与扩展自同步。只读安装目录、只写 pmh 自己的状态文件。
// 被 CLI 与 pi 扩展共用，因此不依赖 src/ 下的任何模块。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REQUIRED_APIS = ["virtualModels", "commands"];
const AUTO_FILES = ["index.js", "router.mjs", "compat.mjs"];

export function piAgentDir(env = process.env) {
  return path.resolve(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
}

export function compatStatePath(agentDir) {
  return path.join(agentDir, "extension-settings", "pmh-compat.json");
}

export function sourceMarkerPath(agentDir) {
  return path.join(agentDir, "extension-settings", "pmh-source.json");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function readPiVersion(agentDir) {
  try {
    return fs.readFileSync(path.join(agentDir, "install", "current-version"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** 当前版本优先；找不到 current-version 时退回 releases 下最新的完整安装。 */
export function piInstallInfo(agentDir) {
  const version = readPiVersion(agentDir);
  const releases = path.join(agentDir, "install", "releases");
  const candidates = version ? [version] : [];
  try {
    candidates.push(...fs.readdirSync(releases).sort().reverse());
  } catch {
    /* 非 managed install */
  }
  for (const candidate of [...new Set(candidates)]) {
    const pkgDir = path.join(releases, candidate, "node_modules", "@earendil-works", "pi-coding-agent");
    if (fs.existsSync(path.join(pkgDir, "package.json"))) {
      return { version: candidate, pkgDir, releaseDir: path.join(releases, candidate) };
    }
  }
  return { version, pkgDir: null, releaseDir: null };
}

/**
 * 从 pi 自带的类型声明里探测扩展 API。
 * 不 import pi（CLI 里 import 会拖慢启动，扩展里也没有必要），只做字符串检查。
 * known=false 表示这个 pi 版本没有可读的类型声明，此时不报警。
 * 注意：注册/命令 API 在 extensions/types.d.ts 里，hasConfiguredAuth 在
 * core/model-registry.d.ts 里，两个文件都要看。
 */
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** 先读约定文件；pi 改布局时在 dist/core 下按关键字找，避免版本一变就失明。 */
function findDeclaration(pkgDir, preferred, searchDir, needle) {
  for (const file of preferred) {
    const text = readText(path.join(pkgDir, file));
    if (text) return text;
  }
  try {
    for (const name of fs.readdirSync(path.join(pkgDir, searchDir))) {
      if (!name.endsWith(".d.ts")) continue;
      const text = readText(path.join(pkgDir, searchDir, name));
      if (text.includes(needle)) return text;
    }
  } catch {
    /* 目录不存在或不可读 */
  }
  return "";
}

export function probePiApi(agentDir) {
  const info = piInstallInfo(agentDir);
  const types = info.pkgDir
    ? findDeclaration(info.pkgDir, ["dist/core/extensions/types.d.ts", "dist/core/extensions/index.d.ts"], "dist/core/extensions", "registerVirtualModel")
    : "";
  const authTypes = info.pkgDir
    ? findDeclaration(info.pkgDir, ["dist/core/model-registry.d.ts"], "dist/core", "hasConfiguredAuth")
    : "";
  const known = types.length > 0;
  const apis = known
    ? {
        virtualModels: types.includes("registerVirtualModel"),
        commands: types.includes("registerCommand"),
        sessionStart: types.includes('"session_start"'),
        modelRegistryAuth: authTypes.includes("hasConfiguredAuth"),
      }
    : null;
  return { version: info.version, releaseDir: info.releaseDir, known, apis };
}

/**
 * 检测 pi 是否变化，只在变化时写状态文件。
 * missing 是必需 API 中缺失的项；调用方据此决定是否降级/告警。
 */
export function checkCompat(agentDir = piAgentDir()) {
  const current = probePiApi(agentDir);
  const previous = readJson(compatStatePath(agentDir), null);
  const prevApis = previous?.apis ?? {};
  const apisChanged = current.known
    && Object.entries(current.apis ?? {}).some(([key, value]) => prevApis[key] !== value);
  const changed = !previous || previous.version !== current.version || apisChanged;
  const missing = current.known ? REQUIRED_APIS.filter((key) => current.apis?.[key] === false) : [];
  const checkedAt = new Date().toISOString();
  if (changed) {
    writeJsonAtomic(compatStatePath(agentDir), {
      version: current.version,
      known: current.known,
      apis: current.apis,
      missing,
      previousVersion: previous?.version ?? null,
      checkedAt,
    });
  }
  return {
    changed,
    firstRun: !previous,
    version: current.version,
    previousVersion: previous?.version ?? null,
    known: current.known,
    apis: current.apis,
    missing,
    checkedAt,
  };
}

export function readSourceMarker(agentDir) {
  return readJson(sourceMarkerPath(agentDir), null);
}

export function writeSourceMarker(agentDir, marker) {
  writeJsonAtomic(sourceMarkerPath(agentDir), { ...marker, updatedAt: new Date().toISOString() });
}

function packageSource(entry) {
  return typeof entry === "string" ? entry : entry?.source;
}

function normalizePath(value) {
  return path.resolve(String(value)).replace(/[\\/]+/g, "/").toLowerCase();
}

/** settings.json 的 packages 里是否有指向这个仓库的条目。相对路径按 settings 所在目录解析。 */
export function packageEntry(settings, repoRoot, settingsDir) {
  const root = normalizePath(repoRoot);
  return (settings?.packages ?? []).some((entry) => {
    const source = packageSource(entry);
    if (!source) return false;
    if (source.startsWith("npm:")) return false;
    if (source.startsWith("git:") || source.startsWith("http") || source.startsWith("ssh:")) {
      return source.toLowerCase().includes(path.basename(repoRoot).toLowerCase());
    }
    const resolved = path.isAbsolute(source) || /^[a-zA-Z]:[\\/]/.test(source)
      ? source
      : path.resolve(settingsDir ?? process.cwd(), source);
    return normalizePath(resolved) === root;
  });
}

/** 扩展的安装方式：package（pi 包，随仓库实时更新）/ copy（复制到 agent 目录）/ none。 */
export function installedMode(agentDir, repoRoot) {
  const marker = readSourceMarker(agentDir);
  const settingsFile = path.join(agentDir, "settings.json");
  const settings = readJson(settingsFile, {});
  const settingsDir = path.dirname(settingsFile);
  // copy 标记直接可信；package 标记要回查 settings，避免 pi remove 后仍误报
  if (marker?.mode === "copy") return "copy";
  if (marker?.mode === "package" && packageEntry(settings, marker.repoRoot ?? repoRoot, settingsDir)) return "package";
  if (packageEntry(settings, repoRoot, settingsDir)) return "package";
  const copied = fs.existsSync(path.join(agentDir, "extensions", "pmh-auto", "index.js"))
    || fs.existsSync(path.join(agentDir, "extensions", "quick-switch.js"));
  return copied ? "copy" : "none";
}

/** 安装来源仓库是否还在（被移动/删除时给出明确原因，而不是假装“已是最新”）。 */
export function repoAvailable(repoRoot) {
  if (!repoRoot) return false;
  return fs.existsSync(path.join(repoRoot, "extensions", "quick-switch.js"))
    || fs.existsSync(path.join(repoRoot, "extensions", "auto-router", "index.js"));
}

function copyPairs(agentDir, repoRoot, scope) {
  const pairs = AUTO_FILES.map((file) => [
    path.join(repoRoot, "extensions", "auto-router", file),
    path.join(agentDir, "extensions", "pmh-auto", file),
  ]);
  if (scope !== "auto") {
    pairs.unshift([path.join(repoRoot, "extensions", "quick-switch.js"), path.join(agentDir, "extensions", "quick-switch.js")]);
  }
  return pairs;
}

/** 内容与仓库不一致（或目标缺失）的文件，返回相对 agent 目录的路径。 */
export function staleCopies(agentDir, repoRoot, scope) {
  const stale = [];
  for (const [source, dest] of copyPairs(agentDir, repoRoot, scope)) {
    if (!fs.existsSync(source)) continue;
    const same = fs.existsSync(dest)
      && fs.readFileSync(source).equals(fs.readFileSync(dest));
    if (!same) stale.push(path.relative(agentDir, dest));
  }
  return stale;
}

/**
 * 把仓库里的扩展复制到 agent 目录，内容未变不动。
 * 只在 copy 模式调用；package 模式重复复制会造成扩展加载两次。
 * scope=auto 时只同步 /auto 扩展，不碰 quick-switch。
 */
export function syncCopiedExtensions(agentDir, repoRoot, scope) {
  if (!repoAvailable(repoRoot)) throw new Error(`扩展源目录不存在：${repoRoot ?? "（未记录）"}`);
  const changed = [];
  for (const [source, dest] of copyPairs(agentDir, repoRoot, scope)) {
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(dest) && fs.readFileSync(source).equals(fs.readFileSync(dest))) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.copyFileSync(dest, `${dest}.bak-${Date.now()}`);
    fs.copyFileSync(source, dest);
    changed.push(path.relative(agentDir, dest));
  }
  return changed;
}

export { REQUIRED_APIS, AUTO_FILES };
