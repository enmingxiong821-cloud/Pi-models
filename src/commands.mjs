import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AUTO_MODEL, AUTO_PROVIDER, TIERS, TIER_LABELS, autoConfigPath, classifyTask, formatTierSpec, parseTierSpec, readAutoConfig, writeAutoConfig } from "../extensions/auto-router/router.mjs";
import { checkCompat, installedMode, packageEntry, readSourceMarker, repoAvailable, staleCopies, syncCopiedExtensions, writeSourceMarker } from "../extensions/auto-router/compat.mjs";
import { loadCatalog, buildModelEntry } from "./catalog.mjs";
import { detectClipboardTool, maskKey, parseEndpoint, readClipboard } from "./clipboard.mjs";
import { buildFeedback, openUrl } from "./feedback.mjs";
import { collectFromCcswitch, collectFromClaude, collectFromCodex, dedupeItems, fetchText, isUrl, parseImportText } from "./import.mjs";
import { addKeyAlias, activateAlias, keyAliasesOf, keyOf, keyStatus, removeKeyAlias } from "./keyring.mjs";
import { searchModels } from "./match.mjs";
import { extractUpstreamMeta, ratioCosts } from "./metadata.mjs";
import { loadBuiltinProviders, parseCost, parseCount, providerHasContent, resolveLocalPreset, validateModelsConfig } from "./native.mjs";
import { pickOne } from "./picker.mjs";
import { configPaths, findPiInstall, findPiLauncher, launcherCommand, launcherNeedsShell, quoteShellArg, resolveAgentDir } from "./paths.mjs";
import { askConfirm, askSecret, askText, isInteractive, noteNonInteractive } from "./prompt.mjs";
import { API_KINDS, apiFamily, baseUrlFor, fetchModels, probeChat, fetchRatioConfig, suggestName } from "./relay.mjs";
import {
  addFavorite, addGroup, isFavorite, loadRegistry, normalizeGroupName, recentModels, recordDefaultHistory, recordMetaSources,
  recordUse, removeFavorite, removeGroup, removeRelay, saveRegistry, setRelayGroup, takeDefaultHistory, toggleFavorite,
} from "./registry.mjs";
import { c, fail, heading, info, log, ok, readJson, rootOf, table, truncate, warn, writeJson } from "./util.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function makeContext(flags) {
  const agentDir = resolveAgentDir(flags.agentDir);
  const paths = configPaths(agentDir);
  const catalog = loadCatalog(agentDir, flags.catalog);
  return { agentDir, paths, catalog, flags };
}

function loadModels(ctx) {
  const data = readJson(ctx.paths.models, { providers: {} });
  data.providers ??= {};
  return data;
}

function loadAuth(ctx) {
  return readJson(ctx.paths.auth, {}) ?? {};
}

function loadSettings(ctx) {
  return readJson(ctx.paths.settings, {}) ?? {};
}

/** 读注册表并对齐 models/auth；返回的 models/auth 与注册表同一次快照。 */
function loadRegistryState(ctx, { models, auth } = {}) {
  const m = models ?? loadModels(ctx);
  const a = auth ?? loadAuth(ctx);
  return { ...loadRegistry(ctx, { models: m, auth: a }), models: m, auth: a };
}

/** 把分组/标签/来源写进注册表；分组不存在时自动创建。 */
function applyRelayRegistry(ctx, id, { group, tags = [], source, costMode, costMultiplier } = {}) {
  const { registry } = loadRegistryState(ctx);
  const relay = registry.relays[id];
  if (!relay) return;
  let touched = false;
  if (group) {
    try {
      const g = normalizeGroupName(group);
      if (!Object.hasOwn(registry.groups, g)) registry.groups[g] = { title: g, createdAt: new Date().toISOString() };
      relay.group = g;
      touched = true;
    } catch (err) {
      warn(err.message);
    }
  }
  const cleanTags = tags.map((t) => String(t).trim()).filter(Boolean);
  if (cleanTags.length) {
    relay.tags = [...new Set([...relay.tags, ...cleanTags])].slice(0, 16);
    touched = true;
  }
  if (source) {
    relay.source = source;
    touched = true;
  }
  if (costMode) {
    relay.costMode = costMode;
    relay.costMultiplier = costMultiplier;
    touched = true;
  }
  if (touched) saveRegistry(ctx, registry, { backup: false });
}

/** 记录本次同步里各字段的元数据来源（按字段计数，不是逐模型）。 */
function recordSyncMeta(ctx, id, report) {
  const { registry } = loadRegistryState(ctx);
  if (!registry.relays[id]) return;
  const counts = {};
  for (const row of report) {
    for (const [field, src] of Object.entries(row.sources ?? {})) {
      counts[field] ??= {};
      counts[field][src] = (counts[field][src] ?? 0) + 1;
    }
  }
  recordMetaSources(registry, id, counts);
  saveRegistry(ctx, registry, { backup: false });
}

function credentialOf(ctx, providerId) {
  const auth = loadAuth(ctx);
  const entry = auth[providerId];
  if (entry?.key) return { kind: entry.type === "api_key" || !entry.type ? "auth.json" : entry.type, value: entry.key };
  const models = loadModels(ctx);
  const apiKey = models.providers?.[providerId]?.apiKey;
  if (apiKey) {
    const env = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(apiKey);
    if (env) return process.env[env[1]] ? { kind: `env:${env[1]}`, value: process.env[env[1]] } : { kind: `env:${env[1]}（未设置）`, value: null };
    if (String(apiKey).startsWith("!")) return { kind: "命令引用", value: null, command: String(apiKey).slice(1).trim() };
    return { kind: "models.json(明文)", value: apiKey };
  }
  return { kind: "无", value: null };
}

/** 需要真实密钥发请求时用：命令引用会执行一次（pi 是在请求时执行，pmh 只能在这里展开）。 */
function resolveCredentialKey(cred) {
  if (!cred?.command) return cred?.value ?? null;
  const res = spawnSync(cred.command, { shell: true, encoding: "utf8", timeout: 15000 });
  if (res.error) throw new Error(`Key 命令执行失败：${res.error.message}`);
  const value = String(res.stdout ?? "").trim();
  if (res.status !== 0 || !value) throw new Error("Key 命令执行失败或没有输出");
  return value;
}

/** 解析 --key-ref / --key-cmd；返回要写进 models.json 的引用字符串。 */
function resolveKeyReference(flags) {
  if (flags.keyRef !== undefined && flags.keyCmd !== undefined) throw new Error("--key-ref 与 --key-cmd 只能二选一");
  if (flags.keyRef !== undefined) {
    if (flags.keyRef === true || !String(flags.keyRef).trim()) throw new Error("--key-ref 需要环境变量名，如 --key-ref OPENROUTER_API_KEY");
    const text = String(flags.keyRef).trim();
    const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(text) ?? /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
    if (!match) throw new Error(`--key-ref 只接受环境变量名，收到：${text}`);
    return `$${match[1]}`;
  }
  if (flags.keyCmd !== undefined) {
    if (flags.keyCmd === true || !String(flags.keyCmd).trim()) throw new Error("--key-cmd 需要一条能输出 Key 的命令");
    return `!${String(flags.keyCmd).trim()}`;
  }
  return null;
}

function keyReferenceValue(ref) {
  if (ref.startsWith("!")) {
    return resolveCredentialKey({ command: ref.slice(1).trim(), value: null });
  }
  const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(ref);
  const value = match ? process.env[match[1]] : null;
  if (!value) throw new Error(`环境变量 ${match?.[1] ?? ref} 为空或未设置`);
  return value;
}

function parseApiRules(rules = []) {
  return rules.map((raw) => {
    const idx = String(raw).lastIndexOf("=");
    if (idx < 0) throw new Error(`--api-rule 需要 "正则=api" 形式，收到: ${raw}`);
    const pattern = raw.slice(0, idx);
    const api = raw.slice(idx + 1);
    if (!API_KINDS.includes(api)) throw new Error(`不支持的 API: ${api}（可选 ${API_KINDS.join(" / ")}）`);
    return { re: new RegExp(pattern, "i"), api };
  });
}

function resolveModelApi(modelId, providerApi, rules) {
  for (const rule of rules) if (rule.re.test(modelId)) return rule.api;
  return providerApi;
}

function normalizeProviderName(name) {
  const id = String(name ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
    throw new Error(`provider 名称只能用字母/数字/._- 且以字母数字开头，收到: "${name}"`);
  }
  return id;
}

function collectModelIds(flags) {
  const fromFlag = flags.model ? String(flags.model).split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (flags.modelsFile) {
    const raw = readJson(path.resolve(flags.modelsFile), null);
    if (!raw) throw new Error(`读不到模型清单文件: ${flags.modelsFile}`);
    const list = Array.isArray(raw) ? raw : (raw.data ?? raw.models ?? Object.keys(raw));
    for (const item of list) fromFlag.push(typeof item === "string" ? item : item.id);
  }
  return [...new Set(fromFlag.filter(Boolean))];
}

async function discoverIds(ctx, { name, root, api, key, flags }) {
  const explicit = collectModelIds(flags);
  if (explicit.length) return { ids: explicit, items: [], source: "手动指定" };
  if (flags.noSync) return { ids: [], items: [], source: "未同步" };
  try {
    const res = await fetchModels({ root, api, key });
    if (!res.ok || !res.ids.length) {
      warn(`拉取模型列表失败（HTTP ${res.status}）：${truncate(res.raw, 160)}`);
      warn(`可先用 /v1/models 检查，或手动指定：pmh add ${name} --base ${root} --model id1,id2`);
      return { ids: [], items: [], source: "拉取失败" };
    }
    return { ids: res.ids, items: res.items, source: `${res.url}` };
  } catch (err) {
    const proxyHint = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? `（当前代理 ${process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY}，不通可用 --proxy 指定或设 PMH_NO_PROXY=1 直连）` : "";
    warn(`拉取模型列表出错：${err.message}${proxyHint}`);
    return { ids: [], items: [], source: "拉取失败" };
  }
}

/**
 * 本机推理服务一键接入：`pmh local ollama` / `lmstudio` / `vllm` / `sglang` / `llama-cpp`。
 * 这些端点通常不校验 Key，但 pi 在解析不到凭据时会隐藏模型，所以自动写一个占位 Key。
 */
export async function cmdLocal(ctx, presetArg, flags = {}) {
  const preset = resolveLocalPreset(presetArg, flags);
  const name = normalizeProviderName(flags.as ?? preset.id);
  heading(`${preset.title} 本机接入`);
  log(`  地址     ${preset.root}`);
  log(`  baseUrl  ${baseUrlFor(preset.root, "openai-completions")}`);
  info("本机服务不校验 Key；会写一个占位 Key，否则 pi 不会列出模型");
  await cmdAdd(ctx, name, { ...flags, local: preset.id, as: undefined });
  if (flags.dryRun) return;
  const provider = loadModels(ctx).providers[name];
  const count = provider?.models?.length ?? 0;
  if (!count) {
    warn(`还没有发现模型。${preset.hint ?? "先启动本机服务"}，然后运行：pmh sync ${name}`);
  } else {
    info(`在 pi 里打开 /model 即可看到 ${name} 的 ${count} 个模型`);
  }
}

/**
 * 一键配置：`pmh quick <地址> [key]`，没给的部分从剪贴板里认。
 * 全程尽量不问问题，最后直接让用户挑一个默认模型。
 */
export async function cmdQuick(ctx, urlArg, keyArg, flags) {
  const tty = isInteractive();
  let url = urlArg ?? flags.base ?? flags.baseUrl ?? "";
  let key = keyArg ?? flags.key ?? "";

  if (!url || !key) {
    const parsed = parseEndpoint(readClipboard());
    if (!url && parsed.url) {
      url = parsed.url;
      info(`从剪贴板读到地址：${url}`);
    }
    if (!key && parsed.key) {
      key = parsed.key;
      info(`从剪贴板读到密钥：${maskKey(key)}`);
    }
  }
  if (!url && tty) url = await askText("中转站地址（可带或不带 /v1）");
  if (!url) {
    throw new Error("没拿到地址。用法：pmh quick <地址> [key]；或者先把「地址 + key」复制到剪贴板，再运行 pmh quick");
  }
  if (!key && tty) key = await askSecret("API Key（留空则稍后再补）");
  if (!key) warn("没有 Key：不需要鉴权的端点可以继续，否则稍后用 pmh key <名称> <key> 补上");

  const name = normalizeProviderName(flags.as ?? suggestName(rootOf(url)));
  info(`配置 provider "${name}"`);
  await cmdAdd(ctx, name, { ...flags, base: url, key: key || undefined, yes: true, force: true });

  const entries = (loadModels(ctx).providers[name]?.models ?? []).map((m) => ({
    provider: name,
    model: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow,
    reasoning: m.reasoning,
  }));
  if (!entries.length) {
    warn(`这个端点没返回模型列表。稍后重试：pmh sync ${name}`);
    return;
  }
  if (!tty) {
    info(`可用模型 ${entries.length} 个。切换：pmh use ${name}#<模型>`);
    return;
  }

  const chosen = await pickOne(entries, {
    title: `选择默认模型（${name} 共 ${entries.length} 个）`,
    label: (e) => `${e.model}${e.contextWindow ? c.dim(`  ${Math.round(e.contextWindow / 1000)}K`) : ""}${e.reasoning ? c.dim("  思考") : ""}`,
  });
  if (chosen) await cmdUse(ctx, `${name}#${chosen.model}`, {});
  else info(`已保存 ${name}，随时可以 pmh use ${name}#<模型> 切换`);
}

function buildModelList(ids, {
  ctx, providerApi, providerBaseUrl, rules, costMode, costMultiplier,
  previous = {}, upstreamItems = [], ratioConfig = null, noReasoningCompat = false,
  refreshMeta = false, promptCache = false,
}) {
  const upstreamById = new Map();
  for (const item of upstreamItems ?? []) {
    const key = String(item?.id ?? item?.name ?? "");
    if (key) upstreamById.set(key, item);
  }
  const entries = [];
  const report = [];
  for (const id of ids) {
    const modelApi = resolveModelApi(id, providerApi, rules);
    const upstream = extractUpstreamMeta(upstreamById.get(id));
    const { entry, match, source, sources, upstreamSource } = buildModelEntry(id, {
      catalog: ctx.catalog,
      providerApi,
      providerBaseUrl,
      modelApi,
      modelBaseUrl: baseUrlFor(providerBaseUrl, modelApi),
      costMode,
      costMultiplier,
      upstream,
      ratioCost: ratioConfig ? ratioCosts(id, ratioConfig) : null,
      supportsReasoningEffort: upstream?.supportsReasoningEffort === true,
      noReasoningCompat,
      includePromptCache: promptCache,
    });
    const old = previous[id];
    // 默认保留已有条目（手改过的 contextWindow / compat 等不被覆盖）；--refresh-meta 才刷新
    entries.push(old ? (refreshMeta ? { ...old, ...entry } : { ...entry, ...old }) : entry);
    report.push({
      id, name: entry.name, source, matchedId: match?.matchedId, method: match?.method,
      api: entry.api ?? providerApi, sources, upstreamSource,
      kept: Boolean(old && !refreshMeta),
    });
  }
  return { entries, report };
}

function printModelReport(report, { verbose }) {
  const bySource = report.reduce((acc, r) => ((acc[r.source] = (acc[r.source] ?? 0) + 1), acc), {});
  heading("模型元数据");
  for (const [src, n] of Object.entries(bySource)) log(`  ${src}: ${n} 个`);
  if (verbose) {
    log("");
    log(
      table(
        report.map((r) => [truncate(r.id, 44), truncate(r.name, 28), r.api, r.method ? `${r.source}(${r.method})` : r.source]),
        ["模型 ID", "显示名", "API", "元数据来源"],
      ),
    );
  } else {
    info("查看明细：加 --verbose");
  }
}

