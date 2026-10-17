/**
 * pi 快速切换扩展：把中转站模型排在最前面，一条斜杠命令或一个快捷键就能换模型。
 *
 * 加载方式（任选）：
 *   1) 放到 ~/.pi/agent/extensions/quick-switch.js（pi 自动发现）
 *   2) 临时试用：pi --extension <此文件路径>
 *   3) 作为 pi 包安装：pi install git:github.com/<你的用户名>/pi-model-hub
 *
 * 用法：
 *   /switch                    选择器：收藏 → 最近 → 中转站 → 当前 → 其他
 *   /switch sonnet             关键词直接切（唯一命中时一步到位）
 *   /switch @code [关键词]      只在分组 code 里选
 *   /switch @fav               只看收藏
 *   /switch recent             只看最近用过的
 *   /switch relay <id>         直接切到该站上次用的模型
 *   /switch-save               选一个并同时设为新会话默认
 *   /switch-fav                收藏/取消收藏当前模型
 *   /switch-widget [on|off]    开关站点 widget（默认 auto：≥2 个站才显示）
 *   Ctrl+Shift+M               快捷键，等同 /switch
 *
 * 过滤语法：@组 / @fav / fav: / recent / reasoning（思考）/ image（图片）/
 *           ctx:>=200k / provider: crow5 / 其余词走关键词打分，多个条件取交集。
 *
 * 本文件保持单文件、零依赖，可单独拷进 ~/.pi/agent/extensions/。
 * 只读 models.json 和 auth.json，只写注册表 pmh-relays.json（MRU 不备份）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_OPTIONS = 400;
const MRU_LIMIT = 20;
const STATUS_KEY = "pmh";
const WIDGET_KEY = "pmh";
const WIDGET_MODES = ["auto", "on", "off"];

function agentDir() {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".pi", "agent");
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function registryFile() {
  return path.join(agentDir(), "pmh-relays.json");
}

/** models.json 里登记的 provider —— 也就是我们接的中转站，切换时优先展示。 */
export function relayProviders() {
  const models = readJson(path.join(agentDir(), "models.json"), {});
  return Object.keys(models?.providers ?? {});
}

/**
 * 读取注册表，并补齐 models.json 里有、注册表里还没有的站。
 * 只读，不落盘；写操作走 saveRegistry。
 */
