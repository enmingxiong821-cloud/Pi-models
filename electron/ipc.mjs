// IPC 注册与参数校验：不直接依赖 electron，便于在普通 Node 测试中注入桩。
import {
  autoGet, autoPreview, autoSet, buildView, favoriteModel, isValidScope, modelDelete, modelSave, providerDelete,
  providerDetail, providerKeyClear, providerKeySet, providerList, providerSave, refresh, safeError, switchModel,
  thinkingGet, thinkingSet, usageGet, validateTarget,
} from "../src/desktop-service.mjs";

const MAX_QUERY = 128;
const MAX_KEY = 512;
const CONTROL = /[\u0000-\u001f\u007f]/;
const APIS = ["openai-completions", "openai-responses", "anthropic-messages"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const USAGE_GROUPS = ["day", "provider", "model", "project"];
const USAGE_BRANCHES = ["all", "active"];
const USAGE_RANGES = ["today", "7d", "30d", "all"];

export const CHANNELS = [
  "pmh:init",
  "pmh:list",
  "pmh:switch",
  "pmh:favorite",
  "pmh:refresh",
  "pmh:open-agent-dir",
  "pmh:providers",
  "pmh:provider-get",
  "pmh:provider-save",
  "pmh:provider-delete",
  "pmh:key-set",
  "pmh:key-clear",
  "pmh:model-save",
  "pmh:model-delete",
  "pmh:thinking-get",
  "pmh:thinking-set",
  "pmh:auto-get",
  "pmh:auto-set",
  "pmh:auto-preview",
  "pmh:usage",
];

function objectPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("请求参数无效");
  return payload;
}

function text(value, label, { max = 64, required = true, control = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`缺少${label}`);
    return "";
  }
  if (typeof value !== "string") throw new Error(`${label}无效`);
  if (required && !value.trim()) throw new Error(`缺少${label}`);
  if (value.length > max) throw new Error(`${label}过长`);
  if (control && CONTROL.test(value)) throw new Error(`${label}包含控制字符`);
  return value;
}

function providerId(value) {
  return text(value, "站点名", { max: 64 });
}

function modelId(value) {
  return text(value, "模型 id", { max: 128 });
}

function parseListPayload(session, payload) {
  if (payload != null && (typeof payload !== "object" || Array.isArray(payload))) {
    throw new Error("请求参数无效");
  }
  const scopeId = payload?.scopeId ?? "all";
  if (!isValidScope(scopeId, session.scopes)) throw new Error("筛选范围无效");
  const query = payload?.query ?? "";
  if (typeof query !== "string") throw new Error("搜索内容无效");
  if (query.length > MAX_QUERY) throw new Error("搜索内容过长");
  if (CONTROL.test(query)) throw new Error("搜索内容包含控制字符");
  const selectedKey = payload?.selectedKey ?? null;
  if (selectedKey != null) {
    if (typeof selectedKey !== "string" || selectedKey.length > 200) throw new Error("选中项无效");
    if (CONTROL.test(selectedKey)) throw new Error("选中项无效");
  }
  return { scopeId, query, selectedKey };
}

function parseProviderSave(payload) {
  const data = objectPayload(payload);
  const provider = providerId(data.provider);
  const name = text(data.name, "站点名称", { max: 120, required: false });
  const baseUrl = text(data.baseUrl, "站点地址", { max: 2048 });
  const api = data.api === undefined ? "openai-completions" : String(data.api);
  if (!APIS.includes(api)) throw new Error("不支持的 API 类型");
  const key = data.key === undefined || data.key === null
    ? null
    : text(data.key, "Key", { max: MAX_KEY });
  if (key !== null && !key.trim()) throw new Error("Key 不能为空");
  if (data.discover !== undefined && typeof data.discover !== "boolean") throw new Error("discover 需要是布尔值");
  if (data.reuseKey !== undefined && typeof data.reuseKey !== "boolean") throw new Error("reuseKey 需要是布尔值");
  return { provider, name, baseUrl, api, key, discover: data.discover !== false, reuseKey: data.reuseKey === true };
}

function parseModelPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    if (patch === undefined) return {};
    throw new Error("模型参数无效");
  }
  return patch;
}