/**
 * 接入一个第三方端点。带参数走脚本模式，不带给参数就变成向导：
 * 地址 → 名称 → Key → 读模型列表 → 写入 → 立刻挑一个模型设为默认。
 */
export async function cmdAdd(ctx, nameArg, flags) {
  const tty = isInteractive();
  const models = loadModels(ctx);
  // 本机服务：地址、协议、占位 Key 都有默认值，用户只需要给服务名
  const localPreset = flags.local ? resolveLocalPreset(flags.local, flags) : null;
  if (localPreset) {
    flags = {
      ...flags,
      base: flags.base ?? localPreset.root,
      api: flags.api ?? "openai-completions",
      keyIn: flags.keyIn ?? "models",
    };
    if (
      !flags.key && !flags.noKey &&
      flags.keyEnv === undefined && flags.keyRef === undefined && flags.keyCmd === undefined
    ) {
      flags.key = localPreset.key;
      info(`${localPreset.title}：使用占位 Key "${localPreset.key}"（本机服务不校验，pi 需要它来显示模型）`);
    }
  }
  let id = nameArg ? normalizeProviderName(nameArg) : null;
  const known = id ? models.providers[id] : null;
  // 更新已有 provider 时，地址/协议可以省略，沿用原来的
  let base = flags.base ?? flags.baseUrl ?? known?.baseUrl;
  if (!base) {
    if (!tty) {
      noteNonInteractive();
      throw new Error("缺少 --base <中转站地址>");
    }
    base = await askText("中转站地址（可带或不带 /v1）");
    if (!base) throw new Error("没有填地址，已取消。");
  }
  let root = rootOf(base);
  const api = flags.api ?? known?.api ?? "openai-completions";
  if (!API_KINDS.includes(api)) throw new Error(`不支持的 --api: ${api}（可选 ${API_KINDS.join(" / ")}）`);
  const rules = parseApiRules([].concat(flags.apiRule ?? []));

  if (!id) {
    const suggestion = suggestName(root);
    if (tty) id = normalizeProviderName(await askText("给它起个名字（pi 里的 provider 名）", { defaultValue: suggestion }));
    else {
      id = normalizeProviderName(suggestion);
      info(`未指定名称，按地址推断为 "${id}"`);
    }
  }

  const existing = models.providers[id];
  if (existing && !flags.force) {
    if (tty && !(await askConfirm(`provider "${id}" 已存在，更新它吗？`))) return info("已取消。");
    if (!tty) warn(`provider "${id}" 已存在，继续会更新它（加 --force 跳过确认）`);
  }
  const previous = Object.fromEntries((existing?.models ?? []).map((m) => [m.id, m]));

  const keyRef = resolveKeyReference(flags);
  let literalKey = flags.key ?? (flags.keyEnv ? process.env[flags.keyEnv] : null);
  if (keyRef && literalKey) throw new Error("--key-ref/--key-cmd 与 --key/--key-env 只能二选一");
  // 探测模型列表需要真实 Key；命令引用只在这里展开一次，落盘仍是引用本身
  let probeKey = literalKey ?? (keyRef ? keyReferenceValue(keyRef) : null);
  if (!probeKey && tty && !flags.noKey) {
    literalKey = await askSecret(`粘贴 ${id} 的 API Key（留空则稍后再补）`);
    probeKey = literalKey;
  }

  const costMultiplier = Number(flags.costMultiplier ?? 1) || 1;
  const costMode = flags.noCost ? "off" : flags.cost === "scaled" || flags.costMultiplier ? "scaled" : "official";

  let { ids, items, source } = await discoverIds(ctx, { name: id, root, api, key: probeKey, flags });
  // 拉不到模型多半是 Key 或地址的问题，交互模式下给一次改的机会（本机服务只在没启动时需要重试，直接给提示）
  while (!ids.length && tty && !flags.noSync && !flags.dryRun && !localPreset) {
    if (!(await askConfirm("没拿到模型列表。要不要改地址或 Key 再试一次？", { defaultValue: false }))) break;
    root = rootOf(await askText("中转站地址（回车保持原值）", { defaultValue: root }));
    if (!keyRef) {
      const retryKey = await askSecret("API Key（回车保持原值）");
      if (retryKey) {
        literalKey = retryKey;
        probeKey = retryKey;
      }
    }
    ({ ids, items, source } = await discoverIds(ctx, { name: id, root, api, key: probeKey, flags }));
  }

  let ratioConfig = null;
  if (flags.ratio && ids.length) {
    const ratio = await fetchRatioConfig({ root });
    if (ratio.ok) {
      ratioConfig = ratio.data;
    } else {
      warn("没读到中转站的倍率配置，价格按上游/官方目录计算");
    }
  }

  if (ids.length) {
    heading(`读取到 ${ids.length} 个模型`);
    const preview = ids.slice(0, 12).join("、");
    log(`  ${preview}${ids.length > 12 ? ` …等 ${ids.length} 个` : ""}`);
  }

  const { entries, report } = buildModelList(ids, {
    ctx,
    providerApi: api,
    providerBaseUrl: baseUrlFor(root, api),
    rules,
    costMode,
    costMultiplier,
    previous,
    upstreamItems: items,
    ratioConfig,
    noReasoningCompat: Boolean(flags.noReasoningCompat),
    refreshMeta: Boolean(flags.refreshMeta),
    promptCache: Boolean(flags.promptCache),
  });

  const provider = {
    ...(existing ?? {}),
    name: flags.displayName ?? existing?.name ?? id,
    baseUrl: baseUrlFor(root, api),
    api,
    ...(entries.length ? { models: entries } : {}),
  };
  if (keyRef) provider.apiKey = keyRef;
  else if (flags.keyIn === "models" && literalKey) provider.apiKey = literalKey;

  if (flags.dryRun) {
    heading("--dry-run：以下内容将写入 models.json");
    log(JSON.stringify({ providers: { [id]: provider } }, null, 2));
    if (keyRef) log(`\n（密钥引用 ${keyRef} 会写进 models.json，auth.json 不存明文）`);
    else if (literalKey && flags.keyIn !== "models") log(`\n（同时把 key 写入 auth.json 的 "${id}"）`);
    return;
  }

  if (tty && !flags.yes && !(await askConfirm(`写入 pi 配置吗？（${ctx.paths.models}）`))) return info("已取消。");

  models.providers[id] = provider;
  const backup = writeJson(ctx.paths.models, models);
  ok(`已写入 ${ctx.paths.models}${backup ? `（备份：${path.basename(backup)}）` : ""}`);

  if (keyRef) {
    const auth = loadAuth(ctx);
    if (auth[id]?.key) {
      warn(`auth.json 里已有 "${id}" 的凭据，它的优先级高于 models.json 的 apiKey；引用可能不会生效`);
      info(`确认要改用引用的话，先清理旧凭据：pmh rm ${id} --purge-key（会连 provider 一起删）`);
    }
    info(`密钥以引用形式写入 models.json：${keyRef}（auth.json 不存明文）`);
  } else if (literalKey && flags.keyIn !== "models") {
    const auth = loadAuth(ctx);
    auth[id] = { ...(auth[id] ?? {}), type: "api_key", key: literalKey };
    const authBackup = writeJson(ctx.paths.auth, auth, { mode: 0o600 });
    ok(`已写入 ${ctx.paths.auth}${authBackup ? `（备份：${path.basename(authBackup)}）` : ""}`);
  } else if (!literalKey && flags.keyIn !== "models") {
    info(`尚未写入密钥。稍后执行：pmh key ${id} <你的key>   或再补：--key`);
  }

  const tags = flags.tag ? [].concat(flags.tag).flatMap((t) => String(t).split(",")) : [];
  applyRelayRegistry(ctx, id, {
    group: flags.group,
    tags,
    source: flags.source ?? (localPreset ? "local" : "manual"),
    costMode,
    costMultiplier,
  });
  if (report.length) recordSyncMeta(ctx, id, report);

  if (flags.batch) {
    ok(`${id}: ${entries.length} 个模型${report.length ? `（来源：${[...new Set(report.map((r) => r.source))].join(" / ")}）` : ""}`);
    return;
  }

  heading(`provider "${id}" 就绪`);
  log(`  地址       ${baseUrlFor(root, api)}`);
  log(`  默认 API   ${api}${rules.length ? `（另加 ${rules.length} 条按模型路由规则）` : ""}`);
  log(`  模型数     ${entries.length}${entries.length ? "" : "（用 pmh sync 重新同步，或 --model 手动指定）"}`);
  log(`  模型清单   ${source}`);
  if (report.length) printModelReport(report, { verbose: flags.verbose });
  const keptMeta = report.filter((r) => r.kept).length;
  if (keptMeta) info(`${keptMeta} 个已有模型保留原元数据（需要刷新时加 --refresh-meta）`);

  // 刚读完列表，顺手就把默认模型选掉，这是"接入即可用"的最后一公里
  if (tty && entries.length && !flags.yes) {
    if (await askConfirm("现在就挑一个模型设为默认吗？")) {
      const chosen = await pickOne(
        entries.map((e) => ({ provider: id, model: e.id, name: e.name, contextWindow: e.contextWindow, reasoning: e.reasoning })),
        {
          title: `${id} 的模型`,
          label: (e) => `${e.model}${e.contextWindow ? c.dim(`  ${Math.round(e.contextWindow / 1000)}K`) : ""}${e.reasoning ? c.dim("  思考") : ""}`,
        },
      );
      if (chosen) await cmdUse(ctx, `${id}#${chosen.model}`, {});
    }
  }

  log("");
  if (localPreset && !entries.length) {
    warn(`本机服务还没有返回模型：${localPreset.hint ?? "确认服务已启动"}`);
    info(`启动后执行：pmh sync ${id}`);
  }
  info(`在 pi 里输入 /switch 就能切（中转站的模型排最前），快捷键 Ctrl+Shift+M`);
  info(`命令行：pmh pick / pmh use ${id}#<模型> / pmh run ${id}#<模型>`);
  info(`体检：  pmh test ${id}`);
}

export async function cmdSync(ctx, name, flags) {
  const id = normalizeProviderName(name);
  const models = loadModels(ctx);
  const provider = models.providers[id];
  if (!provider) throw new Error(`没有名为 "${id}" 的 provider，先 pmh add`);
  const cred = credentialOf(ctx, id);
  const api = provider.api ?? flags.api ?? "openai-completions";
  const root = rootOf(provider.baseUrl ?? flags.base);
  const rules = parseApiRules([].concat(flags.apiRule ?? []));

  const { ids, items, source } = await discoverIds(ctx, { name: id, root, api, key: resolveCredentialKey(cred), flags });
  if (!ids.length) {
    warn("没有拿到任何模型，配置保持不变。");
    return;
  }
  const previous = Object.fromEntries((provider.models ?? []).map((m) => [m.id, m]));
  const keepMissing = flags.keepMissing !== undefined && flags.keepMissing !== false && flags.keepMissing !== "false";
  const keptMissing = keepMissing ? (provider.models ?? []).filter((m) => !ids.includes(m.id)) : [];
  const costMultiplier = Number(flags.costMultiplier ?? 1) || 1;
  const costMode = flags.noCost ? "off" : flags.cost === "scaled" || flags.costMultiplier ? "scaled" : "official";
  let ratioConfig = null;
  if (flags.ratio) {
    const ratio = await fetchRatioConfig({ root });
    if (ratio.ok) ratioConfig = ratio.data;
    else warn("没读到中转站的倍率配置，价格按上游/官方目录计算");
  }
  const { entries, report } = buildModelList(ids, {
    ctx,
    providerApi: api,
    providerBaseUrl: provider.baseUrl ?? baseUrlFor(root, api),
    rules,
    costMode,
    costMultiplier,
    previous,
    upstreamItems: items,
    ratioConfig,
    noReasoningCompat: Boolean(flags.noReasoningCompat),
    refreshMeta: Boolean(flags.refreshMeta),
    promptCache: Boolean(flags.promptCache),
  });
  provider.models = keepMissing ? [...entries, ...keptMissing.filter((m) => !entries.some((e) => e.id === m.id))] : entries;
  provider.api ??= api;

  if (flags.dryRun) {
    log(JSON.stringify({ [id]: provider.models.length }, null, 2));
    return;
  }
  const backup = writeJson(ctx.paths.models, models);
  ok(`已同步 ${entries.length} 个模型到 ${ctx.paths.models}${backup ? `（备份：${path.basename(backup)}）` : ""}`);
  recordSyncMeta(ctx, id, report);
  printModelReport(report, { verbose: flags.verbose });
  const keptMeta = report.filter((r) => r.kept).length;
  if (keptMeta) info(`${keptMeta} 个已有模型保留原元数据（需要刷新时加 --refresh-meta）`);
  info(`目录来源：${source}`);
  info("在 pi 里打开 /model 即可看到新模型（无需重启）。");
}

/**
 * 单模型管理：不重拉整站模型列表，直接增删/覆盖任意一个模型。
 * 内置 provider（openai / anthropic / openrouter ...）用 modelOverrides 改元数据，
 * 用 models 新增它原本没有的模型；自定义 provider 两者都写在 models.json 里。
 */
export function cmdModel(ctx, args, flags = {}) {
  const [sub = "ls", ...rest] = args;
  if (sub === "ls" || sub === "list") return modelList(ctx, rest[0], flags);
  if (!["add", "set", "override", "rm", "remove", "reset"].includes(sub)) {
    throw new Error(`未知的 model 子命令 "${sub}"（可选 add / ls / rm / override）`);
  }
  const [providerArg, modelId] = rest;
  if (!providerArg || !modelId) throw new Error(`用法：pmh model ${sub} <provider> <模型 id> [参数]`);
  const id = normalizeProviderName(providerArg);
  const models = loadModels(ctx);
  const builtins = loadBuiltinProviders(ctx.agentDir).providers;
  const builtin = builtins.get(id) ?? null;
  const config = models.providers[id] ?? null;
  if (!config && !builtin) {
    throw new Error(`不认识 provider "${id}"：自定义端点先用 pmh add ${id} --base <地址> 建好`);
  }
  if (sub === "rm" || sub === "remove" || sub === "reset") {
    return modelRemove(ctx, models, id, modelId, config, flags);
  }
  const override = sub === "override" || Boolean(flags.override);
  return override
    ? modelOverride(ctx, models, id, modelId, config, flags)
    : modelAdd(ctx, models, id, modelId, config, builtin, flags);
}

function modelRow(m, source) {
  return [
    m.id,
    m.name ?? m.id,
    m.api ?? "-",
    m.contextWindow ? formatContext(m.contextWindow) : "-",
    m.maxTokens ? formatContext(m.maxTokens) : "-",
    m.reasoning ? "是" : "",
    (m.input ?? []).includes("image") ? "是" : "",
    source,
  ];
}

