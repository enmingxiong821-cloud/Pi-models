import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCatalog, buildModelEntry } from "./catalog.mjs";
import { searchModels } from "./match.mjs";
import { pickOne } from "./picker.mjs";
import { configPaths, findPiInstall, findPiLauncher, resolveAgentDir } from "./paths.mjs";
import { API_KINDS, apiFamily, baseUrlFor, fetchModels, probeChat, fetchRatioConfig } from "./relay.mjs";
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

function credentialOf(ctx, providerId) {
  const auth = loadAuth(ctx);
  const entry = auth[providerId];
  if (entry?.key) return { kind: entry.type === "api_key" || !entry.type ? "auth.json" : entry.type, value: entry.key };
  const models = loadModels(ctx);
  const apiKey = models.providers?.[providerId]?.apiKey;
  if (apiKey) {
    const env = /^\$\{?([A-Z0-9_]+)\}?$/.exec(apiKey);
    if (env) return process.env[env[1]] ? { kind: `env:${env[1]}`, value: process.env[env[1]] } : { kind: `env:${env[1]}（未设置）`, value: null };
    return { kind: "models.json(明文)", value: apiKey };
  }
  return { kind: "无", value: null };
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
  if (explicit.length) return { ids: explicit, source: "手动指定" };
  if (flags.noSync) return { ids: [], source: "未同步" };
  try {
    const res = await fetchModels({ root, api, key });
    if (!res.ok || !res.ids.length) {
      warn(`拉取模型列表失败（HTTP ${res.status}）：${truncate(res.raw, 160)}`);
      warn(`可先用 /v1/models 检查，或手动指定：pmh add ${name} --base ${root} --model id1,id2`);
      return { ids: [], source: "拉取失败" };
    }
    return { ids: res.ids, source: `${res.url}` };
  } catch (err) {
    warn(`拉取模型列表出错：${err.message}`);
    return { ids: [], source: "拉取失败" };
  }
}