export function readRegistry() {
  const stored = readJson(registryFile(), {}) ?? {};
  const registry = {
    version: stored.version ?? 1,
    groups: stored.groups && typeof stored.groups === "object" ? stored.groups : {},
    relays: stored.relays && typeof stored.relays === "object" ? stored.relays : {},
    settings: { widget: "auto", ...(stored.settings ?? {}) },
  };
  if (!WIDGET_MODES.includes(registry.settings.widget)) registry.settings.widget = "auto";

  for (const id of relayProviders()) {
    if (!Object.hasOwn(registry.relays, id)) {
      // 用 defineProperty，避免 provider 名叫 __proto__ 时改到原型上
      Object.defineProperty(registry.relays, id, {
        value: { id, group: null, favorites: [], mru: [], lastModel: null, activeKey: null },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const relay = registry.relays[id];
    if (!relay || typeof relay !== "object") continue;
    relay.id = id;
    if (!Array.isArray(relay.favorites)) relay.favorites = [];
    if (!Array.isArray(relay.mru)) relay.mru = [];
    if (relay.group === undefined) relay.group = null;
    if (relay.lastModel === undefined) relay.lastModel = null;
    if (relay.activeKey === undefined) relay.activeKey = null;
  }
  return registry;
}

/** 原子写：临时文件 + rename；只有显式操作（收藏/分组/widget）才留时间戳备份。 */
export function saveRegistry(registry, { backup = false } = {}) {
  const file = registryFile();
  registry.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (backup && fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    try {
      fs.copyFileSync(file, `${file}.bak-${stamp}`);
    } catch {
      /* 备份失败不影响主流程 */
    }
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

function modelKey(provider, model) {
  return `${provider}/${model}`;
}

function shortContext(n) {
  if (!n) return "";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

function isFavorite(registry, model) {
  return Boolean(registry?.relays?.[model.provider]?.favorites?.includes(model.id));
}

/** 跨站 MRU，按时间倒序。 */
export function recentList(registry) {
  const rows = [];
  for (const relay of Object.values(registry?.relays ?? {})) {
    for (const entry of relay.mru ?? []) rows.push({ provider: relay.id, model: entry.model, at: entry.at });
  }
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * 选择器里显示的一行文本，同时要能唯一反查到模型。
 * @param {any} model
 * @param {{ current?: boolean, isRelay?: boolean, favorite?: boolean }} [extras]
 */
export function labelOf(model, extras = {}) {
  const flags = [];
  if (model.reasoning) flags.push("思考");
  if ((model.input ?? []).includes("image")) flags.push("图片");
  if (extras.isRelay) flags.push("中转");
  if (extras.favorite) flags.push("★");
  const meta = [shortContext(model.contextWindow), ...flags].filter(Boolean).join("/");
  return `${extras.current ? "● " : ""}${model.provider}/${model.id}${meta ? `  · ${meta}` : ""}`;
}

/**
 * 排序：收藏 → MRU → 中转站 → 当前 provider → 其他，组内按 provider/model 字典序。
 * @param {any[]} models
 * @param {string[]} relays
 * @param {string} [currentProvider]
 * @param {{ registry?: any }} [options]
 */
export function rankModels(models, relays, currentProvider, options = {}) {
  const registry = options.registry ?? null;
  const relayOrder = new Map(relays.map((id, i) => [id, i]));
  const mru = new Map();
  recentList(registry).forEach((row, i) => {
    const key = modelKey(row.provider, row.model);
    if (!mru.has(key)) mru.set(key, i);
  });

  const tier = (m) => {
    if (isFavorite(registry, m)) return 0;
    if (mru.has(modelKey(m.provider, m.id))) return 1;
    if (relayOrder.has(m.provider)) return 2;
    if (m.provider === currentProvider) return 3;
    return 4;
  };

  return [...models].sort((a, b) => {
    const t = tier(a) - tier(b);
    if (t !== 0) return t;
    const ma = mru.get(modelKey(a.provider, a.id));
    const mb = mru.get(modelKey(b.provider, b.id));
    if (ma !== undefined || mb !== undefined) {
      if (ma === undefined) return 1;
      if (mb === undefined) return -1;
      if (ma !== mb) return ma - mb;
    }
    const oa = relayOrder.has(a.provider) ? relayOrder.get(a.provider) : Number.MAX_SAFE_INTEGER;
    const ob = relayOrder.has(b.provider) ? relayOrder.get(b.provider) : Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    const pa = a.provider.localeCompare(b.provider);
    if (pa !== 0) return pa;
    return String(a.id).localeCompare(String(b.id));
  });
}

function score(model, query) {
  const id = String(model.id).toLowerCase();
  const full = `${model.provider}/${model.id}`.toLowerCase();
  const name = String(model.name ?? "").toLowerCase();
  const q = query.toLowerCase();
  if (id === q || full === q) return 1000;
  if (id.endsWith(q)) return 800;
  if (id.includes(q)) return 600 - id.indexOf(q);
  if (full.includes(q)) return 500 - full.indexOf(q);
  if (name.includes(q)) return 400 - name.indexOf(q);
  // 多关键词："crow5 sonnet"、"crow5/sonnet" 都算命中
  const hay = `${full} ${name}`;
  const tokens = q.split(/[\s/_:-]+/).filter(Boolean);
  if (!tokens.length) return 0;
  let hits = 0;
  for (const t of tokens) if (hay.includes(t)) hits += 1;
  return hits === tokens.length ? 200 + hits * 10 : 0;
}

/**
 * 关键词过滤：没有命中时返回空数组（调用方负责提示）。
 * @param {any[]} models
 * @param {string} query
 */
export function filterModels(models, query) {
  const q = String(query ?? "").trim();
  if (!q) return models;
  return models
    .map((m) => ({ m, s: score(m, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
}

function parseContext(raw) {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  return Math.round(n * (unit === "m" ? 1_000_000 : unit === "k" ? 1000 : 1));
}

/**
 * 解析过滤语法。返回结构化条件，未识别词放进 terms。
 */
export function parseQuery(raw) {
  const spec = {
    groups: [], providers: [], terms: [],
    fav: false, recent: false, reasoning: false, image: false,
    minContext: null, relay: null,
  };
  const text = String(raw ?? "").trim();
  if (!text) return spec;
  const tokens = text.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const low = token.toLowerCase();
    if (low === "@fav" || low === "fav" || low === "fav:") { spec.fav = true; continue; }
    if (low.startsWith("@") && low.length > 1) { spec.groups.push(low.slice(1)); continue; }
    if (low === "recent" || low === "recent:") { spec.recent = true; continue; }
    if (low === "reasoning" || token === "思考") { spec.reasoning = true; continue; }
    if (low === "image" || token === "图片") { spec.image = true; continue; }
    if (low.startsWith("ctx:")) {
      const value = low.slice(4).replace(/^>=?/, "");
      const n = parseContext(value);
      if (n != null) { spec.minContext = n; continue; }
    }
    if (low === "relay" && tokens[i + 1] && !tokens[i + 1].startsWith("@")) {
      spec.relay = tokens[++i];
      continue;
    }
    if (low === "relay:" && tokens[i + 1]) { spec.relay = tokens[++i]; continue; }
    if (low.startsWith("relay:") && low.length > 6) { spec.relay = low.slice(6); continue; }
    if (low === "provider" && tokens[i + 1]) { spec.providers.push(tokens[++i].toLowerCase()); continue; }
    if (low === "provider:" && tokens[i + 1]) { spec.providers.push(tokens[++i].toLowerCase()); continue; }
    if (low.startsWith("provider:") && low.length > 9) { spec.providers.push(low.slice(9)); continue; }
    spec.terms.push(token);
  }
  return spec;
}

/** 结构化条件（分组/收藏/最近/能力/上下文/站点）取交集。 */
export function matchesQuery(model, spec, registry) {
  if (spec.fav && !isFavorite(registry, model)) return false;
  if (spec.reasoning && !model.reasoning) return false;
  if (spec.image && !(model.input ?? []).includes("image")) return false;
  if (spec.minContext != null && (model.contextWindow ?? 0) < spec.minContext) return false;
  if (spec.providers.length && !spec.providers.includes(String(model.provider).toLowerCase())) return false;
  if (spec.groups.length) {
    const group = registry?.relays?.[model.provider]?.group;
    if (!group || !spec.groups.includes(String(group).toLowerCase())) return false;
  }
  if (spec.recent) {
    const seen = new Set(recentList(registry).map((r) => modelKey(r.provider, r.model)));
    if (!seen.has(modelKey(model.provider, model.id))) return false;
  }
  return true;
}

/** 先按结构化条件筛，再对剩余关键词打分（关键词无命中时返回空）。 */
export function selectModels(models, query, { registry = null } = {}) {
  const spec = parseQuery(query);
  let list = models.filter((m) => matchesQuery(m, spec, registry));
  const termQuery = spec.terms.join(" ").trim();
  if (termQuery) list = filterModels(list, termQuery);
  return { spec, models: list };
}

/**
 * 把选中的模型写成新会话的默认值（带时间戳备份，避免手改出错）。
 * @param {any} model
 */
export function persistDefault(model) {
  const file = path.join(agentDir(), "settings.json");
  const settings = readJson(file, {}) ?? {};
  settings.defaultProvider = model.provider;
  settings.defaultModel = model.id;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const base = `${file}.bak-${stamp}`;
    let backup = base;
    for (let n = 2; fs.existsSync(backup); n += 1) backup = `${base}-${n}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

/** 记录 MRU 与 lastModel；只对中转站写入，内置厂商不动。 */
export function recordModel(model, registry = readRegistry()) {
  if (!model?.provider || !model?.id) return false;
  const relay = registry.relays?.[model.provider];
  if (!relay) return false;
  const at = new Date().toISOString();
  relay.mru = [{ model: model.id, at }, ...(relay.mru ?? []).filter((e) => e.model !== model.id)].slice(0, MRU_LIMIT);
  relay.lastModel = model.id;
  saveRegistry(registry, { backup: false });
  return true;
}

/**
 * 扩展入口。
 * @param {any} pi pi 提供的 ExtensionAPI
 */
export default function (pi) {
  const available = (ctx) => {
    const registry = readRegistry();
    const relayIds = relayProviders();
    const modelRegistry = ctx?.modelRegistry ?? pi.modelRegistry;
    let models = [];
    try {
      models = modelRegistry?.getAvailable?.() ?? [];
    } catch {
      models = [];
    }
    const current = ctx?.model;
    return rankModels(models, relayIds, current?.provider, { registry }).map((m) => ({
      model: m,
      current: Boolean(current && m.provider === current.provider && m.id === current.id),
      isRelay: relayIds.includes(m.provider),
      favorite: isFavorite(registry, m),
    }));
  };

  const refreshStatus = (ctx, model = ctx?.model) => {
    try {
      const ui = ctx?.ui;
      if (!ui?.setStatus) return;
      if (!model) {
        ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const relay = readRegistry().relays?.[model.provider];
      const bits = ["pmh", `${model.provider}/${model.id}`];
      const ctxLabel = shortContext(model.contextWindow);
      if (ctxLabel) bits.push(ctxLabel);
      if (model.reasoning) bits.push("思考");
      if (relay) bits.push(`key:${relay.activeKey ?? "default"}`);
      ui.setStatus(STATUS_KEY, bits.join(" · "));
    } catch {
      /* 状态栏失败不影响切换 */
    }
  };

  const refreshWidget = (ctx, model = ctx?.model) => {
    try {
      const ui = ctx?.ui;
      if (!ui?.setWidget) return;
      const registry = readRegistry();
      const relays = Object.values(registry.relays ?? {});
      const mode = registry.settings?.widget ?? "auto";
      const show = mode === "on" || (mode === "auto" && relays.length >= 2);
      if (!show) {
        ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
        return;
      }
      const models = readJson(path.join(agentDir(), "models.json"), {}) ?? {};
      const current = model?.provider;
      const lines = relays.map((relay) => {
        const count = models.providers?.[relay.id]?.models?.length ?? 0;
        const group = relay.group ? ` [${relay.group}]` : "";
        const last = relay.lastModel ? ` · 上次 ${relay.lastModel}` : "";
        return `${relay.id === current ? "● " : "  "}${relay.id}${group} ${count} 模型${last}`;
      });
      ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    } catch {
      /* widget 失败静默降级 */
    }
  };

  const refresh = (ctx, model = ctx?.model) => {
    refreshStatus(ctx, model);
    refreshWidget(ctx, model);
  };

  const apply = async (ctx, entry, save) => {
    // ctx 和 pi 上都有 setModel；优先用 ctx 的，并保持正确的 this 绑定。
    const set = ctx.setModel ? ctx.setModel.bind(ctx) : pi.setModel.bind(pi);
    const ok = await set(entry.model);
    if (ok === false) {
      ctx.ui.notify(`切换失败：${entry.model.provider} 还没有可用凭据（先 /login 或用 pmh 配 key）`, "error");
      return;
    }
    try {
      recordModel(entry.model);
    } catch {
      /* 注册表写失败不影响切换 */
    }
    let extra = "";
    if (save) {
      try {
        persistDefault(entry.model);
        extra = "，并已设为新会话默认";
      } catch (err) {
        extra = `（写成默认失败：${err.message}）`;
      }
    }
    ctx.ui.notify(`已切换到 ${entry.model.provider}/${entry.model.id}${extra}`, "info");
    refresh(ctx, entry.model);
  };

  const switchToRelay = async (ctx, relayId) => {
    const registry = readRegistry();
    const relay = registry.relays?.[relayId];
    if (!relay) {
      ctx.ui.notify(`没有名为 "${relayId}" 的中转站（pmh ls 查看）`, "warning");
      return;
    }
    const all = available(ctx);
    const pool = all.filter((e) => e.model.provider === relayId);
    if (!pool.length) {
      ctx.ui.notify(`"${relayId}" 当前没有可用模型`, "warning");
      return;
    }
    const last = relay.lastModel ? pool.find((e) => e.model.id === relay.lastModel) : null;
    const entry = last ?? pool[0];
    if (!last && relay.lastModel) {
      ctx.ui.notify(`"${relayId}" 上次用的 ${relay.lastModel} 已不可用，改用 ${entry.model.id}`, "warning");
    }
    await apply(ctx, entry, false);
  };

  const run = async (args, ctx, save) => {
    const all = available(ctx);
    if (!all.length) {
      ctx.ui.notify("没有可用模型：先在 models.json 配一个 provider，或 /login 一个内置厂商", "warning");
      return;
    }
    const query = String(args ?? "").trim();
    const registry = readRegistry();
    const { spec, models: selected } = selectModels(all.map((e) => e.model), query, { registry });

    if (spec.relay) {
      await switchToRelay(ctx, spec.relay);
      return;
    }

    const byModel = new Map(all.map((e) => [e.model, e]));
    const ranked = rankModels(selected, relayProviders(), ctx.model?.provider, { registry });
    const entries = ranked.map((m) => {
      const base = byModel.get(m);
      return base ? { ...base, favorite: isFavorite(registry, m) } : null;
    }).filter(Boolean);

    if (!entries.length) {
      ctx.ui.notify(query ? `没有匹配 "${query}" 的模型` : "没有可用模型", "warning");
      return;
    }
    if (query && entries.length === 1) {
      await apply(ctx, entries[0], save);
      return;
    }
    const shown = entries.slice(0, MAX_OPTIONS);
    const labels = shown.map((e) => labelOf(e.model, {
      current: e.current,
      isRelay: e.isRelay,
      favorite: e.favorite,
    }));
    const title = query
      ? `切换模型 · 匹配 "${query}"（${entries.length} 个）`
      : `切换模型（${entries.length} 个，收藏/最近优先）`;
    const picked = await ctx.ui.select(title, labels);
    if (!picked) return;
    const index = labels.indexOf(picked);
    if (index < 0) return;
    await apply(ctx, shown[index], save);
  };

  const toggleFavorite = async (ctx) => {
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("当前没有模型可以收藏", "warning");
      return;
    }
    const registry = readRegistry();
    const relay = registry.relays?.[model.provider];
    if (!relay) {
      ctx.ui.notify(`"${model.provider}" 不是中转站，不需要收藏`, "warning");
      return;
    }
    const had = relay.favorites.includes(model.id);
    relay.favorites = had ? relay.favorites.filter((m) => m !== model.id) : [...relay.favorites, model.id];
    try {
      saveRegistry(registry, { backup: true });
    } catch (err) {
      ctx.ui.notify(`写入注册表失败：${err.message}`, "error");
      return;
    }
    ctx.ui.notify(`${had ? "已取消收藏" : "已收藏"} ${model.provider}/${model.id}`, "info");
    refreshWidget(ctx);
  };

  const setWidget = async (args, ctx) => {
    const registry = readRegistry();
    const wanted = String(args ?? "").trim().toLowerCase();
    let mode;
    if (wanted && WIDGET_MODES.includes(wanted)) mode = wanted;
    else if (!wanted) mode = registry.settings.widget === "on" ? "off" : "on";
    else {
      ctx.ui.notify(`用法：/switch-widget [${WIDGET_MODES.join("|")}]`, "warning");
      return;
    }
    registry.settings.widget = mode;
    try {
      saveRegistry(registry, { backup: true });
    } catch (err) {
      ctx.ui.notify(`写入注册表失败：${err.message}`, "error");
      return;
    }
    ctx.ui.notify(`站点 widget 已设为 ${mode}`, "info");
    refreshWidget(ctx);
  };

  const switchCompletions = (prefix) => {
    const q = String(prefix ?? "").toLowerCase();
    const out = [
      { value: "@fav", label: "@fav", description: "只看收藏" },
      { value: "recent", label: "recent", description: "最近使用" },
    ];
    const registry = readRegistry();
    for (const id of Object.keys(registry.groups ?? {})) out.push({ value: `@${id}`, label: `@${id}`, description: "分组" });
    for (const id of relayProviders()) out.push({ value: id, label: id, description: "中转站" });
    return out.filter((o) => o.value.toLowerCase().includes(q));
  };

  pi.registerCommand("switch", {
    description: "快速切换模型（@组 / @fav / recent / 关键词，如 /switch @code sonnet）",
    getArgumentCompletions: switchCompletions,
    handler: async (args, ctx) => run(args, ctx, false),
  });

  pi.registerCommand("switch-save", {
    description: "切换模型，并把它设为新会话的默认模型",
    getArgumentCompletions: switchCompletions,
    handler: async (args, ctx) => run(args, ctx, true),
  });

  pi.registerCommand("switch-fav", {
    description: "收藏/取消收藏当前模型（只对中转站生效）",
    handler: async (_args, ctx) => toggleFavorite(ctx),
  });

  pi.registerCommand("switch-widget", {
    description: "开关站点 widget：on / off / auto",
    getArgumentCompletions: (prefix) => {
      const q = String(prefix ?? "").toLowerCase();
      return [
        { value: "on", label: "on", description: "总是显示" },
        { value: "off", label: "off", description: "隐藏" },
        { value: "auto", label: "auto", description: "≥2 个站时显示（默认）" },
      ].filter((o) => o.value.includes(q));
    },
    handler: async (args, ctx) => setWidget(args, ctx),
  });

  pi.registerShortcut("ctrl+shift+m", {
    description: "快速切换模型",
    handler: async (ctx) => run("", ctx, false),
  });

  pi.on?.("model_select", async (event, ctx) => {
    const model = event?.model ?? event;
    // source=restore 是恢复会话时的自动选中，不该算进"最近使用"
    if (event?.source !== "restore") {
      try {
        recordModel(model);
      } catch {
        /* 注册表不可写时忽略 */
      }
    }
    refresh(ctx ?? event?.ctx, model);
  });

  pi.on?.("session_start", async (_event, ctx) => refresh(ctx));
}