function modelList(ctx, providerArg, flags = {}) {
  const models = loadModels(ctx);
  if (providerArg) {
    const id = normalizeProviderName(providerArg);
    const config = models.providers[id] ?? null;
    const builtin = loadBuiltinProviders(ctx.agentDir).providers.get(id) ?? null;
    if (!config && !builtin) throw new Error(`不认识 provider "${id}"`);
    const rows = [
      ...(config?.models ?? []).map((m) => modelRow(m, "models")),
      ...Object.entries(config?.modelOverrides ?? {}).map(([modelId, o]) => modelRow({ id: modelId, ...o }, "override")),
    ];
    if (flags.json) {
      log(JSON.stringify({
        provider: id,
        builtin: builtin ? { name: builtin.name, baseUrl: builtin.baseUrl, api: builtin.api } : null,
        models: config?.models ?? [],
        modelOverrides: config?.modelOverrides ?? {},
      }, null, 2));
      return;
    }
    heading(`${id} 的自定义模型${builtin ? "（pi 内置 provider）" : ""}`);
    if (!rows.length) {
      info(builtin ? "还没有自定义条目；用 pmh model add / pmh model override 添加" : "还没有模型条目；用 pmh model add 添加");
    } else {
      log(table(rows, ["模型 ID", "显示名", "API", "上下文", "最大输出", "思考", "图片", "来源"]));
    }
    if (builtin) info("override 只改内置模型的元数据；models 里的条目会新增或替换同名模型");
    return;
  }

  const payload = {};
  for (const [id, config] of Object.entries(models.providers)) {
    payload[id] = { models: config.models ?? [], modelOverrides: config.modelOverrides ?? {} };
  }
  if (flags.json) return log(JSON.stringify(payload, null, 2));
  const rows = Object.entries(models.providers).map(([id, config]) => [
    id,
    String((config.models ?? []).length),
    String(Object.keys(config.modelOverrides ?? {}).length),
    config.baseUrl ?? "-",
    config.api ?? "-",
  ]);
  heading("models.json 里的自定义模型");
  if (!rows.length) {
    info("还没有 provider。先用 pmh add 或 pmh local 接入一个端点。");
    return;
  }
  log(table(rows, ["provider", "models", "overrides", "baseUrl", "api"]));
  info("查看某个 provider 的模型：pmh model ls <provider>");
}

function modelPatch(flags, { partialCost = false } = {}) {
  const patch = {};
  if (flags.name !== undefined) patch.name = String(flags.name);
  if (flags.ctx !== undefined) patch.contextWindow = parseCount(flags.ctx, "--ctx");
  if (flags.maxOutput !== undefined) patch.maxTokens = parseCount(flags.maxOutput, "--max-output");
  if (flags.reasoning !== undefined) patch.reasoning = Boolean(flags.reasoning);
  if (flags.textOnly) patch.input = ["text"];
  else if (flags.image !== undefined) patch.input = flags.image ? ["text", "image"] : ["text"];
  const hasCost = [flags.costIn, flags.costOut, flags.cacheRead, flags.cacheWrite].some((v) => v !== undefined);
  if (hasCost) {
    if (!partialCost) {
      if (flags.costIn === undefined || flags.costOut === undefined) {
        throw new Error("--cost-in 与 --cost-out 需要同时提供（单位：USD / 百万 token）");
      }
      patch.cost = {
        input: parseCost(flags.costIn, "--cost-in"),
        output: parseCost(flags.costOut, "--cost-out"),
        cacheRead: flags.cacheRead !== undefined ? parseCost(flags.cacheRead, "--cache-read") : 0,
        cacheWrite: flags.cacheWrite !== undefined ? parseCost(flags.cacheWrite, "--cache-write") : 0,
      };
    } else {
      const cost = {};
      if (flags.costIn !== undefined) cost.input = parseCost(flags.costIn, "--cost-in");
      if (flags.costOut !== undefined) cost.output = parseCost(flags.costOut, "--cost-out");
      if (flags.cacheRead !== undefined) cost.cacheRead = parseCost(flags.cacheRead, "--cache-read");
      if (flags.cacheWrite !== undefined) cost.cacheWrite = parseCost(flags.cacheWrite, "--cache-write");
      patch.cost = cost;
    }
  }
  return patch;
}

function writeModels(ctx, models, id, next, dryRun) {
  if (next && providerHasContent(next)) models.providers[id] = next;
  else delete models.providers[id];
  if (dryRun) {
    heading("--dry-run：以下内容将写入 models.json");
    log(JSON.stringify({ providers: { [id]: next } }, null, 2));
    return null;
  }
  return writeJson(ctx.paths.models, models);
}

function modelAdd(ctx, models, id, modelId, config, builtin, flags) {
  const providerApi = flags.api ?? config?.api ?? builtin?.api ?? "openai-completions";
  const providerBase = config?.baseUrl ?? builtin?.baseUrl ?? (flags.base ? baseUrlFor(flags.base, providerApi) : null);
  if (!providerBase && !flags.base) {
    throw new Error(`无法确定 ${id} 的 baseUrl：请加 --base <地址>，或先用 pmh add 建一个自定义 provider`);
  }
  const baseForMeta = providerBase ?? baseUrlFor(flags.base, providerApi);
  const built = buildModelEntry(modelId, {
    catalog: ctx.catalog,
    providerApi,
    providerBaseUrl: baseForMeta,
    modelApi: providerApi,
    modelBaseUrl: baseForMeta,
    costMode: "official",
    costMultiplier: 1,
  });
  const entry = { ...built.entry, ...modelPatch(flags) };
  if (flags.base) {
    entry.api = flags.api ?? providerApi;
    entry.baseUrl = baseUrlFor(flags.base, entry.api);
  } else if (flags.api && config?.baseUrl) {
    entry.baseUrl = baseUrlFor(config.baseUrl, flags.api);
  } else if (flags.api && builtin?.baseUrl) {
    entry.baseUrl = baseUrlFor(builtin.baseUrl, flags.api);
  }

  const next = { ...(config ?? {}) };
  if (!builtin && !next.api) next.api = providerApi;
  const previous = (next.models ?? []).find((m) => m?.id === modelId);
  next.models = [...(next.models ?? []).filter((m) => m?.id !== modelId), entry];
  const backup = writeModels(ctx, models, id, next, flags.dryRun);
  if (flags.dryRun) return;
  ok(`已${previous ? "更新" : "添加"}模型 ${id}/${modelId}${backup ? `（备份：${path.basename(backup)}）` : ""}`);
  log(`  上下文 ${formatContext(entry.contextWindow)} · 最大输出 ${formatContext(entry.maxTokens)} · ${entry.api ?? providerApi}`);
  if (builtin && !flags.base) {
    info(`这是 pi 内置 provider；已写入 models 条目，baseUrl 由 pi 的默认值补齐`);
  }
  info("在 pi 里打开 /model 会重新加载 models.json（无需重启）");
}

function modelOverride(ctx, models, id, modelId, config, flags) {
  if (flags.base !== undefined || flags.api !== undefined) {
    throw new Error("--override 只改模型元数据，不支持 --base/--api；要换协议请直接 pmh model add 一条模型条目");
  }
  const patch = modelPatch(flags, { partialCost: true });
  if (!Object.keys(patch).length) {
    throw new Error("--override 至少要指定一个字段：--ctx / --max-output / --reasoning / --no-reasoning / --image / --cost-in / --cost-out / --name");
  }
  const next = { ...(config ?? {}) };
  next.modelOverrides = { ...(next.modelOverrides ?? {}) };
  next.modelOverrides[modelId] = { ...(next.modelOverrides[modelId] ?? {}), ...patch };
  const backup = writeModels(ctx, models, id, next, flags.dryRun);
  if (flags.dryRun) return;
  ok(`已写入 ${id} 的 modelOverrides.${modelId}${backup ? `（备份：${path.basename(backup)}）` : ""}`);
  log(`  覆盖字段：${Object.keys(patch).join(", ")}`);
  info("modelOverrides 只改内置/扩展模型的元数据，不会替换 provider 的模型列表");
}

function modelRemove(ctx, models, id, modelId, config, flags) {
  if (!config) throw new Error(`models.json 里没有 provider "${id}" 的模型条目`);
  const next = { ...config };
  let removed = false;
  if (flags.overrideOnly) {
    if (next.modelOverrides && Object.hasOwn(next.modelOverrides, modelId)) {
      delete next.modelOverrides[modelId];
      removed = true;
    }
  } else {
    const before = next.models?.length ?? 0;
    next.models = (next.models ?? []).filter((m) => m?.id !== modelId);
    if ((next.models?.length ?? 0) !== before) removed = true;
    if (next.modelOverrides && Object.hasOwn(next.modelOverrides, modelId)) {
      delete next.modelOverrides[modelId];
      removed = true;
    }
  }
  if (!removed) throw new Error(`没有找到 ${id}/${modelId}${flags.overrideOnly ? " 的 override" : ""}`);
  if (!next.models?.length) delete next.models;
  if (next.modelOverrides && !Object.keys(next.modelOverrides).length) delete next.modelOverrides;
  const backup = writeModels(ctx, models, id, next, flags.dryRun);
  if (flags.dryRun) return;
  ok(`已移除 ${id}/${modelId}${flags.overrideOnly ? " 的 override" : ""}${backup ? `（备份：${path.basename(backup)}）` : ""}`);
  if (!models.providers[id]) info(`provider "${id}" 已经没有自定义内容，整条配置已清理（内置模型不受影响）`);
  info("在 pi 里打开 /model 会重新加载 models.json");
}

/**
 * Key 管理。兼容 v0.1：`pmh key <relay> <key>` 直接写活动 Key。
 * 新增：add / use / ls / rm 四个子命令，别名存在 auth.json 的 <relay>@<alias>。
 */
export function cmdKey(ctx, args, flags = {}) {
  const [first, second, third, fourth] = args;
  const models = loadModels(ctx);
  const requireRelay = (name) => {
    const id = normalizeProviderName(name);
    if (!models.providers[id]) throw new Error(`没有名为 "${id}" 的 provider，先 pmh add`);
    return id;
  };

  if (first === "ls" || first === "list") {
    const targets = second ? [requireRelay(second)] : Object.keys(models.providers);
    if (!targets.length) return info("还没有 provider，先 pmh add。");
    const auth = loadAuth(ctx);
    const { registry } = loadRegistryState(ctx, { models, auth });
    const rows = [];
    for (const id of targets) {
      const activeAlias = registry.relays[id]?.activeKey ?? "default";
      const list = keyStatus(auth, id, activeAlias);
      if (!list.length) rows.push([id, c.yellow("（无 Key）"), "", ""]);
      for (const entry of list) rows.push([id, entry.alias, entry.masked, entry.active ? c.green("←活动") : ""]);
    }
    heading(`Key 别名（${rows.length} 条）`);
    log(table(rows, ["provider", "别名", "Key", ""]));
    info(`新增：pmh key add <relay> <别名> <key>   切换：pmh key use <relay> <别名>`);
    return;
  }

  if (first === "add") {
    const id = requireRelay(second);
    if (!third || !fourth) throw new Error("用法：pmh key add <relay> <别名> <key>");
    const auth = loadAuth(ctx);
    const { registry } = loadRegistryState(ctx, { models, auth });
    const result = addKeyAlias(auth, id, third, fourth, { registry });
    const backup = writeJson(ctx.paths.auth, auth, { mode: 0o600 });
    saveRegistry(ctx, registry, { backup: false });
    ok(
      `已给 "${id}" 增加 Key 别名 "${result.alias}"${result.active ? "（当前没有活动 Key，已自动启用）" : ""}` +
        `${backup ? `（备份：${path.basename(backup)}）` : ""}`,
    );
    if (!result.active) info(`启用它：pmh key use ${id} ${result.alias}`);
    return;
  }

  if (first === "use") {
    const id = requireRelay(second);
    if (!third) throw new Error("用法：pmh key use <relay> <别名>");
    const auth = loadAuth(ctx);
    const { registry } = loadRegistryState(ctx, { models, auth });
    activateAlias(auth, registry, id, third);
    const backup = writeJson(ctx.paths.auth, auth, { mode: 0o600 });
    saveRegistry(ctx, registry, { backup: false });
    ok(`"${id}" 的活动 Key 已切到 "${third}"${backup ? `（备份：${path.basename(backup)}）` : ""}`);
    info("已开着的 pi 会话在下次请求时生效；无需重启。");
    return;
  }

  if (first === "rm" || first === "remove") {
    const id = requireRelay(second);
    if (!third) throw new Error("用法：pmh key rm <relay> <别名>");
    const auth = loadAuth(ctx);
    const { registry } = loadRegistryState(ctx, { models, auth });
    removeKeyAlias(auth, registry, id, third);
    const backup = writeJson(ctx.paths.auth, auth, { mode: 0o600 });
    saveRegistry(ctx, registry, { backup: false });
    ok(`已删除 "${id}" 的 Key 别名 "${third}"${backup ? `（备份：${path.basename(backup)}）` : ""}`);
    return;
  }

  // v0.1 兼容：pmh key <relay> <key>
  const id = requireRelay(first);
  if (!second) throw new Error("用法：pmh key <provider> <api-key>（或 key add/use/ls/rm）");
  const auth = loadAuth(ctx);
  auth[id] = { ...(auth[id] ?? {}), type: "api_key", key: second };
  const backup = writeJson(ctx.paths.auth, auth, { mode: 0o600 });
  const { registry } = loadRegistryState(ctx, { models, auth });
  if (registry.relays[id]) {
    registry.relays[id].activeKey = "default";
    saveRegistry(ctx, registry, { backup: false });
  }
  ok(`已把 ${id} 的密钥写入 ${ctx.paths.auth}${backup ? `（备份：${path.basename(backup)}）` : ""}`);
}

// ---- 分组 / 收藏 / 最近使用 / 元数据 ----

export function cmdGroup(ctx, args, flags = {}) {
  const sub = args[0] ?? "ls";
  const { registry, models } = loadRegistryState(ctx);
  if (sub === "ls" || sub === "list") {
    const rows = Object.entries(registry.groups)
      .sort((a, b) => a[1].title.localeCompare(b[1].title))
      .map(([id, g]) => [id, g.title, Object.values(registry.relays).filter((r) => r.group === id).length]);
    heading(`分组（${rows.length} 个）`);
    if (!rows.length) info("还没有分组。建一个：pmh group add code --title 写代码");
    else log(table(rows, ["分组", "标题", "站点数"]));
    const ungrouped = Object.values(registry.relays).filter((r) => !r.group).length;
    if (ungrouped) info(`另有 ${ungrouped} 个站点未分组`);
    return;
  }
  if (sub === "add") {
    const name = args[1];
    if (!name) throw new Error("用法：pmh group add <名> [--title 显示名]");
    const group = addGroup(registry, name, { title: flags.title });
    saveRegistry(ctx, registry);
    ok(`已创建分组 "${name}"${group.title !== name ? `（${group.title}）` : ""}`);
    info(`把站点放进去：pmh relay group <relay> ${name}`);
    return;
  }
  if (sub === "rm" || sub === "remove") {
    const name = args[1];
    if (!name) throw new Error("用法：pmh group rm <名>");
    removeGroup(registry, name);
    saveRegistry(ctx, registry);
    ok(`已删除分组 "${name}"（站点保留，变为未分组）`);
    return;
  }
  throw new Error("用法：pmh group ls | add <名> [--title …] | rm <名>");
}

export function cmdRelay(ctx, args) {
  const sub = args[0];
  if (sub !== "group") throw new Error("用法：pmh relay group <relay> <分组|->");
  const [, relay, group] = args;
  if (!relay) throw new Error("用法：pmh relay group <relay> <分组|->");
  const { registry } = loadRegistryState(ctx);
  const result = setRelayGroup(registry, relay, group);
  saveRegistry(ctx, registry);
  ok(result ? `已把 "${relay}" 放进分组 "${result}"` : `已把 "${relay}" 移出分组`);
}

