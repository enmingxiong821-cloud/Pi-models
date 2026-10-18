// 会话用量聚合：只读扫描 agent/sessions 下的 JSONL，不修改任何文件。
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { readJson } from "./util.mjs";
import { computeCost, lookupPrice } from "./pricing/loader.mjs";

const MAX_DEPTH = 4;
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MS = 8000;
const CACHE_LIMIT = 5000;

export const GROUP_BY = ["day", "provider", "model", "project"];
export const BRANCHES = ["all", "active"];

const fileCache = new Map();

export function resetUsageCache() {
  fileCache.clear();
}

function pad(number) {
  return String(number).padStart(2, "0");
}

/** 本地时区的 YYYY-MM-DD。 */
export function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfLocalDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** since: today | Nd | YYYY-MM-DD | all；默认 7d。 */
export function resolveRange(since, now = new Date()) {
  const value = since === undefined || since === null || since === "" ? "7d" : String(since);
  if (value === "all") return { from: null, to: now, since: "all" };
  if (value === "today") return { from: startOfLocalDay(now), to: now, since: "today" };
  const days = /^(\d{1,3})d$/.exec(value);
  if (days) {
    const count = Number(days[1]);
    if (count < 1 || count > 365) throw new Error("时间范围需要在 1–365 天之间");
    const from = startOfLocalDay(now);
    from.setDate(from.getDate() - (count - 1));
    return { from, to: now, since: value };
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date) {
    const from = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    if (
      from.getFullYear() !== Number(date[1])
      || from.getMonth() !== Number(date[2]) - 1
      || from.getDate() !== Number(date[3])
    ) {
      throw new Error(`日期无效：${value}`);
    }
    from.setHours(0, 0, 0, 0);
    return { from, to: now, since: value };
  }
  throw new Error(`时间范围无效：${value}（可用 today / 7d / 30d / YYYY-MM-DD / all）`);
}

function collectFiles(dir) {
  const files = [];
  let skipped = 0;
  const walk = (current, depth) => {
    if (depth > MAX_DEPTH) {
      skipped += 1;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        skipped += 1;
      } else if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  };
  walk(dir, 0);
  return { files, skipped };
}

function tokenNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function readTokens(usage) {
  const input = tokenNumber(usage.input);
  const output = tokenNumber(usage.output);
  const cacheRead = tokenNumber(usage.cacheRead ?? usage.cache_read);
  const cacheWrite = tokenNumber(usage.cacheWrite ?? usage.cache_write);
  const reasoning = tokenNumber(usage.reasoning ?? usage.reasoningTokens);
  const total = tokenNumber(usage.totalTokens ?? usage.total_tokens) || input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, reasoning, totalTokens: total };
}

function reportedCost(usage) {
  const cost = usage?.cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return null;
  const total = Number(cost.total);
  if (Number.isFinite(total)) return total;
  const fields = ["input", "output", "cacheRead", "cacheWrite"]
    .map((key) => Number(cost[key]))
    .filter(Number.isFinite);
  return fields.length ? fields.reduce((sum, value) => sum + value, 0) : null;
}

function readModelCosts(ctx) {
  const config = readJson(ctx.paths.models, { providers: {} }) ?? {};
  const base = new Map();
  const byKey = new Map();
  const byModel = new Map();
  for (const [provider, entry] of Object.entries(config.providers ?? {})) {
    for (const model of entry?.models ?? []) {
      if (model?.id && model.cost) base.set(`${provider}#${model.id}`, model.cost);
    }
    for (const [id, override] of Object.entries(entry?.modelOverrides ?? {})) {
      if (!override?.cost) continue;
      const key = `${provider}#${id}`;
      base.set(key, { ...(base.get(key) ?? {}), ...override.cost });
    }
  }
  for (const [key, cost] of base) {
    byKey.set(key, cost);
    const model = key.slice(key.indexOf("#") + 1);
    if (!byModel.has(model)) byModel.set(model, cost);
  }
  return { byKey, byModel };
}

function costFor(record, indexes) {
  if (record.reportedCost !== null) return { cost: record.reportedCost, source: "reported" };
  const config = indexes.byKey.get(`${record.provider}#${record.model}`) ?? indexes.byModel.get(record.model);
  if (config) {
    const price = {
      input: tokenNumber(config.input),
      output: tokenNumber(config.output),
      cacheRead: tokenNumber(config.cacheRead),
      cacheWrite: tokenNumber(config.cacheWrite),
    };
    return { cost: computeCost(record.tokens, price), source: "models" };
  }
  const snapshot = lookupPrice(record.provider, record.model);
  if (snapshot) return { cost: computeCost(record.tokens, snapshot), source: "snapshot" };
  return { cost: 0, source: "missing" };
}

