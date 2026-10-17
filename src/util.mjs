import fs from "node:fs";
import path from "node:path";

export const isTTY = Boolean(process.stdout.isTTY);
const useColor = isTTY && !process.env.NO_COLOR;

const wrap = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("36"),
};

let jsonMode = false;

/** --json 时把诊断信息改走 stderr，避免污染标准输出上的 JSON。 */
export function setJsonMode(enabled) {
  jsonMode = Boolean(enabled);
}

export function log(...args) {
  console.log(...args);
}

function diag(...args) {
  (jsonMode ? console.error : console.log)(...args);
}

export function ok(msg) {
  diag(`${c.green("✔")} ${msg}`);
}

export function warn(msg) {
  diag(`${c.yellow("!")} ${msg}`);
}

export function fail(msg) {
  diag(`${c.red("✖")} ${msg}`);
}

export function info(msg) {
  diag(`${c.blue("›")} ${msg}`);
}

export function heading(msg) {
  diag(`\n${c.bold(msg)}`);
}

export function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`无法解析 ${file}: ${err.message}`);
  }
}

/** 原子写 JSON，并在覆盖前留一份带时间戳的备份（可回滚）。 */
export function writeJson(file, value, { backup = true, mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backupPath = null;
  if (backup && fs.existsSync(file)) {
    const base = `${file}.bak-${timestamp()}`;
    backupPath = base;
    // 同一秒内多次写入时，不要覆盖上一份备份
    for (let n = 2; fs.existsSync(backupPath); n += 1) backupPath = `${base}-${n}`;
    fs.copyFileSync(file, backupPath);
  }
  // 没显式指定时沿用原文件权限（Windows 上 chmod 只影响只读位，无害）
  let effectiveMode = mode;
  if (effectiveMode === undefined) {
    try {
      effectiveMode = fs.statSync(file).mode & 0o777;
    } catch {
      /* 新文件按系统默认 */
    }
  }
  const tmp = `${file}.tmp-${process.pid}`;
  const writeOptions = { encoding: "utf8" };
  if (effectiveMode !== undefined) writeOptions.mode = effectiveMode;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, writeOptions);
  if (effectiveMode !== undefined) fs.chmodSync(tmp, effectiveMode);
  fs.renameSync(tmp, file);
  return backupPath;
}

export function fileExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function listDir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/** 把 "https://a.b/v1/" 归一化为 "https://a.b"（去掉尾部斜杠、/v1 和完整端点路径）。 */
export function rootOf(baseUrl) {
  return String(baseUrl)
    .trim()
    .replace(/\/+$/, "")
    // 用户直接粘完整端点时（/v1/chat/completions 等），先退回到站点根
    .replace(/\/(?:v1\/)?(?:chat\/completions|completions|responses|messages|embeddings|models)\/?$/i, "")
    .replace(/\/v1$/i, "")
    .replace(/\/+$/, "");
}

export function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) => cells.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");
  const out = [c.bold(line(headers)), c.dim(widths.map((w) => "-".repeat(w)).join("  "))];
  for (const r of rows) out.push(line(r));
  return out.join("\n");
}

export function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