export function cmdFav(ctx, args, flags = {}) {
  const sub = args[0] ?? "ls";
  const { registry, models } = loadRegistryState(ctx);
  if (sub === "ls" || sub === "list") {
    const rows = [];
    for (const relay of Object.values(registry.relays)) {
      const known = new Set((models.providers[relay.id]?.models ?? []).map((m) => m.id));
      for (const model of relay.favorites) {
        rows.push([relay.id, model, known.has(model) ? "" : c.yellow("模型已不在配置里")]);
      }
    }
    heading(`收藏的模型（${rows.length} 个）`);
    if (!rows.length) info("还没有收藏。收藏一个：pmh fav add crow5#sonnet");
    else log(table(rows, ["provider", "模型", ""]));
    return;
  }

  const actions = ["add", "rm", "remove", "toggle"];
  const action = actions.includes(sub) ? sub : "toggle";
  const targetArg = actions.includes(sub) ? args[1] : sub;
  if (!targetArg) throw new Error("用法：pmh fav add|rm <relay>#<模型>");
  const resolved = resolveTarget(ctx, targetArg);
  if (!resolved.provider || !resolved.model) throw new Error(`没有匹配 "${targetArg}" 的模型，先 pmh ls --models 看看`);
  const relayId = resolved.provider;
  const model = resolved.model;
  const changed =
    action === "add"
      ? addFavorite(registry, relayId, model)
      : action === "rm" || action === "remove"
        ? removeFavorite(registry, relayId, model)
        : toggleFavorite(registry, relayId, model);
  if (action === "add" && !changed) {
    info(`${relayId}#${model} 已经在收藏里了`);
    return;
  }
  if ((action === "rm" || action === "remove") && !changed) {
    info(`${relayId}#${model} 本来就不在收藏里`);
    return;
  }
  saveRegistry(ctx, registry);
  const nowFav = isFavorite(registry, relayId, model);
  ok(`${nowFav ? "已收藏" : "已取消收藏"} ${relayId}#${model}`);
}

export function cmdRecent(ctx, flags = {}) {
  const limit = Number(flags.limit ?? 10) || 10;
  const { registry } = loadRegistryState(ctx);
  const rows = recentModels(registry, { limit });
  heading(`最近使用的模型（${rows.length} 个）`);
  if (!rows.length) {
    info("还没有使用记录。用 pmh use / pmh pick / 扩展切换后会记在这里。");
    return;
  }
  log(
    table(
      rows.map((r) => [r.provider, r.model, String(r.at ?? "").slice(0, 16).replace("T", " ")]),
      ["provider", "模型", "时间"],
    ),
  );
  info("直接切到最近一个：pmh use recent:1");
}

const PICK_LABEL = (e) =>
  `${e.provider}/${e.model}${e.name && e.name !== e.model ? `  ${c.dim(truncate(e.name, 28))}` : ""}${
    e.contextWindow ? c.dim(`  ${Math.round(e.contextWindow / 1000)}K`) : ""
  }${e.reasoning ? c.dim("  思考") : ""}`;

/** 选择器排序：收藏 > 最近使用 > 其余（字母序）。 */
function orderEntries(ctx, entries) {
  const { registry } = loadRegistryState(ctx);
  const fav = new Set();
  const recent = new Map();
  for (const relay of Object.values(registry.relays)) {
    for (const m of relay.favorites) fav.add(`${relay.id}#${m}`);
    for (const [i, e] of (relay.mru ?? []).entries()) recent.set(`${relay.id}#${e.model}`, i);
  }
  return [...entries].sort((a, b) => {
    const ka = `${a.provider}#${a.model}`;
    const kb = `${b.provider}#${b.model}`;
    const fa = fav.has(ka) ? 0 : 1;
    const fb = fav.has(kb) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const ra = recent.get(ka) ?? 999;
    const rb = recent.get(kb) ?? 999;
    if (ra !== rb) return ra - rb;
    return ka.localeCompare(kb);
  });
}

function pickMarker(ctx) {
  const settings = loadSettings(ctx);
  const { registry } = loadRegistryState(ctx);
  const fav = new Set();
  for (const relay of Object.values(registry.relays)) {
    for (const m of relay.favorites) fav.add(`${relay.id}#${m}`);
  }
  return (e) => {
    const marks = [];
    if (settings.defaultProvider === e.provider && settings.defaultModel === e.model) marks.push(c.green("←当前默认"));
    if (fav.has(`${e.provider}#${e.model}`)) marks.push(c.yellow("★"));
    return marks.length ? `  ${marks.join(" ")}` : "";
  };
}

function isFilterSpec(spec) {
  return /^@[A-Za-z0-9_.-]+$|^recent(?::\d+)?$/.test(String(spec ?? "").trim());
}

/** "@组 关键词" / "recent 关键词" → { spec, query }；不是这种写法返回 null。 */
function parseFilterQuery(raw) {
  const match = /^(\S+)\s+(.+)$/.exec(String(raw ?? "").trim());
  if (!match || !isFilterSpec(match[1])) return null;
  return { spec: match[1], query: match[2].trim() };
}

/** 在筛选结果里按关键词找模型；唯一命中直接返回，多个则按需让用户选。 */
async function resolveFilterQuery(ctx, filtered) {
  const entries = entriesForSpec(ctx, filtered.spec);
  if (!entries?.length) throw new Error(`筛选 "${filtered.spec}" 没有可用的模型（先分组/收藏，或 pmh ls 查看）`);
  const hits = searchModels(entries, filtered.query);
  if (!hits.length) throw new Error(`"${filtered.query}" 在 ${filtered.spec} 里没有匹配的模型`);
  if (hits.length === 1 || hits[0].model === filtered.query) return hits[0];
  if (!isInteractive()) {
    const top = hits.slice(0, 5).map((h) => `${h.provider}#${h.model}`).join("、");
    throw new Error(`"${filtered.query}" 在 ${filtered.spec} 里匹配 ${hits.length} 个，非交互环境请直接指定：${top}`);
  }
  return pickOne(hits, {
    title: `选择模型（${filtered.spec} 中匹配 "${filtered.query}"）`,
    label: PICK_LABEL,
    marker: pickMarker(ctx),
  });
}

/** @组 / @fav / recent[:N] → 条目列表；不是筛选语法返回 null。 */
function entriesForSpec(ctx, spec) {
  const raw = String(spec ?? "").trim();
  const models = loadModels(ctx);
  const { registry } = loadRegistryState(ctx, { models });
  const fromRelay = (relayId) =>
    (models.providers[relayId]?.models ?? []).map((m) => ({
      provider: relayId, model: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow, reasoning: m.reasoning,
    }));
  if (raw === "@fav") {
    return Object.values(registry.relays).flatMap((relay) => {
      const ids = new Set((models.providers[relay.id]?.models ?? []).map((m) => m.id));
      return relay.favorites.filter((m) => ids.has(m)).flatMap((m) => fromRelay(relay.id).filter((e) => e.model === m));
    });
  }
  if (raw.startsWith("@")) {
    const group = normalizeGroupName(raw.slice(1));
    return Object.values(registry.relays).filter((r) => r.group === group).flatMap((r) => fromRelay(r.id));
  }
  if (/^recent(?::\d+)?$/.test(raw)) {
    const limit = Number(raw.split(":")[1] ?? 10) || 10;
    return recentModels(registry, { limit }).flatMap((r) => fromRelay(r.provider).filter((e) => e.model === r.model));
  }
  return null;
}

