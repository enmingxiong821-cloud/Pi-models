// 全屏模型切换控制台：只读写 pi 的模型配置，不碰站点与 Key 管理。
import readline from "node:readline";
import {
  allEntries, cmdUse, credentialOf, formatContext, loadAuth, loadModels, loadRegistryState, loadSettings, orderEntries,
} from "./commands.mjs";
import { searchModels } from "./match.mjs";
import { costLevel } from "./model-core.mjs";
import { recentModels, saveRegistry, toggleFavorite } from "./registry.mjs";
import { c, info, warn } from "./util.mjs";

const ESC = "\u001b[";
const ALT_SCREEN = `${ESC}?1049h`;
const LEAVE_ALT_SCREEN = `${ESC}?1049l`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const ANSI_COLOR = /\u001b\[[0-9;]*m/g;

export function entryKey(entry) {
  return `${entry.provider}#${entry.model}`;
}

function charWidth(codePoint) {
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? "").replace(ANSI_COLOR, "")) width += charWidth(ch.codePointAt(0));
  return width;
}

/** 按终端显示宽度截断，中文/emoji 不会被截成半个字符。 */
export function fitDisplay(text, width) {
  const limit = Math.max(0, Number(width) || 0);
  const plain = String(text ?? "").replace(ANSI_COLOR, "");
  let out = "";
  let used = 0;
  for (const ch of plain) {
    const w = charWidth(ch.codePointAt(0));
    if (used + w > limit) {
      if (limit <= 0) return "";
      while (out && used > limit - 1) {
        const chars = [...out];
        const last = chars.pop() ?? "";
        out = chars.join("");
        used -= charWidth(last.codePointAt(0));
      }
      return `${out}…`;
    }
    out += ch;
    used += w;
  }
  return out;
}

function padDisplay(text, width, color = null) {
  const plain = fitDisplay(text, width);
  const padded = `${plain}${" ".repeat(Math.max(0, width - displayWidth(plain)))}`;
  return color ? color(padded) : padded;
}

export function scopeOptions(registry) {
  const groups = Object.keys(registry?.groups ?? {}).sort((a, b) => a.localeCompare(b));
  return [
    { id: "all", label: "全部" },
    { id: "fav", label: "收藏" },
    { id: "recent", label: "最近" },
    ...groups.map((id) => ({ id: `group:${id}`, label: `@${id}` })),
  ];
}

export function loadConsoleState(ctx) {
  const models = loadModels(ctx);
  const auth = loadAuth(ctx);
  const settings = loadSettings(ctx);
  const { registry } = loadRegistryState(ctx, { models, auth });
  const credentials = new Map();
  for (const id of Object.keys(models.providers)) {
    credentials.set(id, credentialOf(ctx, id, { models, auth }).kind);
  }

  const recentRank = new Map();
  for (const relay of Object.values(registry.relays ?? {})) {
    (relay.mru ?? []).forEach((row, index) => recentRank.set(`${relay.id}#${row.model}`, index));
  }
  const globalThinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(settings.defaultThinkingLevel)
    ? settings.defaultThinkingLevel
    : null;
  const thinkingLevels = settings.modelThinkingLevels && typeof settings.modelThinkingLevels === "object"
    ? settings.modelThinkingLevels
    : {};

  const entries = allEntries(ctx, { models, auth })
    .filter((entry) => entry.model)
    .map((entry) => {
      const provider = models.providers[entry.provider];
      const definition = (provider?.models ?? []).find((m) => m.id === entry.model);
      const relay = registry.relays[entry.provider];
      const key = `${entry.provider}#${entry.model}`;
      const definitionCost = definition?.cost ?? provider?.modelOverrides?.[entry.model]?.cost ?? null;
      const pinnedThinking = thinkingLevels[`${entry.provider}/${entry.model}`];
      return {
        provider: entry.provider,
        model: entry.model,
        name: definition?.name ?? entry.name ?? entry.model,
        contextWindow: definition?.contextWindow ?? entry.contextWindow ?? null,
        maxTokens: definition?.maxTokens ?? null,
        reasoning: Boolean(definition?.reasoning ?? entry.reasoning),
        input: Array.isArray(definition?.input) ? definition.input : [],
        api: definition?.api ?? provider?.api ?? null,
        cost: definitionCost,
        costTier: costLevel(definitionCost),
        thinking: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(pinnedThinking)
          ? pinnedThinking
          : globalThinking,
        thinkingSource: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(pinnedThinking)
          ? "model"
          : globalThinking ? "global" : "default",
        group: relay?.group ?? null,
        favorite: (relay?.favorites ?? []).includes(entry.model),
        recentRank: recentRank.has(key) ? recentRank.get(key) : null,
        lastModel: relay?.lastModel ?? null,
        keyAlias: relay?.activeKey ?? null,
        credential: credentials.get(entry.provider) ?? "无",
      };
    });

  const currentKey =
    settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}#${settings.defaultModel}`
      : null;

  return { ctx, settings, registry, entries, scopes: scopeOptions(registry), currentKey };
}