function recordFrom(entry, usage, context) {
  const message = entry.message && typeof entry.message === "object" ? entry.message : null;
  const provider = message?.provider ?? entry.provider ?? context.provider ?? null;
  const model = message?.model ?? entry.model ?? context.model ?? null;
  const timestamp = entry.timestamp ?? message?.timestamp ?? null;
  const tokens = readTokens(usage);
  return {
    id: typeof entry.id === "string" ? entry.id : null,
    timestamp,
    provider: provider ? String(provider) : "",
    model: model ? String(model) : "",
    tokens,
    reportedCost: reportedCost(usage),
  };
}

async function readSessionFile(file, stat) {
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.parsed;

  const records = [];
  const parents = new Map();
  let lastId = null;
  let header = null;
  let lastProvider = null;
  let lastModel = null;
  let errors = 0;
  let lineNo = 0;

  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      lineNo += 1;
      const line = raw.trim();
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        errors += 1;
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors += 1;
        continue;
      }
      if (entry.type === "session" && !header) {
        header = {
          id: typeof entry.id === "string" ? entry.id : null,
          cwd: typeof entry.cwd === "string" ? entry.cwd : null,
          version: Number(entry.version) || null,
        };
      }
      if (typeof entry.id === "string") {
        parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
        lastId = entry.id;
      }
      const message = entry.message && typeof entry.message === "object" ? entry.message : null;
      if (message?.provider) lastProvider = String(message.provider);
      if (message?.model) lastModel = String(message.model);
      if (entry.provider) lastProvider = String(entry.provider);
      if (entry.model) lastModel = String(entry.model);

      if (entry.type === "message" && message?.usage && (message.role === "assistant" || message.role === "toolResult")) {
        records.push(recordFrom(entry, message.usage, { provider: lastProvider, model: lastModel }));
      } else if (entry.usage && (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary")) {
        records.push(recordFrom(entry, entry.usage, { provider: lastProvider, model: lastModel }));
      } else if (entry.compaction?.usage) {
        records.push(recordFrom(entry, entry.compaction.usage, { provider: lastProvider, model: lastModel }));
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  let activeIds = null;
  if (lastId) {
    activeIds = new Set();
    let cursor = lastId;
    const guard = new Set();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      activeIds.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }

  const sessionId = header?.id ?? path.basename(file, ".jsonl");
  const cwd = header?.cwd ?? null;
  const parsed = {
    file,
    sessionId,
    cwd,
    project: cwd ? baseName(cwd) || cwd : null,
    version: header?.version ?? null,
    records,
    activeIds,
    bytes: stat.size,
    errors,
    lineNo,
  };
  fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  if (fileCache.size > CACHE_LIMIT) {
    fileCache.delete(fileCache.keys().next().value);
  }
  return parsed;
}

function baseName(value) {
  const text = String(value).replace(/[\\/]+$/, "");
  const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return index >= 0 ? text.slice(index + 1) : text;
}

function normalizeProjectPath(value) {
  return String(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function projectMatches(parsed, filter) {
  if (!filter) return true;
  const wanted = String(filter).trim();
  if (!wanted) return true;
  if (parsed.project && parsed.project.toLowerCase() === wanted.toLowerCase()) return true;
  if (!parsed.cwd) return false;
  if (normalizeProjectPath(parsed.cwd) === normalizeProjectPath(wanted)) return true;
  try {
    return normalizeProjectPath(path.resolve(parsed.cwd)) === normalizeProjectPath(path.resolve(wanted));
  } catch {
    return false;
  }
}

function emptyGroup(key, label) {
  return {
    key,
    label,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    tokens: 0,
    cost: 0,
    records: 0,
  };
}

function addToGroup(group, tokens, cost) {
  group.input += tokens.input;
  group.output += tokens.output;
  group.cacheRead += tokens.cacheRead;
  group.cacheWrite += tokens.cacheWrite;
  group.reasoning += tokens.reasoning;
  group.tokens += tokens.totalTokens;
  group.cost += cost;
  group.records += 1;
}

const round = (value) => Math.round(value * 1e6) / 1e6;

export async function collectUsage(ctx, options = {}) {
  const {
    since = "7d",
    groupBy = "day",
    branch = "all",
    project = null,
    now = new Date(),
    limits = {},
  } = options;
  if (!GROUP_BY.includes(groupBy)) throw new Error(`分组方式无效：${groupBy}`);
  if (!BRANCHES.includes(branch)) throw new Error(`分支策略无效：${branch}`);
  const range = resolveRange(since, now);
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const maxBytes = limits.maxBytes ?? MAX_TOTAL_BYTES;
  const maxMs = limits.maxMs ?? MAX_MS;
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES;

  const indexes = readModelCosts(ctx);
  const scan = { sessions: 0, files: 0, bytes: 0, skipped: 0, truncated: false, errors: 0, branch };
  const totals = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    totalTokens: 0, cost: 0, unknownCostTokens: 0,
  };
  const groups = new Map();
  const missing = new Map();
  const seen = new Set();
  const sessionIds = new Set();
  const started = Date.now();

  const { files, skipped } = collectFiles(ctx.paths.sessions);
  scan.skipped += skipped;

  for (const file of files) {
    if (scan.files >= maxFiles || Date.now() - started > maxMs) {
      scan.truncated = true;
      break;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      scan.errors += 1;
      continue;
    }
    if (stat.size > maxFileBytes) {
      scan.skipped += 1;
      continue;
    }
    if (scan.bytes + stat.size > maxBytes) {
      scan.truncated = true;
      break;
    }
    let parsed;
    try {
      parsed = await readSessionFile(file, stat);
    } catch {
      scan.errors += 1;
      continue;
    }
    scan.files += 1;
    scan.bytes += parsed.bytes;
    scan.errors += parsed.errors;
    sessionIds.add(parsed.sessionId);
    if (!projectMatches(parsed, project)) {
      await new Promise((resolve) => setImmediate(resolve));
      continue;
    }

    for (const record of parsed.records) {
      if (branch === "active" && record.id && parsed.activeIds && !parsed.activeIds.has(record.id)) continue;
      let time;
      if (record.timestamp) {
        time = Date.parse(record.timestamp);
        if (Number.isNaN(time)) time = stat.mtimeMs;
      } else {
        time = stat.mtimeMs;
      }
      if (range.from && time < range.from.getTime()) continue;
      if (record.id) {
        const key = `${parsed.sessionId}\u0000${record.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }

      const cost = costFor(record, indexes);
      totals.input += record.tokens.input;
      totals.output += record.tokens.output;
      totals.cacheRead += record.tokens.cacheRead;
      totals.cacheWrite += record.tokens.cacheWrite;
      totals.reasoning += record.tokens.reasoning;
      totals.totalTokens += record.tokens.totalTokens;
      totals.cost += cost.cost;
      if (cost.source === "missing") {
        totals.unknownCostTokens += record.tokens.totalTokens;
        const key = record.provider && record.model ? `${record.provider}#${record.model}` : "未知模型";
        const row = missing.get(key) ?? { key, tokens: 0, records: 0 };
        row.tokens += record.tokens.totalTokens;
        row.records += 1;
        missing.set(key, row);
      }

      let key;
      let label;
      if (groupBy === "day") {
        key = localDateKey(time) ?? "unknown";
        label = key;
      } else if (groupBy === "provider") {
        key = record.provider || "unknown";
        label = record.provider || "(未知站点)";
      } else if (groupBy === "model") {
        key = record.provider && record.model ? `${record.provider}#${record.model}` : record.model || "unknown";
        label = key === "unknown" ? "(未知模型)" : key;
      } else {
        key = parsed.project || "unknown";
        label = parsed.project || "(未知项目)";
      }
      const group = groups.get(key) ?? emptyGroup(key, label);
      addToGroup(group, record.tokens, cost.cost);
      groups.set(key, group);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  scan.sessions = sessionIds.size;
  const ordered = [...groups.values()];
  if (groupBy === "day") ordered.sort((a, b) => a.key.localeCompare(b.key));
  else ordered.sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
  for (const group of ordered) group.cost = round(group.cost);

  totals.cost = round(totals.cost);
  return {
    version: 1,
    generatedAt: now.toISOString(),
    range: {
      from: range.from ? localDateKey(range.from) : null,
      to: localDateKey(now),
      since: range.since,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    totals,
    groups: ordered,
    missingPrice: [...missing.values()].sort((a, b) => b.tokens - a.tokens),
    scan,
  };
}