/** 展示元数据：配置值、上游值、差异；--verbose 额外打印来源统计。 */
export async function cmdMeta(ctx, name, flags = {}) {
  const models = loadModels(ctx);
  const ids = name ? [normalizeProviderName(name)] : Object.keys(models.providers);
  if (!ids.length) throw new Error("还没有 provider，先 pmh add");
  const { registry } = loadRegistryState(ctx, { models });
  const rows = [];
  const detail = [];

  for (const id of ids) {
    const provider = models.providers[id];
    if (!provider) throw new Error(`没有名为 "${id}" 的 provider`);
    const cred = credentialOf(ctx, id);
    const upstream = new Map();
    let fetchError = null;
    try {
      const res = await fetchModels({ root: rootOf(provider.baseUrl), api: provider.api, key: resolveCredentialKey(cred) });
      if (res.ok) for (const item of res.items) upstream.set(String(item.id), item);
      else fetchError = `HTTP ${res.status}`;
    } catch (err) {
      fetchError = err.message;
    }
    if (fetchError) warn(`${id}: 拉取上游元数据失败（${fetchError}），只显示配置值`);

    for (const m of provider.models ?? []) {
      const up = extractUpstreamMeta(upstream.get(m.id));
      const drift = [];
      if (up) {
        if (up.contextWindow && up.contextWindow !== m.contextWindow) drift.push(`context ${m.contextWindow ?? "?"}→${up.contextWindow}`);
        if (up.maxTokens && up.maxTokens !== m.maxTokens) drift.push(`maxTokens ${m.maxTokens ?? "?"}→${up.maxTokens}`);
        if (up.reasoning !== null && up.reasoning !== m.reasoning) drift.push(`reasoning ${m.reasoning}→${up.reasoning}`);
        if (up.input && JSON.stringify(up.input) !== JSON.stringify(m.input)) drift.push(`input ${m.input?.join("+") ?? "?"}→${up.input.join("+")}`);
        if (up.cost && m.cost && (up.cost.input !== m.cost.input || up.cost.output !== m.cost.output)) {
          drift.push(`price ${m.cost.input}/${m.cost.output}→${up.cost.input}/${up.cost.output}`);
        }
      }
      const row = {
        relay: id,
        model: m.id,
        name: m.name ?? m.id,
        contextWindow: m.contextWindow ?? null,
        maxTokens: m.maxTokens ?? null,
        reasoning: m.reasoning ?? null,
        input: m.input ?? null,
        cost: m.cost ?? null,
        upstream: up,
        drift,
        upstreamModelMissing: Boolean(upstream.size) && !upstream.has(m.id),
      };
      detail.push(row);
      if (flags.drift && !drift.length) continue;
      rows.push([
        id,
        truncate(m.id, 40),
        m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K` : "—",
        m.maxTokens ?? "—",
        m.reasoning ? "是" : "否",
        m.input?.includes("image") ? "text+image" : "text",
        m.cost ? `${m.cost.input}/${m.cost.output}` : "—",
        drift.length ? c.yellow(truncate(drift.join("; "), 52)) : "",
      ]);
    }

    const configured = new Set((provider.models ?? []).map((m) => m.id));
    for (const [modelId] of upstream) {
      if (configured.has(modelId)) continue;
      detail.push({ relay: id, model: modelId, missing: true, drift: ["配置里没有（pmh sync 可补上）"] });
      if (!flags.drift) rows.push([id, truncate(modelId, 40), "—", "—", "—", "—", "—", c.yellow("配置里没有")]);
    }
  }

  if (flags.json) {
    log(JSON.stringify(detail, null, 2));
    return;
  }
  heading(flags.drift ? "元数据差异" : "模型元数据（配置值）");
  if (!rows.length) return info(flags.drift ? "配置与上游一致，没有差异。" : "没有模型。先 pmh sync <relay>");
  log(table(rows, ["provider", "模型", "上下文", "最大输出", "推理", "输入", "价格$/M", "差异"]));
  if (flags.verbose) {
    for (const [id, relay] of Object.entries(registry.relays)) {
      if (name && id !== normalizeProviderName(name)) continue;
      const stats = relay.metaSources ?? {};
      const summary = Object.entries(stats)
        .map(([field, counts]) => {
          const text = Object.entries(counts).map(([src, n]) => `${src}×${n}`).join(", ");
          return `${field}: ${text}`;
        })
        .join("；");
      if (summary) log(`\n${c.dim(`${id} 上次同步来源`)} ${summary}`);
    }
    info("上游列：--json 会带上每个模型的 upstream 原始抽取结果。");
  } else {
    info("看上游与配置的差异：pmh meta <relay> --drift");
  }
}

// ---- 批量导入 ----

function maskItem(item) {
  return { ...item, key: item.key ? maskKey(item.key) : null };
}

async function collectImportSources(sources, flags) {
  const chunks = [];
  const errors = [];
  const push = (label, text) => {
    if (text && String(text).trim()) chunks.push({ label, text: String(text) });
  };
  const readFile = (file) => {
    try {
      push(file, fs.readFileSync(file, "utf8"));
    } catch (err) {
      errors.push(`读取文件 ${file} 失败：${err.message}`);
    }
  };

  for (const raw of sources) {
    const value = String(raw);
    if (value === "-") {
      try {
        push("stdin", fs.readFileSync(0, "utf8"));
      } catch (err) {
        errors.push(`读取 stdin 失败：${err.message}`);
      }
    } else if (isUrl(value)) {
      try {
        push(value, await fetchText(value));
      } catch (err) {
        errors.push(`订阅 ${value}：${err.message}`);
      }
    } else if (!value.includes("\n") && value.length < 1024 && fs.existsSync(value) && fs.statSync(value).isFile()) {
      readFile(value);
    } else {
      push("参数", value);
    }
  }
  for (const file of [].concat(flags.file ?? [])) readFile(file);

  const from = [].concat(flags.from ?? []).flatMap((v) => String(v).split(",").map((s) => s.trim()).filter(Boolean));
  if (from.includes("all")) from.push("claude", "codex", "ccswitch", "clipboard");
  for (const source of from) {
    if (source === "claude") {
      const found = collectFromClaude();
      if (!found.items.length) errors.push("Claude Code 配置里没发现可导入的端点（只看了 settings.json / settings.local.json / ~/.claude.json 的 env）");
      else {
        push("claude", JSON.stringify({ relays: found.items }));
        info(`从 Claude Code 配置读到 ${found.items.length} 项：${found.files.join(", ")}`);
      }
    } else if (source === "codex") {
      const found = collectFromCodex();
      if (!found.items.length) errors.push("Codex 配置里没发现 [model_providers.*] 端点（~/.codex/config.toml）");
      else {
        push("codex", JSON.stringify({ relays: found.items }));
        info(`从 Codex 配置读到 ${found.items.length} 项：${found.files.join(", ")}`);
      }
    } else if (source === "ccswitch") {
      const found = collectFromCcswitch();
      if (!found.items.length) {
        errors.push(
          found.hasDatabase
            ? "cc-switch v4 把配置存进 SQLite（~/.cc-switch/cc-switch.db），暂不支持读取；请在 cc-switch 里用「分享」生成 ccswitch:// 链接再导入"
            : "cc-switch 旧版配置（~/.cc-switch/config.json）里没发现可导入的供应商",
        );
      } else {
        push("ccswitch", JSON.stringify({ relays: found.items }));
        info(`从 cc-switch 配置读到 ${found.items.length} 项：${found.files.join(", ")}`);
      }
    } else if (source === "clipboard") {
      const text = readClipboard();
      if (!text.trim()) errors.push("剪贴板是空的");
      else push("剪贴板", text);
    } else {
      errors.push(`未知来源 "${source}"（可选 clipboard / claude / codex / ccswitch / all）`);
    }
  }

  if (!chunks.length && !errors.length) {
    const text = readClipboard();
    if (text.trim()) push("剪贴板", text);
    else errors.push("剪贴板是空的；也可以传文件/URL，或用 --from claude|codex|ccswitch");
  }
  return { chunks, errors };
}

function printImportPreview(items, flags) {
  if (flags.json) {
    log(JSON.stringify(items.map(maskItem), null, 2));
    return;
  }
  heading(`准备导入（${items.length} 项）`);
  log(
    table(
      items.map((i) => [
        i.name,
        truncate(i.baseUrl, 40),
        i.key ? maskKey(i.key) : c.yellow("无 Key"),
        i.api,
        i.group ?? "—",
        i.aliasOf
          ? `Key 别名 → ${i.aliasOf}`
          : i.renamedFrom
            ? c.yellow(`重名 → ${i.name}`)
            : i.existing
              ? c.yellow("更新")
              : "新增",
        i.source,
      ]),
      ["名称", "地址", "Key", "API", "分组", "动作", "来源"],
    ),
  );
}

/** 把同站不同 Key 的条目写成现有 provider 的 Key 别名。 */
function importAlias(ctx, item) {
  const models = loadModels(ctx);
  const target = models.providers[item.aliasOf];
  if (!target) {
    warn(`${item.name}: 同站目标 "${item.aliasOf}" 不存在，跳过`);
    return false;
  }
  if (!item.key) {
    warn(`${item.name}: 同站但没有 Key，跳过`);
    return false;
  }
  const auth = loadAuth(ctx);
  const { registry } = loadRegistryState(ctx, { models, auth });
  const base = String(item.name).replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "backup";
  let alias = /^[A-Za-z0-9_-]{1,32}$/.test(base) && base.toLowerCase() !== "default" ? base : "backup";
  // 先在 base 后面腾出后缀位置再截断，否则 32 字符的 base 会一直算出同一个名字。
  for (let n = 2; keyOf(auth, item.aliasOf, alias); n += 1) {
    if (n > 1000) throw new Error(`找不到可用的 Key 别名（base: ${base}）`);
    const suffix = `-${n}`;
    alias = `${base.slice(0, 32 - suffix.length)}${suffix}`;
  }
  try {
    addKeyAlias(auth, item.aliasOf, alias, item.key, { registry });
  } catch (err) {
    fail(`${item.name}: ${err.message}`);
    return false;
  }
  const backup = writeJson(ctx.paths.auth, auth, { mode: 0o600 });
  saveRegistry(ctx, registry, { backup: false });
  ok(`已把 ${item.name} 的 Key 存为 "${item.aliasOf}" 的别名 "${alias}"${backup ? `（备份：${path.basename(backup)}）` : ""}`);
  return true;
}

async function applyImport(ctx, items, flags) {
  let added = 0;
  let aliased = 0;
  let failed = 0;
  for (const item of items) {
    try {
      if (item.aliasOf) {
        if (importAlias(ctx, item)) aliased += 1;
        continue;
      }
      await cmdAdd(ctx, item.name, {
        ...flags,
        base: item.baseUrl,
        key: item.key ?? undefined,
        api: item.api,
        model: item.models?.length ? item.models.join(",") : flags.model,
        group: item.group ?? flags.group,
        tag: item.tags ?? flags.tag,
        source: item.source,
        yes: true,
        force: true,
        batch: true,
        noKey: !item.key,
      });
      added += 1;
    } catch (err) {
      failed += 1;
      fail(`${item.name}: ${err.message}`);
    }
  }

  const { registry, changed } = loadRegistryState(ctx);
  if (changed) saveRegistry(ctx, registry, { backup: false });

  heading("导入完成");
  log(`  新增/更新 ${added} 项，Key 别名 ${aliased} 项，失败 ${failed} 项`);
  if (added) {
    info("切换：pmh pick / pmh use <名称>#<模型>；在 pi 里用 /switch");
    info("体检：pmh ls / pmh meta <名称> --drift");
  }
}

export async function cmdImport(ctx, sources, flags = {}) {
  const { chunks, errors } = await collectImportSources(sources, flags);
  for (const err of errors) warn(err);

  const items = [];
  for (const chunk of chunks) {
    const parsed = parseImportText(chunk.text, { source: chunk.label });
    for (const err of parsed.errors) warn(`${chunk.label}: ${err}`);
    items.push(...parsed.items);
  }
  if (!items.length) {
    warn("没有解析出任何可导入的站点。");
    info(`支持的格式：地址+Key、JSON、JSONL、env、YAML、curl、pmh:// / ccswitch:// 链接、base64 订阅、Claude Code / Codex / cc-switch 配置`);
    return;
  }

  const models = loadModels(ctx);
  const deduped = dedupeItems(items, { providers: models.providers, force: Boolean(flags.force) });
  for (const item of deduped) {
    item.existing = Boolean(models.providers[item.name]) || Boolean(item.aliasOf);
  }

  printImportPreview(deduped, flags);
  if (flags.dryRun || flags.scan) {
    info("只预览，没有写入。");
    return;
  }
  if (!isInteractive() && !flags.yes) {
    info("要写入请加 --yes（或在交互终端里运行）。");
    return;
  }
  if (isInteractive() && !flags.yes && !(await askConfirm(`把这 ${deduped.length} 项写进 pi 配置吗？`, { defaultValue: false }))) {
    return info("已取消。");
  }
  await applyImport(ctx, deduped, flags);
}

export function cmdLs(ctx, flags = {}) {
  const models = loadModels(ctx);
  const settings = loadSettings(ctx);
  const store = readJson(ctx.paths.modelsStore, {});
  const { registry } = loadRegistryState(ctx, { models });
  const filterGroup = flags.group ? normalizeGroupName(flags.group) : null;

  if (flags.json) {
    const relays = Object.entries(models.providers)
      .filter(([id]) => !filterGroup || registry.relays[id]?.group === filterGroup)
      .map(([id, provider]) => {
        const relay = registry.relays[id] ?? {};
        return {
          id,
          baseUrl: provider.baseUrl ?? "",
          api: provider.api ?? "openai-completions",
          group: relay.group ?? null,
          tags: relay.tags ?? [],
          favorites: relay.favorites ?? [],
          activeKey: relay.activeKey ?? null,
          modelCount: (provider.models ?? []).length,
          models: (provider.models ?? []).map((m) => ({
            id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens,
            reasoning: m.reasoning, input: m.input, cost: m.cost,
          })),
          credential: credentialOf(ctx, id).kind,
        };
      });
    log(JSON.stringify({ defaultProvider: settings.defaultProvider ?? null, defaultModel: settings.defaultModel ?? null, relays }, null, 2));
    return;
  }

  const rows = [];
  for (const [id, provider] of Object.entries(models.providers)) {
    const relay = registry.relays[id];
    if (filterGroup && relay?.group !== filterGroup) continue;
    const cred = credentialOf(ctx, id);
    const isDefault = settings.defaultProvider === id;
    const favCount = relay?.favorites?.length ? ` ${c.yellow(`★${relay.favorites.length}`)}` : "";
    rows.push([
      isDefault ? `${id} ${c.green("←默认")}` : id,
      relay?.group ?? "—",
      truncate(provider.baseUrl ?? "", 38),
      provider.api ?? "openai-completions",
      (provider.models ?? []).length || "—",
      cred.value ? cred.kind : c.yellow(cred.kind),
      `${(store[id]?.models ?? store[id] ?? []).length ? "pi 已缓存" : ""}${favCount}`,
    ]);
  }
  heading(filterGroup ? `分组 "${filterGroup}" 下的 provider（${rows.length} 个）` : `pi 配置里的自定义 provider（${rows.length} 个）`);
  if (!rows.length) {
    if (filterGroup) info(`分组 "${filterGroup}" 里还没有站点。加一个：pmh relay group <relay> ${filterGroup}`);
    else info("还没有。用 pmh add <名称> --base <地址> --key <key> 添加一个中转站。");
  } else {
    log(table(rows, ["provider", "分组", "baseUrl", "API", "模型数", "凭据", "状态"]));
  }
  const auth = loadAuth(ctx);
  const builtinAuth = Object.keys(auth).filter((k) => !models.providers[k] && !k.includes("@"));
  if (builtinAuth.length) {
    log("");
    log(`${c.dim("内置 provider 已登录：")} ${builtinAuth.join(", ")}`);
  }
  log("");
  log(`默认模型：${settings.defaultProvider ? `${settings.defaultProvider}/${settings.defaultModel ?? "?"}` : c.dim("未设置（pi 自行选择）")}`);
  if (flags.models) {
    heading("模型明细");
    for (const [id, provider] of Object.entries(models.providers)) {
      if (filterGroup && registry.relays[id]?.group !== filterGroup) continue;
      const list = (provider.models ?? []).map((m) => m.id);
      if (list.length) log(`  ${c.bold(id)}: ${list.join(", ")}`);
    }
  }
}

function formatContext(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
}

/** 快速看当前默认模型（纯本地，不发请求），适合写进 shell 提示符或脚本。 */
export function cmdCurrent(ctx, flags = {}) {
  const models = loadModels(ctx);
  const settings = loadSettings(ctx);
  const { registry } = loadRegistryState(ctx, { models });

  let provider = settings.defaultProvider ?? null;
  let model = settings.defaultModel ?? null;
  let source = provider ? "settings" : null;
  if (!provider) {
    const recent = recentModels(registry, { limit: 1 })[0];
    if (recent) {
      provider = recent.provider;
      model = recent.model;
      source = "recent";
    }
  }

  if (!provider) {
    if (flags.json) {
      log(JSON.stringify({ provider: null, model: null, source: null, configured: false }));
      return;
    }
    return info("还没有默认模型。用 pmh quick / pmh add 接入，或 pmh use <模型> 设置。");
  }

  const relay = registry.relays?.[provider] ?? null;
  const configured = Boolean(models.providers?.[provider]);
  const entry = (models.providers?.[provider]?.models ?? []).find((m) => m.id === model) ?? null;
  const cred = credentialOf(ctx, provider);

  if (typeof flags.format === "string" && flags.format.trim()) {
    const vars = {
      provider,
      model: model ?? "",
      thinking: settings.defaultThinkingLevel ?? "",
      key: relay?.activeKey ?? "default",
      group: relay?.group ?? "",
      ctx: formatContext(entry?.contextWindow) ?? "",
      source: source ?? "",
    };
    log(flags.format.replace(/\{\{(\w+)\}\}/g, (all, name) => (Object.hasOwn(vars, name) ? vars[name] : all)));
    return;
  }

  if (flags.json) {
    log(
      JSON.stringify(
        {
          provider,
          model,
          source,
          configured,
          thinkingLevel: settings.defaultThinkingLevel ?? null,
          baseUrl: models.providers?.[provider]?.baseUrl ?? null,
          api: models.providers?.[provider]?.api ?? null,
          contextWindow: entry?.contextWindow ?? null,
          maxTokens: entry?.maxTokens ?? null,
          reasoning: entry?.reasoning ?? null,
          input: entry?.input ?? null,
          cost: entry?.cost ?? null,
          credential: cred.kind,
          keyAlias: relay?.activeKey ?? null,
          group: relay?.group ?? null,
          favorite: model ? (relay?.favorites ?? []).includes(model) : false,
        },
        null,
        2,
      ),
    );
    return;
  }

  const label = `${provider}${model ? `/${model}` : ""}`;
  const meta = [];
  const ctxWindow = formatContext(entry?.contextWindow);
  if (ctxWindow) meta.push(ctxWindow);
  if (entry?.reasoning) meta.push("思考");
  if (entry?.input?.includes("image")) meta.push("图片");
  if (settings.defaultThinkingLevel) meta.push(`thinking:${settings.defaultThinkingLevel}`);
  if (relay?.activeKey) meta.push(`key:${relay.activeKey}`);
  if (relay?.group) meta.push(`@${relay.group}`);
  if (model && (relay?.favorites ?? []).includes(model)) meta.push("★");
  if (!configured) meta.push("内置/未在 models.json");
  log(`${c.bold(label)}${meta.length ? c.dim(`  ·  ${meta.join("  ·  ")}`) : ""}`);
  if (source === "recent") {
    info(`settings.json 里没有默认模型；这是最近一次主动切换的结果（pi 启动时也可能自行选择）。`);
  }
  if (models.providers?.[provider]?.baseUrl) log(c.dim(models.providers[provider].baseUrl));
}

/** 所有已配置的 provider/model 条目，用于模糊匹配与选择器。 */
function allEntries(ctx) {
  const models = loadModels(ctx);
  const out = [];
  for (const [provider, p] of Object.entries(models.providers)) {
    for (const m of p.models ?? []) {
      out.push({ provider, model: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow, reasoning: m.reasoning });
    }
  }
  const auth = loadAuth(ctx);
  for (const provider of Object.keys(models.providers)) {
    if (!out.some((e) => e.provider === provider)) {
      out.push({ provider, model: null, name: auth[provider] ? "(已配密钥，等待同步模型)" : "（尚未配密钥）" });
    }
  }
  return out;
}

/**
 * 把用户输入解析成 provider/model。
 * 支持：crow5（只给 provider）、crow5#sonnet（provider 内模糊）、sonnet（全局模糊）。
 */
function resolveTarget(ctx, target) {
  const models = loadModels(ctx);
  const raw = String(target ?? "").trim();
  if (!raw) return { provider: null, model: null };
  const explicit = /^([^#/]+)[#/](.+)$/.exec(raw);
  if (explicit && models.providers[explicit[1]]) {
    const provider = explicit[1];
    const q = explicit[2].trim();
    const entries = (models.providers[provider].models ?? []).map((m) => ({ provider, model: m.id, name: m.name ?? m.id }));
    const hits = searchModels(entries, q);
    if (!hits.length) return { provider, model: q, exact: true };
    return { provider, model: hits[0].model, hits, query: q, exact: hits[0].model === q };
  }
  if (models.providers[raw]) return { provider: raw, model: null, exact: true };
  const hits = searchModels(allEntries(ctx).filter((e) => e.model), raw);
  if (!hits.length) return { provider: null, model: null, hits: [], query: raw };
  return { provider: hits[0].provider, model: hits[0].model, hits, query: raw, exact: hits[0].model === raw };
}

function reportAlternatives(resolved, usedLabel) {
  if (!resolved.hits || resolved.hits.length <= 1) return;
  const others = resolved.hits.slice(1, 5).map((h) => `${h.provider}#${h.model}`);
  info(`"${resolved.query}" 还匹配到 ${resolved.hits.length - 1} 个，已用最贴近的 ${usedLabel}；其他：${others.join("、")}`);
}

export async function cmdUse(ctx, target, flags) {
  if (String(target ?? "").trim() === "-") {
    const { registry, models, auth } = loadRegistryState(ctx);
    const settings = loadSettings(ctx);
    const currentKey = `${settings.defaultProvider ?? ""}#${settings.defaultModel ?? ""}`;
    const skipped = [];
    let entry = null;
    while ((registry.history ?? []).length) {
      const candidate = takeDefaultHistory(registry);
      if (!candidate?.provider) continue;
      const key = `${candidate.provider}#${candidate.model ?? ""}`;
      if (key === currentKey) continue;
      const provider = models.providers?.[candidate.provider];
      if (!provider && !auth?.[candidate.provider] && !flags.allowBuiltin) {
        skipped.push(key);
        continue;
      }
      const known = (provider?.models ?? []).map((m) => m.id);
      if (candidate.model && known.length && !known.includes(candidate.model)) {
        skipped.push(key);
        continue;
      }
      entry = candidate;
      break;
    }
    if (!entry) {
      throw new Error("没有可回退的默认模型（先 pmh use <模型> 切一次，之后 pmh use - 就能切回来）");
    }
    saveRegistry(ctx, registry, { backup: false });
    if (skipped.length) warn(`已跳过失效的历史项：${skipped.join("、")}`);
    return cmdUse(ctx, `${entry.provider}${entry.model ? `#${entry.model}` : ""}`, flags);
  }
  if (!target) {
    const entries = orderEntries(ctx, allEntries(ctx).filter((e) => e.model));
    if (!entries.length) throw new Error("还没有可选的模型，先 pmh add 一个中转站");
    const chosen = await pickOne(entries, { title: "设为默认模型", label: PICK_LABEL, marker: pickMarker(ctx) });
    if (!chosen) return info("已取消。");
    return cmdUse(ctx, `${chosen.provider}#${chosen.model}`, flags);
  }
  if (isFilterSpec(target)) {
    const entries = entriesForSpec(ctx, target);
    if (!entries?.length) throw new Error(`筛选 "${target}" 没有可用的模型（先分组/收藏，或 pmh ls 查看）`);
    if (!isInteractive()) throw new Error("筛选切换需要交互终端；也可以直接指定 provider#model");
    const chosen = await pickOne(orderEntries(ctx, entries), { title: `选择模型（${target}）`, label: PICK_LABEL, marker: pickMarker(ctx) });
    if (!chosen) return info("已取消。");
    return cmdUse(ctx, `${chosen.provider}#${chosen.model}`, flags);
  }
  const filtered = parseFilterQuery(target);
  if (filtered) {
    const chosen = await resolveFilterQuery(ctx, filtered);
    if (!chosen) return info("已取消。");
    return cmdUse(ctx, `${chosen.provider}#${chosen.model}`, flags);
  }
  const resolved = resolveTarget(ctx, target);
  const { provider, model } = resolved;
  const models = loadModels(ctx);
  const settings = loadSettings(ctx);
  const previousDefault = { provider: settings.defaultProvider ?? null, model: settings.defaultModel ?? null };
  if (provider) {
    if (!models.providers[provider] && !flags.allowBuiltin) {
      warn(`"${provider}" 不在 models.json 里（内置厂商请加 --allow-builtin）`);
    }
    settings.defaultProvider = provider;
    if ((!model || model === "*") && models.providers[provider]) {
      const ids = (models.providers[provider].models ?? []).map((m) => m.id);
      let next = settings.defaultModel && ids.includes(settings.defaultModel) ? settings.defaultModel : null;
      if (!next) {
        try {
          const last = loadRegistryState(ctx, { models }).registry.relays?.[provider]?.lastModel;
          if (last && ids.includes(last)) next = last;
        } catch {
          /* 注册表异常时退回第一个模型 */
        }
      }
      next ??= ids[0] ?? null;
      if (next) settings.defaultModel = next;
      else delete settings.defaultModel;
    }
  } else {
    warn(`没有匹配 "${target}" 的模型，可以用 pmh ls --models 看看有哪些`);
    return;
  }
  if (model && model !== "*") settings.defaultModel = model;
  if (flags.thinking) settings.defaultThinkingLevel = flags.thinking;
  const backup = writeJson(ctx.paths.settings, settings);
  try {
    const { registry } = loadRegistryState(ctx, { models });
    let touched = false;
    if (model && model !== "*" && models.providers[provider]) {
      touched = recordUse(registry, provider, model) || touched;
    }
    const changed = previousDefault.provider !== (settings.defaultProvider ?? null) ||
      previousDefault.model !== (settings.defaultModel ?? null);
    if (previousDefault.provider && changed) {
      touched = recordDefaultHistory(registry, previousDefault) || touched;
    }
    if (touched) saveRegistry(ctx, registry, { backup: false });
  } catch {
    /* 注册表异常不影响切换 */
  }
  ok(
    `默认模型已设为 ${c.bold(`${settings.defaultProvider ?? "?"}${settings.defaultModel ? `/${settings.defaultModel}` : ""}`)}` +
      `${flags.thinking ? `，思考级别 ${flags.thinking}` : ""}${backup ? `（备份：${path.basename(backup)}）` : ""}`,
  );
  reportAlternatives(resolved, `${provider}/${model}`);
  info("已开着的 pi 会话里按 Ctrl+P 或 /model 也能立即切；下次启动默认用这个。pmh use - 可切回上一个。");
}

export function cmdScope(ctx, patterns, flags) {
  const settings = loadSettings(ctx);
  if (flags.clear || !patterns.length) {
    delete settings.enabledModels;
  } else {
    settings.enabledModels = patterns;
  }
  const backup = writeJson(ctx.paths.settings, settings);
  ok(
    settings.enabledModels
      ? `Ctrl+P 循环范围已限定为：${settings.enabledModels.join(", ")}${backup ? `（备份：${path.basename(backup)}）` : ""}`
      : "已清除 Ctrl+P 循环范围限制（恢复为全部可用模型）。",
  );
}

/** 找出仍然包含指定凭据的旧备份文件（用于 --purge-key 后的清理提示）。 */
function backupsContaining(file, needles) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-`;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(prefix))
    .map((n) => path.join(dir, n))
    .filter((p) => {
      try {
        const text = fs.readFileSync(p, "utf8");
        return needles.some((needle) => text.includes(needle));
      } catch {
        return false;
      }
    });
}

export function cmdRm(ctx, name, flags) {
  const id = normalizeProviderName(name);
  const models = loadModels(ctx);
  if (!models.providers[id]) throw new Error(`没有名为 "${id}" 的 provider`);
  delete models.providers[id];
  const backup = writeJson(ctx.paths.models, models);
  ok(`已从 models.json 移除 "${id}"${backup ? `（备份：${path.basename(backup)}）` : ""}`);

  const settings = loadSettings(ctx);
  let settingsChanged = false;
  if (settings.defaultProvider === id) {
    delete settings.defaultProvider;
    delete settings.defaultModel;
    settingsChanged = true;
  }
  if (Array.isArray(settings.enabledModels)) {
    const kept = settings.enabledModels.filter((p) => {
      const text = String(p);
      return text !== id && !text.startsWith(`${id}/`);
    });
    if (kept.length !== settings.enabledModels.length) {
      if (kept.length) settings.enabledModels = kept;
      else delete settings.enabledModels;
      settingsChanged = true;
    }
  }
  if (settingsChanged) {
    const settingsBackup = writeJson(ctx.paths.settings, settings);
    ok(`已清理 settings.json 里指向 "${id}" 的默认值与循环范围${settingsBackup ? `（备份：${path.basename(settingsBackup)}）` : ""}`);
  }

  const { registry } = loadRegistryState(ctx, { models });
  let registryTouched = removeRelay(registry, id);
  const beforeHistory = (registry.history ?? []).length;
  registry.history = (registry.history ?? []).filter((e) => e.provider !== id);
  if (registry.history.length !== beforeHistory) registryTouched = true;
  if (registryTouched) saveRegistry(ctx, registry, { backup: false });

  if (flags.purgeKey) {
    const auth = loadAuth(ctx);
    let removed = 0;
    const removedKeys = [];
    if (auth[id]) {
      delete auth[id];
      removed += 1;
      removedKeys.push(id);
    }
    for (const key of Object.keys(auth)) {
      if (key.startsWith(`${id}@`)) {
        delete auth[key];
        removed += 1;
        removedKeys.push(key);
      }
    }
    if (removed) {
      // 不备份：备份里同样含刚删除的 Key，等于没删干净
      writeJson(ctx.paths.auth, auth, { backup: false, mode: 0o600 });
      ok(`同时删除了 auth.json 里的 ${removed} 条凭据（含 Key 别名），未生成新备份`);
    }

    const needles = [`"${id}"`, ...removedKeys.map((key) => `"${key}"`)];
    const stale = backupsContaining(ctx.paths.auth, needles);
    if (stale.length && flags.purgeBackups) {
      let purged = 0;
      for (const file of stale) {
        try {
          fs.unlinkSync(file);
          purged += 1;
        } catch (err) {
          warn(`删除备份失败 ${path.basename(file)}：${err.message}`);
        }
      }
      if (purged) ok(`已清理 ${purged} 个含该站凭据的旧备份`);
    } else if (stale.length) {
      warn(`还有 ${stale.length} 个旧备份包含该站凭据（${stale.slice(0, 3).map((f) => path.basename(f)).join("、")}${stale.length > 3 ? " 等" : ""}）`);
      info(`要一并删除：pmh rm ${id} --purge-key --purge-backups`);
    }
  } else {
    info(`auth.json 里的密钥保留了。要一起删：pmh rm ${id} --purge-key`);
  }
}

export async function cmdTest(ctx, name, flags) {
  const id = normalizeProviderName(name);
  const models = loadModels(ctx);
  const provider = models.providers[id];
  if (!provider) throw new Error(`没有名为 "${id}" 的 provider，先 pmh add`);
  const cred = credentialOf(ctx, id);
  const api = provider.api ?? "openai-completions";
  const root = rootOf(provider.baseUrl);
  heading(`体检：${id}`);
  log(`  地址   ${root}`);
  log(`  API    ${api}`);
  log(`  凭据   ${cred.kind}${cred.value || cred.command ? "" : c.yellow("（不可用）")}`);

  let key = null;
  try {
    key = resolveCredentialKey(cred);
  } catch (err) {
    fail(err.message);
    return;
  }
  const res = await fetchModels({ root, api, key });
  if (res.ok && res.ids.length) ok(`GET /v1/models 正常：${res.ids.length} 个模型`);
  else if (res.ok) warn(`GET /v1/models 返回 200 但没有模型列表`);
  else fail(`GET /v1/models 返回 ${res.status}${flags.verbose ? `: ${res.raw}` : ""}`);

  if (res.ids.length) {
    const configured = new Set((provider.models ?? []).map((m) => m.id));
    const missing = res.ids.filter((mid) => !configured.has(mid));
    if (missing.length) warn(`有 ${missing.length} 个模型上市了但还没写进配置（pmh sync ${id}）：${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`);
    else ok("配置里的模型与网关返回一致");
  }

  if (flags.chat !== false) {
    const model = flags.model ?? (provider.models?.[0]?.id ?? res.ids[0]);
    if (!model) warn("没有可用于试聊的模型");
    else {
      const api2 = provider.models?.find((m) => m.id === model)?.api ?? api;
      try {
        const probe = await probeChat({ root, api: api2, key, model });
        if (probe.ok) ok(`试聊成功：${model}（${probe.ms} ms）→ ${truncate(probe.text ?? "(空回复)", 60)}`);
        else fail(`试聊失败：${model} HTTP ${probe.status} ${truncate(probe.error ?? "", 200)}`);
      } catch (err) {
        fail(`试聊异常：${err.message}`);
      }
    }
  }
}

export async function cmdRun(ctx, target, piArgs, flags) {
  const launcher = findPiLauncher(ctx.agentDir);
  if (!launcher) throw new Error("没找到 pi 启动器，检查 ~/.pi/agent/bin/pi.cmd 是否在，或用 PMH_PI_BIN 指定");

  if (target && isFilterSpec(target)) {
    const entries = entriesForSpec(ctx, target);
    if (!entries?.length) throw new Error(`筛选 "${target}" 没有可用的模型`);
    if (!isInteractive()) throw new Error("筛选启动需要交互终端；也可以直接指定 provider#model");
    const chosen = await pickOne(orderEntries(ctx, entries), { title: `选择模型并启动 pi（${target}）`, label: PICK_LABEL, marker: pickMarker(ctx) });
    if (!chosen) return;
    return cmdRun(ctx, `${chosen.provider}#${chosen.model}`, piArgs, flags);
  }

  const filtered = parseFilterQuery(target);
  if (filtered) {
    const chosen = await resolveFilterQuery(ctx, filtered);
    if (!chosen) return;
    return cmdRun(ctx, `${chosen.provider}#${chosen.model}`, piArgs, flags);
  }

  const resolved = resolveTarget(ctx, target);
  const { provider, model } = resolved;
  if (!provider && target) {
    warn(`没有匹配 "${target}" 的模型，直接启动 pi（可 pmh ls --models 查看可用项）`);
  }
  if (provider && model) {
    try {
      const { registry } = loadRegistryState(ctx);
      if (recordUse(registry, provider, model)) saveRegistry(ctx, registry, { backup: false });
    } catch {
      /* 记录失败不影响启动 */
    }
  }
  const args = [...(provider ? ["--provider", provider] : []), ...(model ? ["--model", model] : []), ...piArgs];
  info(`启动 pi：${args.join(" ")}`);
  if (launcher.fromPath) info(`没在常见位置找到 pi，交给 PATH 里的 "pi" 启动`);
  const res = launcherNeedsShell(launcher)
    ? spawnSync([launcherCommand(launcher), ...args.map((a) => quoteShellArg(a))].join(" "), {
        stdio: "inherit",
        shell: true,
      })
    : spawnSync(launcherCommand(launcher), args, { stdio: "inherit" });
  process.exit(res.status ?? 0);
}

const AUTO_EXT_SOURCE = path.join(REPO_ROOT, "extensions", "auto-router");

/** 复制扩展文件；内容未变就不动，避免无意义的备份堆积。 */
function copyExtensionFile(source, dest) {
  if (fs.existsSync(dest)) {
    if (fs.readFileSync(dest).equals(fs.readFileSync(source))) return false;
    fs.copyFileSync(dest, `${dest}.bak-${Date.now()}`);
  }
  fs.copyFileSync(source, dest);
  return true;
}

function installAutoExtension(ctx, scope = "full") {
  if (!fs.existsSync(AUTO_EXT_SOURCE)) throw new Error(`找不到自动选模型扩展：${AUTO_EXT_SOURCE}`);
  const destDir = path.join(ctx.agentDir, "extensions", "pmh-auto");
  fs.mkdirSync(destDir, { recursive: true });
  const changed = [];
  for (const file of ["index.js", "router.mjs", "compat.mjs"]) {
    const source = path.join(AUTO_EXT_SOURCE, file);
    if (!fs.existsSync(source)) throw new Error(`扩展缺少文件：${source}`);
    if (copyExtensionFile(source, path.join(destDir, file))) changed.push(file);
  }
  writeSourceMarker(ctx.agentDir, { repoRoot: REPO_ROOT, mode: "copy", ...(scope === "auto" ? { scope } : {}) });
  return { destDir, changed };
}

function autoTargetWarning(ctx, spec) {
  if (spec.provider === AUTO_PROVIDER && spec.model === AUTO_MODEL) return "不能把 pmh/auto 自己设成档位模型";
  const models = loadModels(ctx);
  const builtins = loadBuiltinProviders(ctx.agentDir).providers;
  const provider = models.providers[spec.provider];
  if (!provider && !builtins.has(spec.provider)) {
    return `provider "${spec.provider}" 不在 models.json，也不是 pi 内置 provider`;
  }
  const ids = (provider?.models ?? []).map((m) => m?.id).filter(Boolean);
  if (ids.length && !ids.includes(spec.model)) {
    return `provider "${spec.provider}" 的 models 里没有 "${spec.model}"（pi 可能仍从内置目录解析，请确认能被 /model 选到）`;
  }
  return null;
}

/** pmh auto：配置“按任务难度自动选模型”的档位，扩展读取同一份配置。 */
export function cmdAuto(ctx, args, flags = {}) {
  const rest = args[0] === "auto" ? args.slice(1) : args;
  const subRaw = rest.shift() ?? "status";
  const sub = subRaw === "ls" ? "status" : subRaw;
  const config = readAutoConfig(ctx.agentDir);
  const save = (next) => writeAutoConfig(next, ctx.agentDir);

  if (sub === "status" || sub === "doctor") {
    const compat = checkCompat(ctx.agentDir);
    const marker = readSourceMarker(ctx.agentDir);
    const sourceRoot = marker?.repoRoot ?? REPO_ROOT;
    const repoOk = repoAvailable(sourceRoot);
    const mode = installedMode(ctx.agentDir, REPO_ROOT);
    const stale = mode === "copy" && repoOk ? staleCopies(ctx.agentDir, sourceRoot, marker?.scope) : [];
    const payload = {
      enabled: config.enabled,
      pinned: config.pinned,
      tiers: config.tiers,
      thresholds: config.thresholds,
      upgradeOnRetry: config.upgradeOnRetry,
      path: autoConfigPath(ctx.agentDir),
      pi: { version: compat.version, known: compat.known, apis: compat.apis, missing: compat.missing },
      extension: { mode, repoRoot: sourceRoot, repoAvailable: repoOk, stale },
    };
    if (flags.json) return log(JSON.stringify(payload, null, 2));
    heading("按任务难度自动选模型");
    log(`  状态        ${config.enabled ? c.green("已开启") : c.yellow("已关闭（固定 standard）")}${config.pinned ? `（固定 ${config.pinned}）` : ""}`);
    for (const tier of TIERS) {
      const spec = config.tiers[tier];
      log(`  ${TIER_LABELS[tier]} ${tier.padEnd(8)}  ${spec ? formatTierSpec(spec) : c.yellow("未配置")}`);
    }
    log(`  阈值        cheap <= ${config.thresholds.cheap} · strong >= ${config.thresholds.strong} · 失败重试升档 ${config.upgradeOnRetry ? "开" : "关"}`);
    log(`  配置文件    ${autoConfigPath(ctx.agentDir)}`);
    log(`  pi 版本     ${compat.version ?? c.yellow("未检测到（非 managed install）")}${compat.known ? `（扩展 API ${compat.missing.length ? c.red(`缺少 ${compat.missing.join(", ")}`) : c.green("正常")}）` : "（类型声明不可读，按旧版处理）"}`);
    log(`  扩展安装    ${mode === "package" ? c.green("pi 包模式，随仓库实时更新") : mode === "copy" ? `复制模式${stale.length ? c.yellow(`（${stale.length} 个文件待同步，运行 pmh auto sync）`) : "，已是最新"}` : c.yellow("未安装")}`);
    if (mode !== "none") log(`  来源仓库    ${sourceRoot}${repoOk ? "" : c.red("（不存在，请重新运行 pmh install-extension）")}`);
    if (!config.tiers.standard) {
      info("先把常用模型设为 standard，再配 cheap / strong：");
      log(`  ${c.bold("pmh auto set standard openai#gpt-5.5")}`);
    }
    if (config.enabled && !config.tiers.cheap && !config.tiers.strong) {
      info("只配了 standard 时不会自动升降档；配齐 cheap 与 strong 才有省 token/提质量的效果。");
    }
    info("在 pi 里用 /auto 查看、/auto off 关闭、/auto pin strong 固定档位、/auto explain <任务> 看分类。");
    return;
  }

  if (sub === "on" || sub === "off") {
    const enabled = sub === "on";
    save({ ...config, enabled });
    if (enabled && !config.tiers.standard) {
      warn("已开启，但 standard 档还没配置；先用 pmh auto set standard <provider#model>");
    }
    ok(enabled ? "已开启按任务难度自动选模型" : `已关闭自动路由${config.pinned ? `（固定 ${config.pinned}）` : "（固定 standard）"}`);
    info("pi 里用 /reload 或重启一次即可加载最新配置（扩展每次请求都会重新读文件，通常无需重启）。");
    return;
  }

  if (sub === "set") {
    const pairs = [];
    if (rest.length && rest.every((item) => item.includes("="))) {
      for (const item of rest) {
        const at = item.indexOf("=");
        pairs.push([item.slice(0, at), item.slice(at + 1)]);
      }
    } else {
      const [tier, spec] = rest;
      if (!tier || !spec) throw new Error("用法：pmh auto set <cheap|standard|strong> <provider#model>");
      pairs.push([tier, spec]);
    }
    const next = { ...config, tiers: { ...config.tiers } };
    for (const [tier, rawSpec] of pairs) {
      if (!TIERS.includes(tier)) throw new Error(`未知档位 "${tier}"（可选：${TIERS.join(" / ")}）`);
      const spec = parseTierSpec(rawSpec);
      const problem = autoTargetWarning(ctx, spec);
      if (problem === "不能把 pmh/auto 自己设成档位模型") throw new Error(problem);
      if (problem) warn(problem);
      next.tiers[tier] = spec;
      ok(`${TIER_LABELS[tier]} ${tier} → ${formatTierSpec(spec)}`);
    }
    save(next);
    info("生效后 pi 里选 pmh/auto 即可；/auto explain <任务> 可以预览分类结果。");
    return;
  }

  if (sub === "unset" || sub === "rm") {
    const tier = rest[0];
    if (!TIERS.includes(tier)) throw new Error(`用法：pmh auto unset <${TIERS.join("|")}>`);
    save({ ...config, tiers: { ...config.tiers, [tier]: null } });
    ok(`已清空 ${tier} 档`);
    return;
  }

  if (sub === "thresholds") {
    const [cheapRaw, strongRaw] = rest;
    if (!cheapRaw || strongRaw === undefined) throw new Error("用法：pmh auto thresholds <cheap阈值> <strong阈值>（例如 0.12 0.5）");
    const cheap = Number(cheapRaw);
    const strong = Number(strongRaw);
    if (!Number.isFinite(cheap) || !Number.isFinite(strong) || cheap < 0 || strong > 1 || cheap >= strong) {
      throw new Error("阈值需满足 0 ≤ cheap < strong ≤ 1");
    }
    save({ ...config, thresholds: { ...config.thresholds, cheap, strong } });
    ok(`阈值已更新：cheap <= ${cheap} · strong >= ${strong}`);
    return;
  }

  if (sub === "pin") {
    const target = rest[0] ?? "";
    if (target === "off" || target === "auto" || target === "none") {
      save({ ...config, pinned: null });
      ok("已取消固定档位，恢复按任务难度自动选择");
      return;
    }
    if (!TIERS.includes(target)) throw new Error(`用法：pmh auto pin <${TIERS.join("|")}|off>`);
    save({ ...config, pinned: target });
    ok(`已固定 ${TIER_LABELS[target]} 档（${target}）`);
    return;
  }

  if (sub === "explain" || sub === "test") {
    const text = rest.join(" ").trim();
    if (!text) throw new Error("用法：pmh auto explain <任务描述>");
    const result = classifyTask(text);
    const tier = config.pinned ?? result.tier;
    const spec = config.tiers[tier];
    const payload = { ...result, effectiveTier: tier, pinned: config.pinned, target: spec ? formatTierSpec(spec) : null, enabled: config.enabled };
    if (flags.json) return log(JSON.stringify(payload, null, 2));
    heading("任务难度分类");
    log(`  任务        ${truncate(text, 70)}`);
    log(`  分数        ${result.score}`);
    log(`  信号        ${result.reasons.length ? result.reasons.join("，") : "无明显信号（按常规任务）"}`);
    log(`  档位        ${TIER_LABELS[tier]} ${tier}${config.pinned ? "（已固定）" : ""}${config.enabled ? "" : "（自动路由已关闭，实际会用 standard）"}`);
    log(`  模型        ${spec ? `${spec.provider}#${spec.model}` : c.yellow("该档位未配置")}`);
    if (!config.enabled) info("自动路由当前是关闭状态；pmh auto on 才会按上面的档位切换。");
    return;
  }

  if (sub === "sync") {
    const marker = readSourceMarker(ctx.agentDir);
    const mode = installedMode(ctx.agentDir, REPO_ROOT);
    if (mode === "none") throw new Error("扩展还没安装，先运行 pmh install-extension");
    if (!marker?.repoRoot) throw new Error("找不到安装来源记录，请重新运行 pmh install-extension");
    if (!repoAvailable(marker.repoRoot)) throw new Error(`扩展源目录不存在：${marker.repoRoot}；请把仓库放回原处，或重新运行 pmh install-extension`);
    if (mode === "package") {
      ok("当前是 pi 包模式：扩展直接从仓库加载，更新仓库后重启 pi 即可，无需同步");
      return;
    }
    const changed = syncCopiedExtensions(ctx.agentDir, marker.repoRoot, marker.scope);
    writeSourceMarker(ctx.agentDir, marker);
    ok(changed.length ? `已同步 ${changed.length} 个文件：${changed.join("、")}` : "扩展文件已是最新");
    if (changed.length) info("重启 pi 或 /reload 后生效（旧文件已备份为 *.bak-<时间戳>）。");
    return;
  }

  if (sub === "install") {
    const { destDir, changed } = installAutoExtension(ctx, "auto");
    ok(`自动选模型扩展已安装到 ${destDir}${changed.length ? `（更新：${changed.join(", ")}）` : "（已是最新）"}`);
    info("在 pi 里 /reload 或重启后：选模型 pmh/auto；/auto 查看状态，/auto off 关闭。");
    return;
  }

  throw new Error(`未知的 auto 子命令 "${sub}"（可选 status / doctor / on / off / set / unset / thresholds / pin / explain / install / sync）`);
}

/** 停用复制版扩展：只改文件名，不删除，随时能改回来。 */
function disableCopiedExtensions(agentDir) {
  const stamp = Date.now();
  const moved = [];
  for (const [target, dest] of [
    [path.join(agentDir, "extensions", "quick-switch.js"), path.join(agentDir, "extensions", `quick-switch.js.disabled-${stamp}`)],
    [path.join(agentDir, "extensions", "pmh-auto", "index.js"), path.join(agentDir, "extensions", "pmh-auto", `index.js.disabled-${stamp}`)],
  ]) {
    if (!fs.existsSync(target)) continue;
    fs.renameSync(target, dest);
    moved.push(path.relative(agentDir, dest));
  }
  return moved;
}

/**
 * 包模式：把仓库登记进 settings.json 的 packages，pi 直接从仓库加载扩展。
 * 不在 pi 的安装目录里做任何修改；升级 pi 不影响，更新仓库后重启 pi 即生效。
 */
function installAsPiPackage(ctx, flags = {}) {
  const settings = loadSettings(ctx);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const already = packageEntry({ packages }, REPO_ROOT);
  if (flags.dryRun) {
    log(`会将 ${REPO_ROOT} 写入 ${ctx.paths.settings} 的 packages（${already ? "已存在" : "新增"}）`);
    log("会停用已复制的扩展（重命名为 *.disabled-<时间戳>，可手工恢复）");
    return;
  }
  if (!already) {
    settings.packages = [...packages, REPO_ROOT];
    writeJson(ctx.paths.settings, settings);
  }
  const disabled = disableCopiedExtensions(ctx.agentDir);
  writeSourceMarker(ctx.agentDir, { repoRoot: REPO_ROOT, mode: "package" });
  ok(`已登记为 pi 包：${REPO_ROOT}`);
  if (disabled.length) info(`已停用复制版扩展：${disabled.join("、")}（改回原名即可恢复）`);
  info("pi 直接从仓库加载扩展；改代码或 git pull 后，重启 pi 即生效，不需要重新安装。");
  info("升级 pi 用 pi update --all；只更新扩展包用 pi update --extensions。");
}

export function cmdInstallExtension(ctx, flags) {
  if (flags.link || flags.package) {
    installAsPiPackage(ctx, flags);
    return;
  }
  if (!flags.copy && installedMode(ctx.agentDir, REPO_ROOT) === "package") {
    writeSourceMarker(ctx.agentDir, { repoRoot: REPO_ROOT, mode: "package" });
    ok("扩展已是 pi 包模式（直接从仓库加载），无需复制");
    info("想改回复制模式：先 pi remove <本仓库路径>，再 pmh install-extension --copy。");
    return;
  }
  if (flags.copy && packageEntry(loadSettings(ctx), REPO_ROOT, ctx.agentDir)) {
    if (!flags.force) throw new Error(`本仓库已登记为 pi 包（${REPO_ROOT}），同时复制会让扩展加载两次；先运行 pi remove "${REPO_ROOT}"，或加 --force 强制复制`);
    warn("包登记仍然存在，pi 会同时加载包与复制版；确认无误后再继续。");
  }
  const source = path.join(REPO_ROOT, "extensions", "quick-switch.js");
  if (!fs.existsSync(source)) throw new Error(`找不到扩展文件：${source}`);
  const destDir = path.join(ctx.agentDir, "extensions");
  const dest = path.join(destDir, "quick-switch.js");
  fs.mkdirSync(destDir, { recursive: true });
  const backup = fs.existsSync(dest) ? `${dest}.bak-${Date.now()}` : null;
  if (backup) fs.copyFileSync(dest, backup);
  fs.copyFileSync(source, dest);
  ok(`扩展已安装到 ${dest}${backup ? `（旧文件备份为 ${path.basename(backup)}）` : ""}`);
  const auto = installAutoExtension(ctx);
  ok(`自动选模型扩展已安装到 ${auto.destDir}${auto.changed.length ? `（更新：${auto.changed.join(", ")}）` : "（已是最新）"}`);
  info("在 pi 里输入 /reload（或重启 pi）后即可用：");
  log(`  /switch            弹出选择器，中转站模型排最前`);
  log(`  /switch sonnet     关键词直接切`);
  log(`  /switch-save       切完顺手设为新会话默认`);
  log(`  Ctrl+Shift+M       快捷键，等同 /switch`);
  log(`  /auto              按任务难度自动选模型的状态与开关（选 pmh/auto 后生效）`);
  info("用 /hotkeys 可以确认快捷键已生效。");
  info("pi 升级后扩展会在下次启动自动校验版本与 API，复制模式还会自动同步仓库里的最新文件。");
  info(`想彻底告别复制、让扩展随仓库实时更新：${c.bold("pmh install-extension --link")}`);
}

/**
 * 一键初始化：装扩展 → 配置中转站 → 设默认模型。
 * 安装脚本最后调用这里；也可以手动运行 `pmh bootstrap`。
 */
export async function cmdBootstrap(ctx, urlArg, keyArg, flags = {}) {
  heading("pmh 初始化");

  const install = findPiInstall(ctx.agentDir);
  if (!install.version && !flags.noExtension) {
    warn("没有检测到 pi：配置仍会写入，但扩展要等 pi 装好后才生效。");
    info("装好 pi 后运行：pmh bootstrap");
  }

  if (!flags.noExtension) {
    const extFlags = flags.copy
      ? { ...flags, copy: true, link: false, package: false }
      : { ...flags, link: true, package: true, copy: false };
    try {
      cmdInstallExtension(ctx, extFlags);
    } catch (err) {
      warn(`扩展安装失败：${err.message}`);
      info("可以先继续配置，之后重试：pmh install-extension --link");
    }
  }

  if (flags.noConfig) {
    info("已跳过中转站配置。之后运行 pmh bootstrap 或 pmh quick。");
    return;
  }

  const url = urlArg ?? flags.base ?? flags.baseUrl ?? "";
  const key = keyArg ?? flags.key ?? "";
  if (!url && !isInteractive()) {
    info("没有提供中转站地址，已跳过配置。之后运行 pmh bootstrap 或 pmh quick。");
    return;
  }

  try {
    await cmdQuick(ctx, url, key, flags);
  } catch (err) {
    // 安装本身已经成功，配置失败不应让安装脚本整体报错
    warn(`配置未完成：${err.message}`);
    info("之后可以重新运行：pmh bootstrap");
    return;
  }

  ok("初始化完成。");
  info("打开 pi，输入 /switch 选模型；pmh current 查看当前默认模型。");
}

export function cmdAlias(ctx, flags) {
  const models = loadModels(ctx);
  const ids = Object.keys(models.providers);
  if (!ids.length) return info("还没有 provider，先 pmh add。");
  const shell = flags.shell ?? "powershell";
  heading(`${shell} 快捷命令（贴到 $PROFILE 或直接 eval）`);
  for (const id of ids) {
    if (shell === "powershell") log(`function pi-${id} { & pi --provider ${id} @args }`);
    else log(`alias pi-${id}='pi --provider ${id}'`);
  }
  if (shell === "powershell") log(`function pi-pick { pmh pick --run }`);
  else log(`alias pi-pick='pmh pick --run'`);
  log("");
  info(shell === "powershell" ? `追加到配置：pmh alias >> $PROFILE` : `追加到配置：pmh alias --shell bash >> ~/.bashrc`);
}

export async function cmdPick(ctx, flags) {
  let entries = allEntries(ctx).filter((e) => e.model);
  if (flags.filter) {
    entries = entriesForSpec(ctx, flags.filter) ?? [];
    if (!entries.length) throw new Error(`筛选 "${flags.filter}" 没有可用的模型`);
  }
  if (!entries.length) throw new Error("还没有可选的模型，先 pmh add 一个中转站");
  const picked = await pickOne(orderEntries(ctx, entries), {
    title: flags.run ? "选一个模型并启动 pi" : `选择模型${flags.filter ? `（${flags.filter}）` : ""}`,
    label: PICK_LABEL,
    marker: pickMarker(ctx),
  });
  if (!picked) return info("已取消。");
  const target = `${picked.provider}#${picked.model}`;
  await cmdUse(ctx, target, {});
  if (flags.run) await cmdRun(ctx, target, [], {});
}

export async function cmdFeedback(ctx, message, flags = {}) {
  const text = Array.isArray(message) ? message.join(" ") : String(message ?? "");
  const data = buildFeedback(ctx, text);

  if (flags.json) {
    log(JSON.stringify({
      title: data.title,
      report: data.report,
      issueUrl: data.issueUrl,
      diagnostics: data.diagnostics,
    }, null, 2));
    return;
  }

  heading("反馈报告（已脱敏）");
  log(data.report);
  log("");
  if (flags.print) {
    log(data.issueUrl);
    info("把上面的链接粘贴到浏览器；也可用 pmh feedback --open 直接打开。");
    return;
  }

  let shouldOpen = Boolean(flags.open);
  if (!shouldOpen && isInteractive()) {
    shouldOpen = await askConfirm("在浏览器打开 GitHub Issue？", { defaultValue: false });
  }
  if (!shouldOpen) {
    log(data.issueUrl);
    info("在浏览器打开上面的链接，确认内容后提交即可。");
    return;
  }

  if (openUrl(data.issueUrl)) {
    ok("已在浏览器打开 GitHub Issue，确认内容后点击 Submit 即可。");
  } else {
    warn("没能自动打开浏览器，请手动访问下面链接：");
    log(data.issueUrl);
  }
}

export async function cmdDoctor(ctx) {
  const install = findPiInstall(ctx.agentDir);
  const launcher = findPiLauncher(ctx.agentDir);
  const clipboardTool = detectClipboardTool();
  const platformName = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux / 其他 Unix";
  heading("环境体检");
  log(`  系统            ${platformName}（${process.platform} ${process.arch}）`);
  log(`  Node            ${process.version}`);
  log(`  交互终端        ${isInteractive() ? c.green("可用（向导 / ↑↓ 选择器）") : c.yellow("不是 TTY，只会走参数模式")}`);
  log(`  剪贴板工具      ${clipboardTool ?? c.yellow("没找到，pmh quick 需要手动传地址和 Key")}`);
  log(`  agent 目录      ${ctx.agentDir}${fs.existsSync(ctx.agentDir) ? "" : c.yellow("（不存在）")}`);
  log(`  pi 版本         ${install.version ?? c.yellow("未检测到（不是 managed install？）")}`);
  log(`  pi 启动器       ${launcher.fromPath ? c.yellow(`${launcher.command}（来自 PATH）`) : launcher.command}`);
  const compat = checkCompat(ctx.agentDir);
  log(`  扩展 API        ${compat.known ? (compat.missing.length ? c.red(`缺少 ${compat.missing.join(", ")}`) : c.green("虚拟模型 / 命令 / 会话钩子正常")) : c.yellow("类型声明不可读（按旧版处理）")}`);
  const marker = readSourceMarker(ctx.agentDir);
  const installMode = installedMode(ctx.agentDir, REPO_ROOT);
  const staleFiles = installMode === "copy" ? staleCopies(ctx.agentDir, marker?.repoRoot ?? REPO_ROOT, marker?.scope) : [];
  log(`  扩展安装        ${installMode === "package" ? c.green("pi 包模式（随仓库实时更新）") : installMode === "copy" ? `复制模式${staleFiles.length ? c.yellow(`，${staleFiles.length} 个文件待同步`) : "，已是最新"}` : c.yellow("未安装（pmh install-extension --link）")}`);
  if (installMode !== "none") {
    const sourceRoot = marker?.repoRoot ?? REPO_ROOT;
    log(`  扩展来源        ${sourceRoot}${repoAvailable(sourceRoot) ? "" : c.red("（不存在，请重新运行 pmh install-extension）")}`);
  }
  log(`  官方模型目录    ${ctx.catalog.index.size} 条${ctx.catalog.dirs.length ? `（${ctx.catalog.dirs.join("; ")}）` : c.yellow("（没找到，元数据只能靠启发式）")}`);
  const builtins = loadBuiltinProviders(ctx.agentDir).providers;
  log(`  内置 provider   ${builtins.size} 个${builtins.size ? `（可用 pmh model override <内置> <模型> 改元数据）` : ""}`);
  for (const [label, file] of Object.entries({
    "models.json": ctx.paths.models,
    "auth.json": ctx.paths.auth,
    "settings.json": ctx.paths.settings,
    "注册表": ctx.paths.registry,
  })) {
    let status = c.dim("不存在");
    if (fs.existsSync(file)) {
      try {
        JSON.parse(fs.readFileSync(file, "utf8"));
        status = c.green("正常");
      } catch (err) {
        status = c.red(`JSON 损坏：${err.message}`);
      }
    }
    log(`  ${label.padEnd(14)} ${status}  ${c.dim(file)}`);
  }
  if (fs.existsSync(ctx.paths.models)) {
    try {
      const modelsData = readJson(ctx.paths.models, { providers: {} });
      const authData = readJson(ctx.paths.auth, {}) ?? {};
      let settingsData = {};
      try {
        settingsData = loadSettings(ctx);
      } catch {
        /* 上面的文件状态已经报告过 JSON 损坏 */
      }
      const report = validateModelsConfig({ models: modelsData, auth: authData, settings: settingsData, builtins });
      heading("models.json 配置校验");
      if (!report.errors.length && !report.warnings.length) {
        ok("结构、模型字段、凭据与默认模型检查通过");
      } else {
        for (const item of report.errors) log(`  ${c.red("✖")} ${item.path ? `${item.path}：` : ""}${item.message}`);
        for (const item of report.warnings) log(`  ${c.yellow("!")} ${item.path ? `${item.path}：` : ""}${item.message}`);
        if (report.errors.length) info("✖ 是 pi 会拒绝或读取不到的配置，建议先修；! 是不致命但可能不生效的配置。");
      }
    } catch (err) {
      warn(`models.json 无法校验：${err.message}`);
    }
  }
  const { registry, stale, corrupt, reason, changed } = loadRegistryState(ctx);
  const relayCount = Object.keys(registry.relays).length;
  const aliasCount = Object.values(registry.relays).reduce((n, r) => n + Math.max(0, (r.keyAliases ?? []).length - 1), 0);
  log(`  注册表内容      ${relayCount} 个站、${Object.keys(registry.groups).length} 个分组、${aliasCount} 个 Key 别名、widget=${registry.settings.widget}`);
  if (corrupt) warn(`注册表损坏，已按空表处理：${reason}（下次写操作会重建）`);
  if (stale.length) warn(`注册表里有 ${stale.length} 个站已不在 models.json：${stale.join(", ")}（pmh rm 或手工清理）`);
  if (changed) info("注册表与 models.json 有差异，会在下次写操作时自动对齐（只读命令不会写盘）。");
  const metaRelays = Object.values(registry.relays).filter((r) => r.lastSyncedAt);
  if (metaRelays.length) {
    log(`  元数据同步      ${metaRelays.length} 个站有记录，最近一次 ${String(metaRelays.map((r) => r.lastSyncedAt).sort().at(-1)).slice(0, 16).replace("T", " ")}`);
  }
  const settings = loadSettings(ctx);
  log(`  默认模型        ${settings.defaultProvider ? `${settings.defaultProvider}/${settings.defaultModel ?? "?"}` : c.dim("未设置")}`);
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    log(`  代理            ${process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY}（Node 需 NODE_USE_ENV_PROXY=1，本工具会自动加）`);
  }
  log("");
  info(`备份文件都在配置文件旁边，形如 models.json.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-xxxxxx，可随时手工回滚。`);
  if (!clipboardTool) {
    info("一键配置需要读剪贴板：Windows 自带 PowerShell，macOS 自带 pbpaste；Linux 请装 wl-clipboard 或 xclip（Termux 装 termux-api）。");
  }
}

export function printHelp() {
  log(`${c.bold("pmh")} — 让 pi 接入任意第三方 API（中转站 / 自建网关）并随时切换

${c.bold("最快路径（接入 → 切换）")}
  pmh quick                          # 一键：地址 + Key（Key 可从剪贴板读）→ 读模型列表 → 挑默认模型
  pmh add                            # 向导：问地址 → 问 Key → 读模型列表 → 立刻挑选
  pmh add crow5 --base https://xxx.crow5.com --key sk-xxx   # 或者一条命令带参数搞定
  pmh test crow5
  pmh pick          # ↑↓ 选模型，选中即设为默认
  pmh run sonnet    # 关键词模糊匹配，直接用这个模型启动 pi

${c.bold("在 pi 里秒切（需先 pmh install-extension，然后在 pi 里 /reload）")}
  /switch                选择器：收藏 → 最近 → 中转站 → 当前 → 其他（● 是当前模型）
  /switch sonnet         输入关键词直接切，唯一命中时一步到位
  /switch @组 [关键词]   只在分组里选；@fav 只看收藏，recent 只看最近
  /switch relay <名称>   直接切到该站上次用的模型
  /switch-save           切完顺手设为新会话默认
  /switch-fav            收藏/取消收藏当前模型
  /switch-widget [on|off|auto]  开关站点 widget
  Ctrl+Shift+M           快捷键，等同 /switch
  过滤条件：@组 / @fav / recent / reasoning / image / ctx:>=200k / provider: 名称
  /auto                  按任务难度自动选模型：状态、开关、固定档位（选 pmh/auto 后生效）
  /auto off              关闭自动升降档，固定用 standard
  /auto pin strong       固定档位；/auto pin off 恢复自动
  /auto explain <任务>   看这次会被分到哪档、用哪个模型

${c.bold("命令")}
  add <名称> --base <url> [--key <k> | --key-env VAR | --key-ref VAR | --key-cmd CMD] [--api <api>] [--api-rule 正则=api]
             [--model id1,id2 | --models-file f] [--cost-multiplier 0.2 | --no-cost]
             [--ratio] [--no-reasoning-compat] [--prompt-cache] [--group 组] [--tag 标签]
             [--key-in models] [--name 显示名] [--no-key] [--yes] [--force] [--no-sync]
             [--refresh-meta] [--dry-run] [--verbose]
             不带参数即进入向导；地址/协议可省略（更新已有 provider 时）；别名 setup / init
  quick [地址] [key] [--as 名称]    一键接入：缺的参数从剪贴板里认；别名 go
  local <ollama|lmstudio|vllm|sglang|llama-cpp> [--port 端口] [--as 名称]
                                本机推理服务一键接入（自动写占位 Key），再 pmh sync 拉模型
  model ls [名称] [--json]      列出单模型配置（含仅有 modelOverrides 的内置 provider）
  model add <provider> <模型id> [--name 显示名] [--api <api>] [--base <url>]
             [--ctx 200k] [--max-output 64k] [--reasoning] [--no-reasoning]
             [--image] [--text-only] [--cost-in 3 --cost-out 15 --cache-read 0.3 --cache-write 3.75]
                                在任意 provider（含 pi 内置）下新增/替换一个模型
  model override <provider> <模型id> [--name ...] [--ctx ...] [--max-output ...] [--cost-in ...]
                                只改元数据（内置模型的正确改法），不碰 api/baseUrl
  model rm <provider> <模型id> [--override-only]   删除模型或它的 override
  model 支持 --dry-run；--override 等价于 model override 的简写
  auto status [--json]          按任务难度自动选模型的配置（档位/阈值/开关/pi 兼容性）
  auto doctor                   体检：pi 版本、扩展 API、安装方式、待同步文件
  auto set <cheap|standard|strong> <provider#model>
                                配置档位；也可一次写多组：auto set cheap=... strong=...
  auto on | off                 开启 / 关闭自动升降档（关闭后固定 standard）
  auto thresholds <cheap> <strong>       调整升/降档阈值（默认 0.12 0.5）
  auto pin <cheap|standard|strong|off>   固定档位 / 取消固定
  auto explain <任务描述>       预览分类结果与将使用的模型
  auto install                  只安装/刷新自动选模型扩展（pi 里选 pmh/auto）
  auto sync                     复制模式下同步仓库里的最新扩展（旧文件留备份）
  import [源...]                批量导入：文件 / URL / "-"（stdin）/ 直接粘贴文本
                                [--from clipboard|claude|codex|all] [--dry-run]
                                [--group 组] [--no-sync] [--yes] [--json]
  scan [--from all] [--json]    只列出扫描到的站点（Key 打码），不写盘
  sync <名称> [--keep-missing] [--refresh-meta] [--ratio] [--api-rule ...]
             [--cost-multiplier 0.2] [--dry-run] [--verbose]
  key <名称> <api-key>          把密钥写进 auth.json（v0.1 行为不变）
  key ls [名称]                 列出 Key 别名（打码，标出活动项）
  key add <名称> <别名> <key>   新增一个 Key 别名
  key use <名称> <别名>         切换活动 Key（旧 Key 自动留档）
  key rm <名称> <别名>          删除别名（活动 Key 不能删）
  ls [--models] [--group 组] [--json]   列出 provider、分组、凭据与默认模型
  models [名称]                 只看模型清单（等价 ls --models）
  current [--json] [--format 模板]  当前默认模型一行摘要（纯本地；别名 status）
                                模板变量：{{provider}} {{model}} {{thinking}} {{key}} {{group}} {{ctx}} {{source}}
  group ls | add <名> [--title 显示名] | rm <名>
  relay group <relay> <分组|->  设置站点所属分组
  fav [add|rm] <relay>#<模型>   收藏 / 取消收藏；不带子命令即切换
  fav ls                        列出收藏
  recent [--limit 10]           最近使用的模型（跨站）
  meta [<名称>] [--drift] [--verbose] [--json]
                                查看模型元数据；--drift 只看与上游不一致的字段
  use [名称[#模型] | 关键词 | @组 关键词 | @组 | @fav | recent[:N] | -]
                                留空则打开选择器；- 切回上一个默认；别名 switch
                                [--thinking <级别>] [--allow-builtin]
  scope [pattern...] [--clear]  限制 Ctrl+P 循环范围
  test <名称> [--model id] [--no-chat] [--verbose]
  run [名称[#模型] | 关键词 | @组 关键词 | @组 | @fav] [-- <传给 pi 的参数>]
  pick [@组|@fav|recent[:N]] [--run]   ↑↓ 方向键选择器（可顺手启动 pi）
  install-extension [--copy|--link]  安装 /switch 与 /auto 扩展；--link 推荐（pi 包模式，随仓库实时更新）
  completion [powershell|bash|zsh|fish]   输出 shell 补全脚本（不带参数则自动识别）
  alias [--shell powershell|bash]
  rm <名称> [--purge-key [--purge-backups]]
  feedback [问题描述] [--print] [--open] [--json]
                                生成脱敏环境报告并打开 GitHub Issue（不含 Key / 站点地址）
  bootstrap [地址] [--copy] [--no-extension] [--no-config]
                                一键初始化：装扩展 + 配置中转站 + 选默认模型
  doctor

${c.bold("全局参数")}
  --agent-dir <dir>   覆盖 ~/.pi/agent（也可用 PMH_AGENT_DIR）
  --catalog <dir>     覆盖官方模型目录来源
  --proxy <url>       强制走代理（默认读 HTTPS_PROXY/HTTP_PROXY）
`);
}