function buildModelList(ids, { ctx, providerApi, providerBaseUrl, rules, costMode, costMultiplier, previous = {} }) {
  const entries = [];
  const report = [];
  for (const id of ids) {
    const modelApi = resolveModelApi(id, providerApi, rules);
    const { entry, match, source } = buildModelEntry(id, {
      catalog: ctx.catalog,
      providerApi,
      providerBaseUrl,
      modelApi,
      modelBaseUrl: baseUrlFor(providerBaseUrl, modelApi),
      costMode,
      costMultiplier,
    });
    const old = previous[id];
    // 保留用户手工加过的字段（compat / samplingParams / headers ...）
    entries.push(old ? { ...old, ...entry } : entry);
    report.push({ id, name: entry.name, source, matchedId: match?.matchedId, method: match?.method, api: entry.api ?? providerApi });
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

export async function cmdAdd(ctx, name, flags) {
  const id = normalizeProviderName(name);
  const base = flags.base ?? flags.baseUrl;
  if (!base) throw new Error("缺少 --base <中转站地址>，例如 --base https://api.example.com（可带或不带 /v1）");
  const root = rootOf(base);
  const api = flags.api ?? "openai-completions";
  if (!API_KINDS.includes(api)) throw new Error(`不支持的 --api: ${api}（可选 ${API_KINDS.join(" / ")}）`);
  const rules = parseApiRules([].concat(flags.apiRule ?? []));
  const key = flags.key ?? (flags.keyEnv ? `$${flags.keyEnv}` : null);
  const literalKey = flags.key ?? (flags.keyEnv ? process.env[flags.keyEnv] : null);

  const models = loadModels(ctx);
  if (models.providers[id] && !flags.force) {
    warn(`provider "${id}" 已存在，继续会更新它（加 --force 跳过确认）`);
  }
  const previous = Object.fromEntries((models.providers[id]?.models ?? []).map((m) => [m.id, m]));

  const costMultiplier = Number(flags.costMultiplier ?? 1) || 1;
  const costMode = flags.noCost ? "off" : flags.cost === "scaled" || flags.costMultiplier ? "scaled" : "official";

  const { ids, source } = await discoverIds(ctx, { name: id, root, api, key: literalKey, flags });
  const { entries, report } = buildModelList(ids, {
    ctx,
    providerApi: api,
    providerBaseUrl: baseUrlFor(root, api),
    rules,
    costMode,
    costMultiplier,
    previous,
  });

  const provider = {
    name: flags.displayName ?? id,
    baseUrl: baseUrlFor(root, api),
    api,
    ...(entries.length ? { models: entries } : {}),
  };
  if (flags.keyIn === "models" && literalKey) provider.apiKey = literalKey;

  if (flags.dryRun) {
    heading("--dry-run：以下内容将写入 models.json");
    log(JSON.stringify({ providers: { [id]: provider } }, null, 2));
    if (literalKey && flags.keyIn !== "models") log(`\n（同时把 key 写入 auth.json 的 "${id}"）`);
    return;
  }

  models.providers[id] = provider;
  const backup = writeJson(ctx.paths.models, models);
  ok(`已写入 ${ctx.paths.models}${backup ? `（备份：${path.basename(backup)}）` : ""}`);

  if (literalKey && flags.keyIn !== "models") {
    const auth = loadAuth(ctx);
    auth[id] = { ...(auth[id] ?? {}), type: "api_key", key: literalKey };
    const authBackup = writeJson(ctx.paths.auth, auth);
    ok(`已写入 ${ctx.paths.auth}${authBackup ? `（备份：${path.basename(authBackup)}）` : ""}`);
  } else if (!literalKey && flags.keyIn !== "models") {
    info(`尚未写入密钥。稍后执行：pmh key ${id} <你的key>   或再补：--key`);
  }

  heading(`provider "${id}" 就绪`);
  log(`  地址       ${baseUrlFor(root, api)}`);
  log(`  默认 API   ${api}${rules.length ? `（另加 ${rules.length} 条按模型路由规则）` : ""}`);
  log(`  模型数     ${entries.length}${entries.length ? "" : "（用 pmh sync 重新同步，或 --model 手动指定）"}`);
  log(`  模型清单   ${source}`);
  if (report.length) printModelReport(report, { verbose: flags.verbose });
  log("");
  info(`下一步：pmh test ${id}        验证连通性`);
  info(`        pmh use ${id}         设为默认（在 pi 里按 Ctrl+P 也能切）`);
  info(`        pmh run ${id}         直接用这个中转站启动 pi`);
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

  const { ids, source } = await discoverIds(ctx, { name: id, root, api, key: cred.value, flags });
  if (!ids.length) {
    warn("没有拿到任何模型，配置保持不变。");
    return;
  }
  const previous = Object.fromEntries((provider.models ?? []).map((m) => [m.id, m]));
  const keptMissing = (provider.models ?? []).filter((m) => !ids.includes(m.id));
  const costMultiplier = Number(flags.costMultiplier ?? 1) || 1;
  const costMode = flags.noCost ? "off" : flags.cost === "scaled" || flags.costMultiplier ? "scaled" : "official";
  const { entries, report } = buildModelList(ids, {
    ctx,
    providerApi: api,
    providerBaseUrl: provider.baseUrl ?? baseUrlFor(root, api),
    rules,
    costMode,
    costMultiplier,
    previous,
  });
  provider.models = flags.keepMissing ? [...entries, ...keptMissing.filter((m) => !entries.some((e) => e.id === m.id))] : entries;
  provider.api ??= api;

  if (flags.dryRun) {
    log(JSON.stringify({ [id]: provider.models.length }, null, 2));
    return;
  }
  const backup = writeJson(ctx.paths.models, models);
  ok(`已同步 ${entries.length} 个模型到 ${ctx.paths.models}${backup ? `（备份：${path.basename(backup)}）` : ""}`);
  printModelReport(report, { verbose: flags.verbose });
  info(`目录来源：${source}`);
  info("在 pi 里打开 /model 即可看到新模型（无需重启）。");
}

export function cmdKey(ctx, name, key) {
  const id = normalizeProviderName(name);
  const models = loadModels(ctx);
  if (!models.providers[id]) throw new Error(`没有名为 "${id}" 的 provider，先 pmh add`);
  if (!key) throw new Error("用法：pmh key <provider> <api-key>");
  const auth = loadAuth(ctx);
  auth[id] = { ...(auth[id] ?? {}), type: "api_key", key };
  const backup = writeJson(ctx.paths.auth, auth);
  ok(`已把 ${id} 的密钥写入 ${ctx.paths.auth}${backup ? `（备份：${path.basename(backup)}）` : ""}`);
}

export function cmdLs(ctx, flags) {
  const models = loadModels(ctx);
  const settings = loadSettings(ctx);
  const store = readJson(ctx.paths.modelsStore, {});
  const rows = [];
  for (const [id, provider] of Object.entries(models.providers)) {
    const cred = credentialOf(ctx, id);
    const isDefault = settings.defaultProvider === id;
    rows.push([
      isDefault ? `${id} ${c.green("←默认")}` : id,
      truncate(provider.baseUrl ?? "", 44),
      provider.api ?? "openai-completions",
      (provider.models ?? []).length || "—",
      cred.value ? cred.kind : c.yellow(cred.kind),
      (store[id]?.models ?? store[id] ?? []).length ? "pi 已缓存" : "",
    ]);
  }
  heading(`pi 配置里的自定义 provider（${rows.length} 个）`);
  if (!rows.length) {
    info("还没有。用 pmh add <名称> --base <地址> --key <key> 添加一个中转站。");
  } else {
    log(table(rows, ["provider", "baseUrl", "API", "模型数", "凭据", "状态"]));
  }
  const builtinAuth = Object.keys(loadAuth(ctx)).filter((k) => !models.providers[k]);
  if (builtinAuth.length) {
    log("");
    log(`${c.dim("内置 provider 已登录：")} ${builtinAuth.join(", ")}`);
  }
  log("");
  log(`默认模型：${settings.defaultProvider ? `${settings.defaultProvider}/${settings.defaultModel ?? "?"}` : c.dim("未设置（pi 自行选择）")}`);
  if (flags.models) {
    heading("模型明细");
    for (const [id, provider] of Object.entries(models.providers)) {
      const list = (provider.models ?? []).map((m) => m.id);
      if (list.length) log(`  ${c.bold(id)}: ${list.join(", ")}`);
    }
  }
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
  if (!target) {
    const entries = allEntries(ctx).filter((e) => e.model);
    if (!entries.length) throw new Error("还没有可选的模型，先 pmh add 一个中转站");
    const settings0 = loadSettings(ctx);
    const chosen = await pickOne(entries, {
      title: "设为默认模型",
      label: (e) => `${e.provider}/${e.model}`,
      marker: (e) => (settings0.defaultProvider === e.provider && settings0.defaultModel === e.model ? c.green("  ←当前默认") : ""),
    });
    if (!chosen) return info("已取消。");
    return cmdUse(ctx, `${chosen.provider}#${chosen.model}`, flags);
  }
  const resolved = resolveTarget(ctx, target);
  const { provider, model } = resolved;
  const models = loadModels(ctx);
  const settings = loadSettings(ctx);
  if (provider) {
    if (!models.providers[provider] && !flags.allowBuiltin) {
      warn(`"${provider}" 不在 models.json 里（内置厂商请加 --allow-builtin）`);
    }
    settings.defaultProvider = provider;
  } else {
    warn(`没有匹配 "${target}" 的模型，可以用 pmh ls --models 看看有哪些`);
    return;
  }
  if (model && model !== "*") settings.defaultModel = model;
  if (flags.thinking) settings.defaultThinkingLevel = flags.thinking;
  const backup = writeJson(ctx.paths.settings, settings);
  ok(
    `默认模型已设为 ${c.bold(`${settings.defaultProvider ?? "?"}${settings.defaultModel ? `/${settings.defaultModel}` : ""}`)}` +
      `${flags.thinking ? `，思考级别 ${flags.thinking}` : ""}${backup ? `（备份：${path.basename(backup)}）` : ""}`,
  );
  reportAlternatives(resolved, `${provider}/${model}`);
  info("已开着的 pi 会话里按 Ctrl+P 或 /model 也能立即切；下次启动默认用这个。");
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

export function cmdRm(ctx, name, flags) {
  const id = normalizeProviderName(name);
  const models = loadModels(ctx);
  if (!models.providers[id]) throw new Error(`没有名为 "${id}" 的 provider`);
  delete models.providers[id];
  const backup = writeJson(ctx.paths.models, models);
  ok(`已从 models.json 移除 "${id}"${backup ? `（备份：${path.basename(backup)}）` : ""}`);
  if (flags.purgeKey) {
    const auth = loadAuth(ctx);
    if (auth[id]) {
      delete auth[id];
      writeJson(ctx.paths.auth, auth);
      ok("同时删除了 auth.json 里的密钥");
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
  log(`  凭据   ${cred.kind}${cred.value ? "" : c.yellow("（不可用）")}`);

  const res = await fetchModels({ root, api, key: cred.value });
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
        const probe = await probeChat({ root, api: api2, key: cred.value, model });
        if (probe.ok) ok(`试聊成功：${model}（${probe.ms} ms）→ ${truncate(probe.text ?? "(空回复)", 60)}`);
        else fail(`试聊失败：${model} HTTP ${probe.status} ${truncate(probe.error ?? "", 200)}`);
      } catch (err) {
        fail(`试聊异常：${err.message}`);
      }
    }
  }
}

export function cmdRun(ctx, target, piArgs, flags) {
  const launcher = findPiLauncher(ctx.agentDir);
  if (!launcher) throw new Error("没找到 pi 启动器，检查 ~/.pi/agent/bin/pi.cmd 是否在，或用 PMH_PI_BIN 指定");
  const resolved = resolveTarget(ctx, target);
  const { provider, model } = resolved;
  if (!provider && target) {
    warn(`没有匹配 "${target}" 的模型，直接启动 pi（可 pmh ls --models 查看可用项）`);
  }
  const args = [...(provider ? ["--provider", provider] : []), ...(model ? ["--model", model] : []), ...piArgs];
  info(`启动 pi：${args.join(" ")}`);
  const res = spawnSync(launcher.command, args, { stdio: "inherit", shell: launcher.kind === "cmd" });
  process.exit(res.status ?? 0);
}

export function cmdInstallExtension(ctx, flags) {
  const source = path.join(REPO_ROOT, "extensions", "quick-switch.js");
  if (!fs.existsSync(source)) throw new Error(`找不到扩展文件：${source}`);
  const destDir = path.join(ctx.agentDir, "extensions");
  const dest = path.join(destDir, "quick-switch.js");
  fs.mkdirSync(destDir, { recursive: true });
  const backup = fs.existsSync(dest) ? `${dest}.bak-${Date.now()}` : null;
  if (backup) fs.copyFileSync(dest, backup);
  fs.copyFileSync(source, dest);
  ok(`扩展已安装到 ${dest}${backup ? `（旧文件备份为 ${path.basename(backup)}）` : ""}`);
  info("在 pi 里输入 /reload（或重启 pi）后即可用：");
  log(`  /switch            弹出选择器，中转站模型排最前`);
  log(`  /switch sonnet     关键词直接切`);
  log(`  /switch-save       切完顺手设为新会话默认`);
  log(`  Ctrl+Shift+M       快捷键，等同 /switch`);
  info("用 /hotkeys 可以确认快捷键已生效。");
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
  const settings = loadSettings(ctx);
  const entries = allEntries(ctx).filter((e) => e.model);
  if (!entries.length) throw new Error("还没有可选的模型，先 pmh add 一个中转站");
  const picked = await pickOne(entries, {
    title: flags.run ? "选一个模型并启动 pi" : "选择模型",
    label: (e) => `${e.provider}/${e.model}${e.name && e.name !== e.model ? `  ${c.dim(truncate(e.name, 28))}` : ""}`,
    marker: (e) => (settings.defaultProvider === e.provider && settings.defaultModel === e.model ? c.green("  ←当前默认") : ""),
  });
  if (!picked) return info("已取消。");
  const target = `${picked.provider}#${picked.model}`;
  await cmdUse(ctx, target, {});
  if (flags.run) cmdRun(ctx, target, [], {});
}

export async function cmdDoctor(ctx) {
  const install = findPiInstall(ctx.agentDir);
  const launcher = findPiLauncher(ctx.agentDir);
  heading("环境体检");
  log(`  Node            ${process.version}`);
  log(`  agent 目录      ${ctx.agentDir}${fs.existsSync(ctx.agentDir) ? "" : c.yellow("（不存在）")}`);
  log(`  pi 版本         ${install.version ?? c.yellow("未检测到（不是 managed install？）")}`);
  log(`  pi 启动器       ${launcher ? launcher.command : c.yellow("未找到")}`);
  log(`  官方模型目录    ${ctx.catalog.index.size} 条${ctx.catalog.dirs.length ? `（${ctx.catalog.dirs.join("; ")}）` : c.yellow("（没找到，元数据只能靠启发式）")}`);
  for (const [label, file] of Object.entries({ "models.json": ctx.paths.models, "auth.json": ctx.paths.auth, "settings.json": ctx.paths.settings })) {
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
  const settings = loadSettings(ctx);
  log(`  默认模型        ${settings.defaultProvider ? `${settings.defaultProvider}/${settings.defaultModel ?? "?"}` : c.dim("未设置")}`);
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    log(`  代理            ${process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY}（Node 需 NODE_USE_ENV_PROXY=1，本工具会自动加）`);
  }
  const ratio = await fetchRatioConfig({ root: "http://127.0.0.1:1" });
  void ratio;
  log("");
  info(`备份文件都在配置文件旁边，形如 models.json.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-xxxxxx，可随时手工回滚。`);
}

export function printHelp() {
  log(`${c.bold("pmh")} — 让 pi 接入任意第三方 API（中转站 / 自建网关）并随时切换

${c.bold("最快路径（接入 → 切换）")}
  pmh add crow5 --base https://xxx.crow5.com --key sk-xxx
  pmh test crow5
  pmh pick          # ↑↓ 选模型，选中即设为默认
  pmh run sonnet    # 关键词模糊匹配，直接用这个模型启动 pi

${c.bold("在 pi 里秒切（需先 pmh install-extension，然后在 pi 里 /reload）")}
  /switch            选择器，中转站模型排最前（● 是当前模型）
  /switch sonnet     输入关键词直接切，唯一命中时一步到位
  /switch-save       切完顺手设为新会话默认
  Ctrl+Shift+M       快捷键，等同 /switch

${c.bold("命令")}
  add <名称> --base <url> [--key <k> | --key-env VAR] [--api <api>] [--api-rule 正则=api]
             [--model id1,id2 | --models-file f] [--cost-multiplier 0.2 | --no-cost]
             [--key-in models] [--name 显示名] [--force] [--no-sync] [--dry-run] [--verbose]
  sync <名称> [--keep-missing] [--api-rule ...] [--cost-multiplier 0.2] [--dry-run] [--verbose]
  key <名称> <api-key>          把密钥写进 auth.json
  ls [--models]                 列出所有自定义 provider 与默认模型
  use [名称[#模型] | 关键词]     留空则打开选择器；支持模糊，如 pmh use sonnet
                                [--thinking <级别>] [--allow-builtin]
  scope [pattern...] [--clear]  限制 Ctrl+P 循环范围
  test <名称> [--model id] [--no-chat] [--verbose]
  run [名称[#模型] | 关键词] [-- <传给 pi 的参数>]
  pick [--run]                  ↑↓ 方向键选择器（可顺手启动 pi）
  install-extension             把 quick-switch 扩展装进 pi，实现 /switch 与快捷键
  alias [--shell powershell|bash]
  rm <名称> [--purge-key]
  doctor

${c.bold("全局参数")}
  --agent-dir <dir>   覆盖 ~/.pi/agent（也可用 PMH_AGENT_DIR）
  --catalog <dir>     覆盖官方模型目录来源
  --proxy <url>       强制走代理（默认读 HTTPS_PROXY/HTTP_PROXY）
`);
}

