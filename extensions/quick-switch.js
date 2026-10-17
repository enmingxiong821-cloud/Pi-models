/**
 * pi 快速切换扩展：把中转站模型排在最前面，一条斜杠命令或一个快捷键就能换模型。
 *
 * 加载方式（任选）：
 *   1) 放到 ~/.pi/agent/extensions/quick-switch.js（pi 自动发现）
 *   2) 临时试用：pi --extension <此文件路径>
 *   3) 作为 pi 包安装：pi install git:github.com/<你的用户名>/pi-model-hub
 *
 * 用法：
 *   /switch              弹出选择器（中转站的模型排最前，● 是当前模型）
 *   /switch sonnet       关键词直接切（唯一命中时一步到位）
 *   /switch-save         选一个并同时设为新会话的默认模型
 *   Ctrl+Shift+M         快捷键，等同 /switch
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_OPTIONS = 400;

function agentDir() {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".pi", "agent");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** models.json 里登记的 provider —— 也就是我们接的中转站，切换时优先展示。 */
export function relayProviders() {
  const models = readJson(path.join(agentDir(), "models.json"));
  return Object.keys(models?.providers ?? {});
}

function shortContext(n) {
  if (!n) return "";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

/**
 * 选择器里显示的一行文本，同时要能唯一反查到模型。
 * @param {any} model
 * @param {{ current?: boolean, isRelay?: boolean }} [extras]
 */
export function labelOf(model, extras = {}) {
  const flags = [];
  if (model.reasoning) flags.push("思考");
  if ((model.input ?? []).includes("image")) flags.push("图片");
  if (extras.isRelay) flags.push("中转");
  const meta = [shortContext(model.contextWindow), ...flags].filter(Boolean).join("/");
  return `${extras.current ? "● " : ""}${model.provider}/${model.id}${meta ? `  · ${meta}` : ""}`;
}

/**
 * 排序：中转站 → 当前 provider → 其他，组内按 provider/model 字典序。
 * @param {any[]} models
 * @param {string[]} relays
 * @param {string} [currentProvider]
 */
export function rankModels(models, relays, currentProvider) {
  const group = (m) => {
    if (relays.includes(m.provider)) return 0;
    if (m.provider === currentProvider) return 1;
    return 2;
  };
  return [...models].sort((a, b) => {
    const g = group(a) - group(b);
    if (g !== 0) return g;
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
 * 关键词过滤：完全没命中时回退到全量列表，避免选择器变成空白。
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

/**
 * 把选中的模型写成新会话的默认值（带时间戳备份，避免手改出错）。
 * @param {any} model
 */
export function persistDefault(model) {
  const file = path.join(agentDir(), "settings.json");
  const settings = readJson(file) ?? {};
  settings.defaultProvider = model.provider;
  settings.defaultModel = model.id;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return file;
}

/**
 * 扩展入口。
 * @param {any} pi pi 提供的 ExtensionAPI
 */
export default function (pi) {
  const relays = () => relayProviders();

  const available = (ctx) => {
    const registry = ctx.modelRegistry ?? pi.modelRegistry;
    let models = [];
    try {
      models = registry?.getAvailable?.() ?? [];
    } catch {
      models = [];
    }
    const current = ctx.model;
    const relayIds = relays();
    return rankModels(models, relayIds, current?.provider).map((m) => ({
      model: m,
      current: Boolean(current && m.provider === current.provider && m.id === current.id),
      isRelay: relayIds.includes(m.provider),
    }));
  };

  const apply = async (ctx, entry, save) => {
    // ctx 和 pi 上都有 setModel；优先用 ctx 的，并保持正确的 this 绑定。
    const set = ctx.setModel ? ctx.setModel.bind(ctx) : pi.setModel.bind(pi);
    const ok = await set(entry.model);
    if (ok === false) {
      ctx.ui.notify(`切换失败：${entry.model.provider} 还没有可用凭据（先 /login 或用 pmh 配 key）`, "error");
      return;
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
  };

  const run = async (args, ctx, save) => {
    const all = available(ctx);
    if (!all.length) {
      ctx.ui.notify("没有可用模型：先在 models.json 配一个 provider，或 /login 一个内置厂商", "warning");
      return;
    }
    const query = String(args ?? "").trim();
    const byModel = new Map(all.map((e) => [e.model, e]));
    const ordered = query ? filterModels(all.map((e) => e.model), query) : all.map((e) => e.model);
    const entries = ordered.map((m) => byModel.get(m)).filter(Boolean);

    if (!entries.length) {
      ctx.ui.notify(`没有匹配 "${query}" 的模型`, "warning");
      return;
    }
    if (query && entries.length === 1) {
      await apply(ctx, entries[0], save);
      return;
    }
    const shown = entries.slice(0, MAX_OPTIONS);
    const labels = shown.map((e) => labelOf(e.model, { current: e.current, isRelay: e.isRelay }));
    const picked = await ctx.ui.select(
      query ? `切换模型 · 匹配 "${query}"（${entries.length} 个）` : `切换模型（${entries.length} 个，中转站优先）`,
      labels,
    );
    if (!picked) return;
    const index = labels.indexOf(picked);
    if (index < 0) return;
    await apply(ctx, shown[index], save);
  };

  pi.registerCommand("switch", {
    description: "快速切换模型（中转站优先，可带关键词，如 /switch sonnet）",
    getArgumentCompletions: (prefix) => {
      const q = String(prefix ?? "").toLowerCase();
      return relays()
        .filter((p) => p.toLowerCase().includes(q))
        .map((p) => ({ value: p, label: p, description: "中转站" }));
    },
    handler: async (args, ctx) => run(args, ctx, false),
  });

  pi.registerCommand("switch-save", {
    description: "切换模型，并把它设为新会话的默认模型",
    handler: async (args, ctx) => run(args, ctx, true),
  });

  pi.registerShortcut("ctrl+shift+m", {
    description: "快速切换模型",
    handler: async (ctx) => run("", ctx, false),
  });
}