function scopeEntries(state, scopeId) {
  if (scopeId === "fav") return state.entries.filter((entry) => entry.favorite);
  if (scopeId === "recent") {
    const byKey = new Map(state.entries.map((entry) => [entryKey(entry), entry]));
    const seen = new Set();
    const rows = [];
    for (const row of recentModels(state.registry, { limit: 200 })) {
      const key = `${row.provider}#${row.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = byKey.get(key);
      if (entry) rows.push(entry);
    }
    return rows;
  }
  if (scopeId.startsWith("group:")) {
    const group = scopeId.slice("group:".length);
    return state.entries.filter((entry) => entry.group === group);
  }
  return state.entries;
}

/** 范围过滤 + 关键词搜索；空查询保持“收藏 > 最近 > 字母序”。 */
export function filterEntries(state, scopeId, query) {
  const scoped = scopeEntries(state, scopeId);
  const text = String(query ?? "").trim();
  if (text) return searchModels(scoped, text);
  if (scopeId === "recent") return scoped;
  return orderEntries(state.ctx, scoped, { registry: state.registry });
}

export function moveCursor(length, cursor, delta) {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, cursor + delta));
}

export function windowFor(list, cursor, rows) {
  const length = list.length;
  const height = Math.max(1, Number(rows) || 1);
  if (length <= height) return { start: 0, end: length, moreAbove: 0, moreBelow: 0 };
  let start = Math.max(0, cursor - Math.floor(height / 2));
  start = Math.min(start, length - height);
  return { start, end: start + height, moreAbove: start, moreBelow: length - (start + height) };
}

/** 详情只展示凭据类型，不读取、不渲染 Key 值。 */
export function formatDetail(entry) {
  if (!entry) return ["详情  没有匹配的模型"];
  const meta = [];
  if (entry.contextWindow) meta.push(`上下文 ${formatContext(entry.contextWindow)}`);
  if (entry.maxTokens) meta.push(`输出 ${formatContext(entry.maxTokens)}`);
  if (entry.reasoning) meta.push("思考");
  if (entry.thinking) meta.push(`等级 ${entry.thinking}${entry.thinkingSource === "model" ? "（模型）" : ""}`);
  if (entry.costTier) meta.push(`成本 ${entry.costTier.label}`);
  if (Array.isArray(entry.input) && entry.input.includes("image")) meta.push("图片");
  const credential = `凭据 ${entry.credential ?? "无"}${entry.keyAlias ? ` · Key ${entry.keyAlias}` : ""}`;
  const group = entry.group ? ` · 分组 @${entry.group}` : "";
  const recent = entry.recentRank == null ? "无使用记录" : `最近使用 #${entry.recentRank + 1}`;
  return [
    `详情  ${entry.provider}/${entry.model}${entry.name && entry.name !== entry.model ? ` · ${entry.name}` : ""}`,
    meta.length ? meta.join(" · ") : "元数据未配置",
    `API ${entry.api ?? "?"} · ${credential}${group}`,
    `${recent}${entry.lastModel ? ` · 上次 ${entry.lastModel}` : ""}`,
  ];
}

export function keyToAction(str, key = {}, mode = "browse") {
  if (key.ctrl && key.name === "c") return { type: "quit" };
  if (key.name === "tab") return { type: "scope", delta: key.shift ? -1 : 1 };

  if (mode === "search") {
    if (key.name === "escape") return { type: "clear" };
    if (key.name === "return" || key.name === "enter") return { type: "switch" };
    if (key.name === "backspace" || key.name === "delete") return { type: "backspace" };
    if (key.name === "up") return { type: "move", delta: -1 };
    if (key.name === "down") return { type: "move", delta: 1 };
    if (key.name === "pageup") return { type: "move", delta: -10 };
    if (key.name === "pagedown") return { type: "move", delta: 10 };
    if (key.name === "home") return { type: "moveTo", to: 0 };
    if (key.name === "end") return { type: "moveTo", to: -1 };
    if (str && !key.ctrl && !key.meta && str >= " " && str !== "\u007f") return { type: "input", text: str };
    return { type: "none" };
  }

  if (key.name === "escape" || str === "q") return { type: "quit" };
  if (key.name === "return" || key.name === "enter") return { type: "switch" };
  if (key.name === "up") return { type: "move", delta: -1 };
  if (key.name === "down") return { type: "move", delta: 1 };
  if (key.name === "pageup") return { type: "move", delta: -10 };
  if (key.name === "pagedown") return { type: "move", delta: 10 };
  if (key.name === "home") return { type: "moveTo", to: 0 };
  if (key.name === "end") return { type: "moveTo", to: -1 };
  if (str === "/") return { type: "search" };
  if (str === "f") return { type: "favorite" };
  if (str === "r") return { type: "reload" };
  return { type: "none" };
}

export function renderConsole(view, { columns = 80, rows = 24 } = {}) {
  const width = Math.max(20, Number(columns) || 80);
  const height = Math.max(6, Number(rows) || 24);
  const currentKey = view.currentKey ?? null;
  const scopes = view.scopes ?? [];
  const entries = view.entries ?? [];
  const cursor = Math.max(0, Math.min(Number(view.cursor) || 0, Math.max(0, entries.length - 1)));
  const showDetail = height >= 16 && width >= 60;
  const detail = showDetail ? formatDetail(entries[cursor]) : [];
  const reserved = 3 + (showDetail ? detail.length + 2 : 0);
  const listRows = Math.max(1, height - reserved);
  const lines = [];

  const current = currentKey ? `默认 ${currentKey}` : "默认未设置";
  const selectedScope = scopes.find((scope) => scope.id === view.scopeId);
  const scopeText = width < 70
    ? `范围 [${selectedScope?.label ?? "全部"}]`
    : scopes.map((scope) => (scope.id === view.scopeId ? `[${scope.label}]` : scope.label)).join(" ");
  const position = `${entries.length ? cursor + 1 : 0}/${entries.length}`;
  lines.push(padDisplay(`pmh console  ${current}  ${scopeText}  ${position}`, width, c.bold));

  const search = view.mode === "search"
    ? `搜索: ${view.query}▏`
    : view.query
      ? `搜索: ${view.query}  Esc 清除`
      : "按 / 搜索";
  lines.push(padDisplay(search, width, c.dim));

  const { start, end } = windowFor(entries, cursor, listRows);
  if (!entries.length) {
    const empty = view.query ? `没有匹配 "${view.query}" 的模型` : "没有可切换的模型";
    lines.push(padDisplay(empty, width, c.yellow));
    while (lines.length < 2 + listRows) lines.push("");
  } else {
    for (let index = start; index < end; index += 1) {
      const entry = entries[index];
      const selected = index === cursor;
      const isCurrent = currentKey === entryKey(entry);
      const meta = [];
      const context = formatContext(entry.contextWindow);
      if (context) meta.push(context);
      if (entry.reasoning) meta.push("思考");
      if (Array.isArray(entry.input) && entry.input.includes("image")) meta.push("图片");
      if (entry.group) meta.push(`@${entry.group}`);
      if (entry.favorite) meta.push("★");
      if (isCurrent) meta.push("当前");
      let text = `${entry.provider}/${entry.model}`;
      if (entry.name && entry.name !== entry.model) text += `  ${entry.name}`;
      if (meta.length) text += `  · ${meta.join("/")}`;
      const line = `${selected ? "▸ " : "  "}${isCurrent ? "● " : "  "}${fitDisplay(text, width - 4)}`;
      lines.push(padDisplay(line, width, selected ? c.blue : null));
    }
    while (lines.length < 2 + listRows) lines.push("");
  }

  if (showDetail) {
    lines.push(c.dim("─".repeat(width)));
    for (const line of detail) lines.push(padDisplay(line, width, c.dim));
    lines.push(c.dim("─".repeat(width)));
  }

  let footer;
  let footerColor = c.dim;
  if (view.busy) footer = "写入中…";
  else if (view.notice) {
    footer = `${view.notice.kind === "error" ? "✖" : "✔"} ${view.notice.text}`;
    footerColor = view.notice.kind === "error" ? c.red : c.green;
  } else if (view.mode === "search") {
    footer = width >= 70
      ? "输入过滤  Backspace 删除  Enter 切换  ↑↓ 移动  Esc 返回  Ctrl+C 退出"
      : "输入过滤  Enter 切换  Esc 返回  Ctrl+C 退出";
  } else {
    footer = width >= 70
      ? "↑↓ 移动  Enter 切换  f 收藏  / 搜索  Tab 范围  r 刷新  q 退出"
      : "↑↓ 移动  Enter 切换  f 收藏  / 搜索  q 退出";
  }
  lines.push(padDisplay(footer, width, footerColor));

  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}

export function canRunConsole({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  if (env?.PMH_NONINTERACTIVE === "1" || env?.PMH_NONINTERACTIVE === "true") return false;
  if (!stdin?.isTTY || !stdout?.isTTY) return false;
  if (typeof stdin.setRawMode !== "function") return false;
  if (String(env?.TERM ?? "").toLowerCase() === "dumb") return false;
  return true;
}

export async function runConsole(ctx, { input = process.stdin, output = process.stdout, env = process.env } = {}) {
  if (!canRunConsole({ stdin: input, stdout: output, env })) {
    warn("控制台需要交互式终端（当前不是 TTY）。");
    info("在终端里运行 pmh console；脚本里请用 pmh pick 或 pmh use <provider#model>。");
    return 1;
  }

  let state = loadConsoleState(ctx);
  let scopes = state.scopes;
  let scopeIndex = Math.max(0, scopes.findIndex((scope) => scope.id === "all"));
  let query = "";
  let mode = "browse";
  let cursor = 0;
  let selectedKey = state.currentKey;
  let notice = null;
  let busy = false;
  let cleaned = false;

  const list = () => filterEntries(state, scopes[scopeIndex]?.id ?? "all", query);

  const syncSelection = () => {
    const entries = list();
    cursor = Math.max(0, Math.min(cursor, Math.max(0, entries.length - 1)));
    selectedKey = entries[cursor] ? entryKey(entries[cursor]) : null;
  };

  const selectCurrent = () => {
    const entries = list();
    const index = selectedKey ? entries.findIndex((entry) => entryKey(entry) === selectedKey) : -1;
    cursor = index >= 0 ? index : 0;
    syncSelection();
  };

  const reload = () => {
    const keepKey = selectedKey;
    const keepScope = scopes[scopeIndex]?.id ?? "all";
    state = loadConsoleState(ctx);
    scopes = state.scopes;
    const nextScope = scopes.findIndex((scope) => scope.id === keepScope);
    scopeIndex = nextScope >= 0 ? nextScope : 0;
    const entries = list();
    const index = keepKey ? entries.findIndex((entry) => entryKey(entry) === keepKey) : -1;
    cursor = index >= 0 ? index : 0;
    syncSelection();
  };

  const render = () => {
    if (cleaned) return;
    const frame = renderConsole(
      {
        currentKey: state.currentKey,
        scopes,
        scopeId: scopes[scopeIndex]?.id ?? "all",
        query,
        mode,
        entries: list(),
        cursor,
        notice,
        busy,
      },
      { columns: output.columns || 80, rows: output.rows || 24 },
    );
    const body = frame
      .split("\n")
      .map((line) => `\r${ESC}2K${line}`)
      .join("\n");
    output.write(`${ESC}H${body}`);
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      input.setRawMode(false);
    } catch {
      /* 终端已经不可写时忽略 */
    }
    try {
      input.pause();
    } catch {
      /* 同上 */
    }
    input.removeListener("keypress", onKey);
    output.removeListener("resize", onResize);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    try {
      output.write(`${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
    } catch {
      /* 退出阶段不再抛出 */
    }
  };

  function onSignal() {
    cleanup();
    process.exit(130);
  }

  function onResize() {
    render();
  }

  const doSwitch = async () => {
    const entry = list()[cursor];
    if (!entry) {
      notice = { kind: "error", text: "没有可切换的模型" };
      render();
      return;
    }
    busy = true;
    notice = null;
    render();
    try {
      const result = await cmdUse(ctx, `${entry.provider}#${entry.model}`, { quiet: true });
      if (!result) throw new Error("切换未完成");
      selectedKey = entryKey(entry);
      reload();
      notice = { kind: "ok", text: `已切换为 ${entry.provider}/${entry.model}（下次启动生效）` };
    } catch (err) {
      notice = { kind: "error", text: err.message };
    } finally {
      busy = false;
      render();
    }
  };

  const doFavorite = async () => {
    const entry = list()[cursor];
    if (!entry) {
      notice = { kind: "error", text: "没有可收藏的模型" };
      render();
      return;
    }
    busy = true;
    notice = null;
    render();
    try {
      const { registry } = loadRegistryState(ctx);
      const added = toggleFavorite(registry, entry.provider, entry.model);
      saveRegistry(ctx, registry);
      selectedKey = entryKey(entry);
      reload();
      notice = { kind: "ok", text: `${added ? "已收藏" : "已取消收藏"} ${entry.provider}/${entry.model}` };
    } catch (err) {
      notice = { kind: "error", text: err.message };
    } finally {
      busy = false;
      render();
    }
  };

  const doReload = async () => {
    busy = true;
    notice = null;
    render();
    try {
      reload();
      notice = { kind: "ok", text: "已重新读取配置" };
    } catch (err) {
      notice = { kind: "error", text: err.message };
    } finally {
      busy = false;
      render();
    }
  };

  async function onKey(str, key = {}) {
    try {
      await handleKey(str, key);
    } catch (err) {
      busy = false;
      notice = { kind: "error", text: err?.message ?? String(err) };
      if (!cleaned) {
        try {
          render();
        } catch {
          cleanup();
        }
      }
    }
  }

  async function handleKey(str, key = {}) {
    const action = keyToAction(str, key, mode);
    if (action.type === "quit") {
      cleanup();
      resolve(0);
      return;
    }
    if (busy && action.type !== "none") return;
    if (action.type !== "none") notice = null;

    switch (action.type) {
      case "move":
        cursor = moveCursor(list().length, cursor, action.delta);
        syncSelection();
        break;
      case "moveTo": {
        const length = list().length;
        cursor = action.to === -1 ? Math.max(0, length - 1) : Math.max(0, Math.min(action.to, length - 1));
        syncSelection();
        break;
      }
      case "input":
        mode = "search";
        query += action.text;
        cursor = 0;
        syncSelection();
        break;
      case "backspace":
        query = query.slice(0, -1);
        cursor = 0;
        syncSelection();
        break;
      case "clear":
        query = "";
        mode = "browse";
        cursor = 0;
        syncSelection();
        break;
      case "search":
        mode = "search";
        break;
      case "scope":
        scopeIndex = (scopeIndex + action.delta + scopes.length) % scopes.length;
        query = "";
        cursor = 0;
        syncSelection();
        break;
      case "switch":
        await doSwitch();
        return;
      case "favorite":
        await doFavorite();
        return;
      case "reload":
        await doReload();
        return;
      default:
        break;
    }
    render();
  }

  let resolve;
  const finished = new Promise((done) => {
    resolve = done;
  });

  try {
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
  } catch {
    warn("这个终端不支持全屏控制台。");
    info("用 pmh pick 或 pmh use <provider#model> 切换。");
    return 1;
  }

  try {
    output.write(`${ALT_SCREEN}${HIDE_CURSOR}${ESC}H${ESC}2J`);
    selectCurrent();
    render();
    input.on("keypress", onKey);
    output.on("resize", onResize);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
  } catch (err) {
    cleanup();
    throw err;
  }

  return finished;
}

export async function cmdConsole(ctx) {
  await runConsole(ctx);
}
