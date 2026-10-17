import fs from "node:fs";
import path from "node:path";

export const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code) => (s) => (isTTY ? `\u001b[${code}m${s}\u001b[0m` : String(s));

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("36"),
};

export function log(...args) {
  console.log(...args);
}

export function ok(msg) {
  log(`${c.green("✔")} ${msg}`);
}

export function warn(msg) {
  log(`${c.yellow("!")} ${msg}`);
}

export function fail(msg) {
  log(`${c.red("✖")} ${msg}`);
}

export function info(msg) {
  log(`${c.blue("›")} ${msg}`);
}

export function heading(msg) {
  log(`\n${c.bold(msg)}`);
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
export function writeJson(file, value, { backup = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backupPath = null;
  if (backup && fs.existsSync(file)) {
    backupPath = `${file}.bak-${timestamp()}`;
    fs.copyFileSync(file, backupPath);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

/** 把 "https://a.b/v1/" 归一化为 "https://a.b"（去掉尾部斜杠与 /v1）。 */
export function rootOf(baseUrl) {
  return String(baseUrl)
    .trim()
    .replace(/\/+$/, "")
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