export function registerHandlers({ ipcMain, session, shell, isTrustedEvent = () => true }) {
  const handle = (channel, task) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedEvent(event)) return { ok: false, error: "来源无效" };
      try {
        return { ok: true, ...(await task(payload)) };
      } catch (err) {
        return { ok: false, error: safeError(err) };
      }
    });
  };

  handle("pmh:init", async () => ({
    agentDir: session.ctx.agentDir,
    view: buildView(session, { scopeId: "all", query: "", selectedKey: null }),
    auto: (await autoGet(session)).auto,
  }));

  handle("pmh:list", async (payload) => {
    const params = parseListPayload(session, payload);
    return { view: buildView(session, params) };
  });

  handle("pmh:switch", async (payload) => {
    const data = objectPayload(payload);
    const target = validateTarget(data.provider, data.model);
    const params = parseListPayload(session, data);
    const result = await switchModel(session, target.provider, target.model);
    return {
      view: buildView(session, { ...params, selectedKey: result.key }),
      notice: { kind: "ok", text: `已切换为 ${result.provider}/${result.model}（下次启动生效）` },
    };
  });

  handle("pmh:favorite", async (payload) => {
    const data = objectPayload(payload);
    const target = validateTarget(data.provider, data.model);
    const params = parseListPayload(session, data);
    const result = await favoriteModel(session, target.provider, target.model);
    return {
      view: buildView(session, { ...params, selectedKey: result.key }),
      notice: { kind: "ok", text: `${result.added ? "已收藏" : "已取消收藏"} ${target.provider}/${target.model}` },
    };
  });

  handle("pmh:refresh", async (payload) => {
    const params = parseListPayload(session, payload);
    refresh(session);
    return { view: buildView(session, params) };
  });

  handle("pmh:open-agent-dir", async () => {
    const error = await shell.openPath(session.ctx.agentDir);
    if (error) throw new Error(`无法打开配置目录：${error}`);
    return {};
  });

  handle("pmh:providers", async () => providerList(session));

  handle("pmh:provider-get", async (payload) => {
    const data = objectPayload(payload);
    return providerDetail(session, providerId(data.provider));
  });

  handle("pmh:provider-save", async (payload) => providerSave(session, parseProviderSave(payload)));

  handle("pmh:provider-delete", async (payload) => {
    const data = objectPayload(payload);
    const provider = providerId(data.provider);
    if (data.confirm !== provider) throw new Error(`请输入站点名“${provider}”确认删除`);
    if (data.force !== undefined && typeof data.force !== "boolean") throw new Error("force 需要是布尔值");
    return providerDelete(session, provider, { confirm: data.confirm, force: data.force === true });
  });

  handle("pmh:key-set", async (payload) => {
    const data = objectPayload(payload);
    const provider = providerId(data.provider);
    const key = text(data.key, "Key", { max: MAX_KEY });
    if (!key.trim()) throw new Error("Key 不能为空");
    return providerKeySet(session, provider, key.trim());
  });

  handle("pmh:key-clear", async (payload) => {
    const data = objectPayload(payload);
    const provider = providerId(data.provider);
    if (data.confirm !== provider) throw new Error(`请输入站点名“${provider}”确认清除 Key`);
    return providerKeyClear(session, provider, { confirm: data.confirm });
  });

  handle("pmh:model-save", async (payload) => {
    const data = objectPayload(payload);
    const provider = providerId(data.provider);
    const model = modelId(data.model);
    const mode = data.mode ?? "add";
    if (mode !== "add" && mode !== "override") throw new Error("模型写入模式无效");
    return modelSave(session, { provider, model, mode, patch: parseModelPatch(data.patch) });
  });

  handle("pmh:model-delete", async (payload) => {
    const data = objectPayload(payload);
    const provider = providerId(data.provider);
    const model = modelId(data.model);
    const expected = `${provider}#${model}`;
    if (data.confirm !== expected) throw new Error(`请输入“${expected}”确认删除`);
    return modelDelete(session, { provider, model, confirm: data.confirm });
  });

  handle("pmh:thinking-get", async (payload) => {
    const data = payload == null ? {} : objectPayload(payload);
    const provider = data.provider == null ? null : providerId(data.provider);
    const model = data.model == null ? null : modelId(data.model);
    if (provider && !model) throw new Error("缺少模型 id");
    return thinkingGet(session, { provider, model });
  });

  handle("pmh:thinking-set", async (payload) => {
    const data = objectPayload(payload);
    const scope = data.scope ?? "global";
    if (scope !== "global" && scope !== "model") throw new Error("思考等级范围无效");
    const level = data.level === null || data.level === "" || data.level === undefined ? null : String(data.level);
    if (level !== null && !THINKING.includes(level)) throw new Error("思考等级无效");
    if (scope === "model") {
      return thinkingSet(session, {
        scope,
        provider: providerId(data.provider),
        model: modelId(data.model),
        level,
      });
    }
    return thinkingSet(session, { scope, level });
  });

  handle("pmh:auto-get", async () => autoGet(session));

  handle("pmh:auto-set", async (payload) => {
    const data = objectPayload(payload);
    return autoSet(session, data);
  });

  handle("pmh:auto-preview", async (payload) => {
    const data = payload == null ? {} : objectPayload(payload);
    const textValue = text(data.text, "任务描述", { max: 4000, required: false });
    const project = data.project == null || data.project === ""
      ? null
      : text(data.project, "项目名", { max: 260 });
    return autoPreview(session, { text: textValue, project });
  });

  handle("pmh:usage", async (payload) => {
    const data = payload == null ? {} : objectPayload(payload);
    const range = data.range ?? "today";
    if (typeof range !== "string") throw new Error("统计范围无效");
    if (!USAGE_RANGES.includes(range) && !/^\d{4}-\d{2}-\d{2}$/.test(range)) throw new Error("统计范围无效");
    const groupBy = data.groupBy ?? "day";
    if (!USAGE_GROUPS.includes(groupBy)) throw new Error("统计维度无效");
    const branch = data.branch ?? "all";
    if (!USAGE_BRANCHES.includes(branch)) throw new Error("分支策略无效");
    const project = data.project == null || data.project === ""
      ? null
      : text(data.project, "项目名", { max: 200 });
    return usageGet(session, { since: range, groupBy, branch, project });
  });
}
