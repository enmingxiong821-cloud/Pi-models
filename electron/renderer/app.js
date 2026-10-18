const api = window.pmh;
const el = {
  tabs: document.getElementById("tabs"),
  views: {
    models: document.getElementById("view-models"),
    sites: document.getElementById("view-sites"),
    auto: document.getElementById("view-auto"),
    usage: document.getElementById("view-usage"),
  },
  current: document.getElementById("current"),
  scopes: document.getElementById("scopes"),
  search: document.getElementById("search"),
  count: document.getElementById("count"),
  list: document.getElementById("list"),
  detail: document.getElementById("detail"),
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  agentDir: document.getElementById("agent-dir"),
  refresh: document.getElementById("refresh"),
  openDir: document.getElementById("open-dir"),
  providerList: document.getElementById("provider-list"),
  siteNew: document.getElementById("site-new"),
  siteEmpty: document.getElementById("site-empty"),
  siteBody: document.getElementById("site-body"),
  siteTitle: document.getElementById("site-title"),
  siteDefault: document.getElementById("site-default"),
  siteHint: document.getElementById("site-hint"),
  siteDelete: document.getElementById("site-delete"),
  providerForm: document.getElementById("provider-form"),
  fProvider: document.getElementById("f-provider"),
  fName: document.getElementById("f-name"),
  fBaseUrl: document.getElementById("f-baseurl"),
  fApi: document.getElementById("f-api"),
  fKey: document.getElementById("f-key"),
  fDiscover: document.getElementById("f-discover"),
  keyStatus: document.getElementById("key-status"),
  keyClear: document.getElementById("key-clear"),
  modelAdd: document.getElementById("model-add"),
  modelRows: document.getElementById("model-rows"),
  modelsEmpty: document.getElementById("models-empty"),
  autoState: document.getElementById("auto-state"),
  autoForm: document.getElementById("auto-form"),
  autoEnabled: document.getElementById("auto-enabled"),
  autoRetry: document.getElementById("auto-retry"),
  autoThinking: document.getElementById("auto-thinking"),
  autoPinned: document.getElementById("auto-pinned"),
  autoCheapThreshold: document.getElementById("auto-cheap-threshold"),
  autoStrongThreshold: document.getElementById("auto-strong-threshold"),
  autoTiers: document.getElementById("auto-tiers"),
  autoThresholds: document.getElementById("auto-thresholds"),
  autoProjects: document.getElementById("auto-projects"),
  autoProjectsEmpty: document.getElementById("auto-projects-empty"),
  autoProjectKey: document.getElementById("auto-project-key"),
  autoProjectTier: document.getElementById("auto-project-tier"),
  autoProjectAdd: document.getElementById("auto-project-add"),
  autoPreviewText: document.getElementById("auto-preview-text"),
  autoPreviewProject: document.getElementById("auto-preview-project"),
  autoPreviewBtn: document.getElementById("auto-preview-btn"),
  autoPreview: document.getElementById("auto-preview"),
  autoIssues: document.getElementById("auto-issues"),
  autoModels: document.getElementById("auto-models"),
  autoSave: document.getElementById("auto-save"),
  usageState: document.getElementById("usage-state"),
  usageCards: document.getElementById("usage-cards"),
  usageRows: document.getElementById("usage-rows"),
  usageEmpty: document.getElementById("usage-empty"),
  usageMissingCard: document.getElementById("usage-missing-card"),
  usageMissing: document.getElementById("usage-missing"),
  usageNote: document.getElementById("usage-note"),
  usageRange: document.getElementById("usage-range"),
  usageGroup: document.getElementById("usage-group"),
  usageBranch: document.getElementById("usage-branch"),
  usageRefresh: document.getElementById("usage-refresh"),
  dialog: document.getElementById("dialog"),
  dialogTitle: document.getElementById("dialog-title"),
  dialogBody: document.getElementById("dialog-body"),
  dialogCancel: document.getElementById("dialog-cancel"),
  dialogOk: document.getElementById("dialog-ok"),
};

const HINT = {
  models: "↑↓ 移动 · Enter 切换 · f 收藏 · / 搜索 · Tab 范围 · r 刷新",
  sites: "左侧选择站点；保存前需填写站点 id、地址与协议",
  auto: "编辑阈值、档位与项目规则；保存后 pi 下一轮请求生效",
  usage: "只读扫描 pi 会话；费用按记录实际值 → models.json → 内置快照依次取用",
};

const API_LABELS = {
  "openai-completions": "OpenAI Chat",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic",
};

const TIER_LABELS = { cheap: "轻量", standard: "标准", strong: "强力" };

const THINKING_OPTIONS = [
  ["", "继承全局"],
  ["off", "off · 关闭"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
];

const state = {
  tab: "models",
  view: null,
  selectedKey: null,
  scopeId: "all",
  query: "",
  busy: false,
  notice: null,
  seq: 0,
  searchTimer: null,
  noticeTimer: null,
  scopeSignature: "",
  providers: [],
  siteId: null,
  siteDetail: null,
  siteNew: false,
  auto: null,
  autoProjects: {},
  usage: null,
  usageParams: { range: "7d", groupBy: "day", branch: "all" },
  usageSeq: 0,
  dialogSubmit: null,
  dialogBusy: false,
  pendingDialog: null,
};

const keyOf = (entry) => `${entry.provider}#${entry.model}`;

function elem(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function span(className, text) {
  return elem("span", className, text);
}

function button(label, className, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function field(labelText, input, className = "") {
  const wrap = elem("label", `field ${className}`.trim());
  wrap.append(span("", labelText), input);
  return wrap;
}

function makeInput({ value = "", type = "text", placeholder = "", maxLength, readOnly = false } = {}) {
  const input = document.createElement("input");
  input.type = type;
  input.value = value ?? "";
  if (placeholder) input.placeholder = placeholder;
  if (maxLength) input.maxLength = maxLength;
  input.readOnly = readOnly;
  input.autocomplete = "off";
  input.spellcheck = false;
  return input;
}

function selectedEntry() {
  return state.view?.entries.find((entry) => keyOf(entry) === state.selectedKey) ?? null;
}

async function call(request) {
  try {
    return await request();
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err ?? "未知错误") };
  }
}

function setNotice(kind, text) {
  clearTimeout(state.noticeTimer);
  state.notice = { kind, text };
  renderStatus();
  state.noticeTimer = setTimeout(() => {
    state.notice = null;
    renderStatus();
  }, 5000);
}

function setBusy(busy) {
  state.busy = busy;
  renderStatus();
}

/* ---------- 页签 ---------- */

function switchTab(tab) {
  if (!el.views[tab]) return;
  state.tab = tab;
  for (const [id, view] of Object.entries(el.views)) view.hidden = id !== tab;
  for (const node of el.tabs.children) {
    const on = node.dataset.tab === tab;
    node.classList.toggle("active", on);
    node.setAttribute("aria-selected", String(on));
  }
  if (tab === "models") {
    render();
    el.list.focus({ preventScroll: true });
  } else if (tab === "sites") {
    loadProviders();
  } else if (tab === "auto") {
    loadAuto();
  } else if (tab === "usage") {
    loadUsage();
  } else {
    renderStatus();
  }
}

/* ---------- 模型页 ---------- */

function renderScopes() {
  const view = state.view;
  const signature = view.scopes.map((scope) => `${scope.id}:${scope.label}:${scope.count}`).join("|");
  if (signature !== state.scopeSignature) {
    state.scopeSignature = signature;
    el.scopes.replaceChildren();
    for (const scope of view.scopes) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.scope = scope.id;
      chip.append(span("chip-label", scope.label), span("chip-count", String(scope.count)));
      chip.addEventListener("click", () => selectScope(scope.id));
      el.scopes.append(chip);
    }
  }
  for (const chip of el.scopes.children) {
    chip.classList.toggle("active", chip.dataset.scope === view.scopeId);
  }
}

function renderList() {
  const view = state.view;
  el.list.replaceChildren();
  if (!view.entries.length) {
    el.list.append(emptyState());
    return;
  }
  for (const entry of view.entries) {
    const key = keyOf(entry);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row";
    row.dataset.key = key;
    row.dataset.current = entry.current ? "1" : "0";
    row.tabIndex = -1;
    row.disabled = state.busy;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(key === state.selectedKey));
    row.title = entry.name && entry.name !== entry.model ? `${key} — ${entry.name}` : key;
    if (key === state.selectedKey) row.classList.add("selected");

    const marker = span("marker", key === state.selectedKey ? "▸" : entry.current ? "●" : "");
    const line = document.createElement("span");
    line.className = "model-line";
    line.append(span("model", key));
    if (entry.name && entry.name !== entry.model) line.append(span("name", entry.name));
    row.append(marker, line, span("meta", metaText(entry)));

    row.addEventListener("click", () => {
      if (state.busy) return;
      selectKey(key);
    });
    row.addEventListener("dblclick", () => {
      if (state.busy) return;
      switchSelected();
    });
    el.list.append(row);
  }
}

function metaText(entry) {
  const parts = [];
  if (entry.contextLabel) parts.push(entry.contextLabel);
  if (entry.reasoning) parts.push("思考");
  if (entry.image) parts.push("图片");
  if (entry.group) parts.push(`@${entry.group}`);
  if (entry.favorite) parts.push("★");
  if (entry.current) parts.push("当前");
  return parts.join(" · ");
}

function emptyState() {
  const view = state.view;
  const box = document.createElement("div");
  box.className = "empty";
  let title = "没有可切换的模型";
  let hint = "先到“站点”页添加中转站，或在终端运行 pmh add。";
  if (view.query) {
    title = `没有匹配“${view.query}”的模型`;
    hint = "换个关键词，或按 Esc 清空搜索。";
  } else if (view.scopeId === "fav") {
    title = "还没有收藏";
    hint = "在列表里按 f，或点击详情里的收藏按钮。";
  } else if (view.scopeId === "recent") {
    title = "还没有使用记录";
    hint = "切换过模型后，最近使用会出现在这里。";
  } else if (view.scopeId.startsWith("group:")) {
    title = "这个分组没有模型";
    hint = "在终端运行 pmh relay group 给站点设置分组。";
  }
  box.append(elem("strong", "", title), elem("span", "", hint));
  return box;
}

function renderDetail() {
  el.detail.replaceChildren();
  const entry = selectedEntry();
  if (!entry) {
    const line = elem("p", "detail-line", state.view?.query ? "没有匹配的模型" : "选择一个模型查看详情");
    el.detail.append(line);
    return;
  }
  for (const text of entry.detailLines) {
    el.detail.append(elem("p", "detail-line", text));
  }

  const thinking = elem("div", "detail-block");
  thinking.append(elem("h3", "", "思考等级"));
  const select = document.createElement("select");
  const currentValue = entry.thinking ?? "";
  for (const [value, label] of THINKING_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "" && entry.thinkingSource === "global" && entry.thinking
      ? `继承全局（${entry.thinking}）`
      : label;
    select.append(option);
  }
  select.value = currentValue;
  select.disabled = state.busy;
  select.addEventListener("change", async () => {
    select.disabled = true;
    const result = await call(() => api.thinkingSet({
      scope: "model",
      provider: entry.provider,
      model: entry.model,
      level: select.value === "" ? null : select.value,
    }));
    select.disabled = false;
    if (!result.ok) {
      setNotice("error", result.error);
      select.value = currentValue;
      return;
    }
    setNotice("ok", select.value === "" ? "已改为继承全局思考等级" : `思考等级已设为 ${select.value}`);
    await loadModels();
  });
  thinking.append(select);
  if (entry.thinkingSource === "model") thinking.append(span("hint", "当前由模型级设置覆盖全局"));
  else if (entry.thinkingSource === "global") thinking.append(span("hint", "继承全局设置"));
  else thinking.append(span("hint", "未设置，使用 pi 默认"));
  el.detail.append(thinking);

  const actions = elem("div", "detail-actions");
  const switchButton = button(entry.current ? "当前默认" : "设为默认", "button primary", switchSelected);
  switchButton.disabled = state.busy || entry.current;
  const favoriteButton = button(entry.favorite ? "取消收藏" : "收藏", "button", toggleFavorite);
  favoriteButton.disabled = state.busy;
  actions.append(switchButton, favoriteButton);
  el.detail.append(actions);
}

function renderStatus() {
  if (!el.statusText) return;
  if (state.busy) {
    el.status.className = "status";
    el.statusText.textContent = "写入中…";
  } else if (state.notice) {
    el.status.className = `status ${state.notice.kind}`;
    el.statusText.textContent = `${state.notice.kind === "error" ? "✖" : "✔"} ${state.notice.text}`;
  } else {
    el.status.className = "status";
    el.statusText.textContent = HINT[state.tab] ?? "";
  }
  const dir = state.view?.agentDir ?? "";
  el.agentDir.textContent = dir ? `配置 ${dir}` : "";
  el.agentDir.title = dir;
}

function render() {
  const view = state.view;
  if (!view) return;
  el.current.textContent = view.currentKey ? `当前默认 ${view.currentKey}` : "默认未设置";
  el.count.textContent = `${view.entries.length} 个模型`;
  renderScopes();
  renderList();
  renderDetail();
  renderStatus();
}

function applyView(view) {
  state.view = view;
  state.scopeId = view.scopeId;
  state.query = view.query ?? "";
  state.selectedKey = view.selectedKey;
  if (el.search.value !== state.query) el.search.value = state.query;
  render();
}

function selectKey(key) {
  state.selectedKey = key;
  for (const row of el.list.querySelectorAll(".row")) {
    const on = row.dataset.key === key;
    row.classList.toggle("selected", on);
    row.setAttribute("aria-selected", String(on));
    row.querySelector(".marker").textContent = on ? "▸" : row.dataset.current === "1" ? "●" : "";
  }
  renderDetail();
  renderStatus();
}

function scrollIntoView() {
  el.list.querySelector(".row.selected")?.scrollIntoView({ block: "nearest" });
}

function moveSelection(delta) {
  if (state.busy || !state.view?.entries.length) return;
  const entries = state.view.entries;
  const current = entries.findIndex((entry) => keyOf(entry) === state.selectedKey);
  const next = Math.max(0, Math.min(entries.length - 1, (current < 0 ? 0 : current) + delta));
  selectKey(keyOf(entries[next]));
  scrollIntoView();
}

function moveTo(index) {
  if (state.busy || !state.view?.entries.length) return;
  const entries = state.view.entries;
  const next = index < 0 ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, index));
  selectKey(keyOf(entries[next]));
  scrollIntoView();
}

function selectScope(scopeId) {
  if (state.busy || scopeId === state.scopeId) return;
  state.scopeId = scopeId;
  state.query = "";
  state.selectedKey = null;
  el.search.value = "";
  loadModels();
}

function cycleScope(delta) {
  if (state.busy || !state.view?.scopes.length) return;
  const scopes = state.view.scopes;
  const index = scopes.findIndex((scope) => scope.id === state.scopeId);
  const next = (index + delta + scopes.length) % scopes.length;
  selectScope(scopes[next].id);
}

async function loadModels() {
  const seq = ++state.seq;
  const result = await call(() =>
    api.list({ scopeId: state.scopeId, query: state.query, selectedKey: state.selectedKey }),
  );
  if (seq !== state.seq) return;
  if (!result.ok) {
    setNotice("error", result.error);
    return;
  }
  applyView(result.view);
}

async function act(request) {
  if (state.busy) return;
  clearTimeout(state.searchTimer);
  state.seq += 1;
  state.busy = true;
  state.notice = null;
  renderList();
  renderDetail();
  renderStatus();
  const result = await call(request);
  state.busy = false;
  if (!result.ok) {
    setNotice("error", result.error);
    renderList();
    renderDetail();
    return;
  }
  applyView(result.view);
  if (result.notice) setNotice(result.notice.kind, result.notice.text);
  else setNotice("ok", "已重新读取配置");
  el.list.focus({ preventScroll: true });
}

async function switchSelected() {
  const entry = selectedEntry();
  if (!entry || state.busy) return;
  if (entry.current) {
    setNotice("ok", "已经是当前默认模型");
    return;
  }
  await act(() =>
    api.switchModel({
      provider: entry.provider,
      model: entry.model,
      scopeId: state.scopeId,
      query: state.query,
      selectedKey: keyOf(entry),
    }),
  );
}

async function toggleFavorite() {
  const entry = selectedEntry();
  if (!entry || state.busy) return;
  await act(() =>
    api.favorite({
      provider: entry.provider,
      model: entry.model,
      scopeId: state.scopeId,
      query: state.query,
      selectedKey: keyOf(entry),
    }),
  );
}

async function refresh() {
  if (state.busy) return;
  if (state.tab === "models") {
    await act(() =>
      api.refresh({ scopeId: state.scopeId, query: state.query, selectedKey: state.selectedKey }),
    );
  } else if (state.tab === "sites") {
    await loadProviders(true);
    if (state.siteId) await loadSite(state.siteId);
  } else if (state.tab === "auto") {
    await loadAuto();
  } else if (state.tab === "usage") {
    await loadUsage();
  }
}

async function openDir() {
  const result = await call(() => api.openAgentDir());
  if (!result.ok) setNotice("error", result.error);
  else setNotice("ok", "已打开配置目录");
}

/* ---------- 站点页 ---------- */

function credentialText(credential) {
  if (!credential?.configured) return "未配置";
  const alias = credential.alias ? ` · 别名 ${credential.alias}` : "";
  return `已配置 · ${credential.source}${alias}`;
}

function renderProviderList() {
  el.providerList.replaceChildren();
  if (!state.providers.length) {
    el.providerList.append(elem("p", "muted pad", "还没有站点，点击右上角“新建”。"));
    return;
  }
  for (const provider of state.providers) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "side-row";
    row.dataset.provider = provider.id;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(provider.id === state.siteId && !state.siteNew));
    if (provider.id === state.siteId && !state.siteNew) row.classList.add("selected");
    const head = elem("span", "side-row-head");
    head.append(span("side-row-name", provider.name), span("side-row-id", provider.id));
    if (provider.isDefault) head.append(span("badge", "默认"));
    const meta = elem("span", "side-row-meta");
    meta.textContent = `${provider.modelCount} 模型 · ${credentialText(provider.credential)}`;
    row.append(head, meta);
    row.addEventListener("click", () => {
      if (!state.busy) loadSite(provider.id);
    });
    el.providerList.append(row);
  }
}

async function loadProviders(force = false) {
  if (!force && state.providers.length) {
    renderProviderList();
    return;
  }
  setBusy(true);
  const result = await call(() => api.providers());
  setBusy(false);
  if (!result.ok) {
    setNotice("error", result.error);
    return;
  }
  state.providers = result.providers;
  renderProviderList();
  renderStatus();
  if (state.siteId && !state.siteNew) {
    const still = state.providers.some((row) => row.id === state.siteId);
    if (!still) showSiteEmpty();
  }
}

function showSiteEmpty() {
  state.siteId = null;
  state.siteDetail = null;
  state.siteNew = false;
  el.siteEmpty.hidden = false;
  el.siteBody.hidden = true;
  renderProviderList();
}

function startNewSite() {
  state.siteNew = true;
  state.siteId = null;
  state.siteDetail = null;
  el.siteEmpty.hidden = true;
  el.siteBody.hidden = false;
  el.siteTitle.textContent = "新建站点";
  el.siteDefault.hidden = true;
  el.siteHint.textContent = "";
  el.providerForm.reset();
  el.fProvider.readOnly = false;
  el.fApi.value = "openai-completions";
  el.fDiscover.checked = true;
  el.fKey.placeholder = "可留空，仅保存站点配置";
  el.siteDelete.disabled = true;
  el.keyClear.disabled = true;
  el.modelAdd.disabled = true;
  el.keyStatus.textContent = "新建站点后可配置 Key";
  el.modelRows.replaceChildren();
  el.modelsEmpty.hidden = false;
  el.modelsEmpty.textContent = "新建站点并探测模型后，这里会显示模型列表。";
  renderProviderList();
  el.fProvider.focus();
  renderStatus();
}

async function loadSite(provider) {
  setBusy(true);
  const result = await call(() => api.providerGet({ provider }));
  setBusy(false);
  if (!result.ok) {
    setNotice("error", result.error);
    return;
  }
  state.siteNew = false;
  state.siteId = provider;
  state.siteDetail = result;
  el.siteEmpty.hidden = true;
  el.siteBody.hidden = false;
  el.siteTitle.textContent = `${result.provider.name} · ${result.provider.id}`;
  el.siteDefault.hidden = !result.provider.isDefault;
  el.siteHint.textContent = "";
  el.fProvider.value = result.provider.id;
  el.fProvider.readOnly = true;
  el.fName.value = result.provider.name === result.provider.id ? "" : result.provider.name;
  el.fBaseUrl.value = result.provider.baseUrl ?? "";
  el.fApi.value = result.provider.api ?? "openai-completions";
  el.fKey.value = "";
  el.fKey.placeholder = "留空则不修改";
  el.fDiscover.checked = false;
  el.siteDelete.disabled = false;
  el.keyClear.disabled = !result.provider.credential.configured;
  el.modelAdd.disabled = false;
  el.keyStatus.textContent = credentialText(result.provider.credential);
  renderModels();
  renderProviderList();
  renderStatus();
}

function renderModels() {
  const detail = state.siteDetail;
  el.modelRows.replaceChildren();
  const models = detail?.models ?? [];
  el.modelsEmpty.hidden = models.length > 0;
  el.modelsEmpty.textContent = models.length ? "" : "这个站点还没有模型。";
  for (const model of models) {
    const tr = document.createElement("tr");
    tr.dataset.model = model.id;
    const nameCell = elem("td", "");
    nameCell.append(span("model", model.id));
    if (model.name && model.name !== model.id) nameCell.append(span("name", model.name));
    tr.append(
      nameCell,
      elem("td", "num", model.contextWindow ? String(model.contextWindow) : "—"),
      elem("td", "num", model.maxTokens ? String(model.maxTokens) : "—"),
      elem("td", "", model.costTier ? `${model.costTier.label}${model.cost?.input != null ? ` · $${model.cost.input}/$${model.cost.output ?? "?"}` : ""}` : "未设置"),
      elem("td", "", model.source === "override" ? "覆盖" : "配置"),
    );
    const actions = elem("td", "row-actions");
    if (model.current) actions.append(span("badge", "当前"));
    actions.append(
      button("编辑", "button small", () => openModelDialog(model)),
      button("删除", "button small danger", () => deleteModelDialog(model)),
    );
    tr.append(actions);
    el.modelRows.append(tr);
  }
}

function rootOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

async function saveProviderForm(event) {
  event.preventDefault();
  if (state.busy) return;
  const provider = el.fProvider.value.trim();
  const baseUrl = el.fBaseUrl.value.trim();
  const key = el.fKey.value;
  if (!provider) {
    setNotice("error", "请填写站点 id");
    el.fProvider.focus();
    return;
  }
  if (!baseUrl) {
    setNotice("error", "请填写站点地址");
    el.fBaseUrl.focus();
    return;
  }

  let reuseKey = false;
  if (!state.siteNew && !key && state.siteDetail) {
    const oldRoot = rootOf(state.siteDetail.provider.baseUrl ?? "");
    const newRoot = rootOf(baseUrl);
    if (oldRoot && newRoot && oldRoot !== newRoot) {
      const confirmed = await askConfirm({
        title: "地址已变更",
        message: `站点地址将从 ${oldRoot} 改为 ${newRoot}，现有 Key 会被继续使用。确认继续？`,
        expected: provider,
        okLabel: "继续保存",
      });
      if (confirmed == null) return;
      reuseKey = true;
    }
  }

  setBusy(true);
  const payload = {
    provider,
    name: el.fName.value.trim(),
    baseUrl,
    api: el.fApi.value,
    discover: el.fDiscover.checked,
    reuseKey,
  };
  if (key) payload.key = key;
  const result = await call(() => api.providerSave(payload));
  setBusy(false);
  if (!result.ok) {
    setNotice("error", result.error);
    return;
  }
  el.fKey.value = "";
  const discovery = result.discovery;
  const saved = result.detail.provider;
  const count = result.detail.models.length;
  const discoveryText = discovery === "ok"
    ? `已探测模型，共 ${count} 个`
    : discovery === "skipped"
      ? `已保存，沿用 ${count} 个模型`
      : `已保存；模型探测失败（${discovery}）`;
  await loadProviders(true);
  await loadSite(saved.id);
  await loadModels();
  el.siteHint.textContent = discoveryText;
  setNotice("ok", `${saved.id} 已保存`);
}

function deleteSiteDialog() {
  const detail = state.siteDetail;
  if (!detail) return;
  const id = detail.provider.id;
  askConfirm({
    title: "删除站点",
    message: detail.provider.isDefault
      ? `“${id}”是当前默认站点，删除后会同时清理默认模型与 Key。此操作不可撤销。`
      : `删除“${id}”会同时移除它的模型、Key 与收藏记录。此操作不可撤销。`,
    expected: id,
    okLabel: "删除站点",
  }).then(async (confirmed) => {
    if (confirmed == null) return;
    setBusy(true);
    const result = await call(() => api.providerDelete({ provider: id, confirm: confirmed, force: true }));
    setBusy(false);
    if (!result.ok) {
      setNotice("error", result.error);
      return;
    }
    state.siteId = null;
    state.siteDetail = null;
    showSiteEmpty();
    await loadProviders(true);
    await loadModels();
    setNotice("ok", `${id} 已删除`);
  });
}

function clearKeyDialog() {
  const detail = state.siteDetail;
  if (!detail) return;
  const id = detail.provider.id;
  askConfirm({
    title: "清除 Key",
    message: `将删除“${id}”在 auth.json 中的活动 Key 与所有别名。`,
    expected: id,
    okLabel: "清除 Key",
  }).then(async (confirmed) => {
    if (confirmed == null) return;
    setBusy(true);
    const result = await call(() => api.keyClear({ provider: id, confirm: confirmed }));
    setBusy(false);
    if (!result.ok) {
      setNotice("error", result.error);
      return;
    }
    await loadSite(id);
    await loadModels();
    setNotice("ok", `已清除 ${id} 的 Key`);
  });
}

/* ---------- 模型编辑 ---------- */

function openModelDialog(model = null) {
  const detail = state.siteDetail;
  if (!detail) return;
  const provider = detail.provider.id;
  const editing = Boolean(model);
  const providerModel = model ?? {};
  const inputs = {
    id: makeInput({ value: providerModel.id ?? "", maxLength: 128, readOnly: editing }),
    name: makeInput({ value: providerModel.name && providerModel.name !== providerModel.id ? providerModel.name : "", maxLength: 200 }),
    contextWindow: makeInput({ value: providerModel.contextWindow ?? "", type: "number" }),
    maxTokens: makeInput({ value: providerModel.maxTokens ?? "", type: "number" }),
    costInput: makeInput({ value: providerModel.cost?.input ?? "", type: "number" }),
    costOutput: makeInput({ value: providerModel.cost?.output ?? "", type: "number" }),
    costRead: makeInput({ value: providerModel.cost?.cacheRead ?? "", type: "number" }),
    costWrite: makeInput({ value: providerModel.cost?.cacheWrite ?? "", type: "number" }),
  };
  const reasoning = document.createElement("input");
  reasoning.type = "checkbox";
  reasoning.checked = Boolean(providerModel.reasoning);
  const image = document.createElement("input");
  image.type = "checkbox";
  image.checked = Boolean(providerModel.image);

  const grid = elem("div", "field-grid");
  grid.append(
    field("模型 id", inputs.id, "span2"),
    field("显示名", inputs.name, "span2"),
    field("上下文窗口", inputs.contextWindow),
    field("最大输出", inputs.maxTokens),
    field("输入价格（USD / 百万 token）", inputs.costInput),
    field("输出价格", inputs.costOutput),
    field("缓存读取价格", inputs.costRead),
    field("缓存写入价格", inputs.costWrite),
  );
  const checks = elem("div", "check-row");
  const reasoningLabel = elem("label", "check");
  reasoningLabel.append(reasoning, span("", "支持推理"));
  const imageLabel = elem("label", "check");
  imageLabel.append(image, span("", "支持图片输入"));
  checks.append(reasoningLabel, imageLabel);
  const body = elem("div", "");
  body.append(grid, checks, elem("p", "muted", "留空表示沿用现有值；价格单位为美元 / 百万 token。"));

  openDialog({
    title: editing ? `编辑 ${providerModel.id}` : `向 ${provider} 添加模型`,
    okLabel: "保存",
    body,
    onSubmit: async () => {
      const id = inputs.id.value.trim();
      if (!id) {
        setNotice("error", "请填写模型 id");
        return false;
      }
      const patch = { reasoning: reasoning.checked, image: image.checked };
      if (inputs.name.value.trim()) patch.name = inputs.name.value.trim();
      for (const key of ["contextWindow", "maxTokens"]) {
        if (inputs[key].value !== "") patch[key] = Number(inputs[key].value);
      }
      const cost = {};
      const costMap = { input: inputs.costInput, output: inputs.costOutput, cacheRead: inputs.costRead, cacheWrite: inputs.costWrite };
      for (const [key, input] of Object.entries(costMap)) {
        if (input.value !== "") cost[key] = Number(input.value);
      }
      if (Object.keys(cost).length) patch.cost = cost;

      setBusy(true);
      const result = await call(() => api.modelSave({
        provider,
        model: id,
        mode: editing ? "override" : "add",
        patch,
      }));
      setBusy(false);
      if (!result.ok) {
        setNotice("error", result.error);
        return false;
      }
      state.siteDetail = result.detail;
      renderModels();
      await loadProviders(true);
      await loadModels();
      setNotice("ok", `${provider}#${id} 已保存`);
      return true;
    },
  });
}

function deleteModelDialog(model) {
  const provider = state.siteDetail?.provider.id;
  if (!provider) return;
  const expected = `${provider}#${model.id}`;
  askConfirm({
    title: "删除模型",
    message: `将从 ${provider} 移除 ${model.id}（含同名覆盖项）。`,
    expected,
    okLabel: "删除模型",
  }).then(async (confirmed) => {
    if (confirmed == null) return;
    setBusy(true);
    const result = await call(() => api.modelDelete({ provider, model: model.id, confirm: confirmed }));
    setBusy(false);
    if (!result.ok) {
      setNotice("error", result.error);
      return;
    }
    state.siteDetail = result.detail;
    renderModels();
    await loadProviders(true);
    await loadModels();
    setNotice("ok", `${expected} 已删除`);
  });
}

/* ---------- 自动路由 ---------- */

async function loadAuto() {
  setBusy(true);
  const result = await call(() => api.autoGet());
  setBusy(false);
  if (!result.ok) {
    el.autoState.textContent = "读取失败";
    el.autoState.className = "badge off";
    setNotice("error", result.error);
    return;
  }
  state.auto = result.auto;
  renderAuto();
  renderStatus();
}

function tierSpec(value) {
  return value ? `${value.provider}#${value.model}` : "";
}

function renderAutoTiers() {
  const auto = state.auto;
  el.autoTiers.replaceChildren();
  const known = new Set((auto.models ?? []).map((row) => row.spec));
  for (const tier of ["cheap", "standard", "strong"]) {
    const spec = tierSpec(auto.tiers?.[tier]);
    const select = document.createElement("select");
    select.dataset.tier = tier;
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "未配置";
    select.append(empty);
    for (const row of auto.models ?? []) {
      const option = document.createElement("option");
      option.value = row.spec;
      option.textContent = row.spec;
      select.append(option);
    }
    if (spec) {
      if (!known.has(spec)) {
        const missing = document.createElement("option");
        missing.value = spec;
        missing.textContent = `${spec}（不在 models.json）`;
        select.append(missing);
      }
      select.value = spec;
    }
    const note = !spec ? "会向邻近档位回退" : known.has(spec) ? "" : "模型不存在，保存会被拒绝";
    const tr = document.createElement("tr");
    const first = document.createElement("td");
    first.textContent = TIER_LABELS[tier];
    const second = document.createElement("td");
    second.append(select);
    const third = document.createElement("td");
    third.className = "muted";
    third.textContent = note;
    tr.append(first, second, third);
    el.autoTiers.append(tr);
  }
}

function renderAutoProjects() {
  el.autoProjects.replaceChildren();
  const entries = Object.entries(state.autoProjects ?? {})
    .sort(([a], [b]) => a.localeCompare(b));
  el.autoProjectsEmpty.hidden = entries.length > 0;
  for (const [key, pinned] of entries) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "model";
    name.textContent = key;
    const tierCell = document.createElement("td");
    const select = document.createElement("select");
    for (const tier of ["cheap", "standard", "strong"]) {
      const option = document.createElement("option");
      option.value = tier;
      option.textContent = `${TIER_LABELS[tier]} · ${tier}`;
      select.append(option);
    }
    select.value = pinned;
    select.addEventListener("change", () => {
      state.autoProjects[key] = select.value;
    });
    tierCell.append(select);
    const actions = document.createElement("td");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button small";
    remove.textContent = "移除";
    remove.addEventListener("click", () => {
      delete state.autoProjects[key];
      renderAutoProjects();
    });
    actions.append(remove);
    tr.append(name, tierCell, actions);
    el.autoProjects.append(tr);
  }
}

function renderAutoIssues() {
  const issues = state.auto?.validation?.issues ?? [];
  el.autoIssues.replaceChildren();
  if (!issues.length) {
    el.autoIssues.textContent = "配置校验通过";
    return;
  }
  for (const issue of issues) {
    const span = document.createElement("span");
    span.className = `${issue.level} auto-issue`;
    span.textContent = `${issue.level === "error" ? "错误" : "提醒"}：${issue.message}`;
    el.autoIssues.append(span, document.createTextNode("　"));
  }
}

function renderAutoModels() {
  el.autoModels.replaceChildren();
  const models = state.auto?.models ?? [];
  if (!models.length) {
    el.autoModels.append(elem("span", "muted", "models.json 里还没有可用模型。"));
    return;
  }
  for (const row of models) {
    el.autoModels.append(elem("span", "auto-model-chip", row.spec));
  }
}

function renderAuto() {
  const auto = state.auto;
  if (!auto) return;
  el.autoState.textContent = auto.enabled ? "已开启" : "已关闭";
  el.autoState.className = `badge ${auto.enabled ? "on" : "off"}`;
  el.autoEnabled.checked = Boolean(auto.enabled);
  el.autoRetry.checked = Boolean(auto.upgradeOnRetry);
  el.autoThinking.checked = Boolean(auto.useModelThinking);
  el.autoPinned.value = auto.pinned ?? "";
  el.autoCheapThreshold.value = auto.thresholds?.cheap ?? "";
  el.autoStrongThreshold.value = auto.thresholds?.strong ?? "";
  state.autoProjects = Object.fromEntries(
    Object.entries(auto.projects ?? {}).map(([key, rule]) => [key, rule.pinned]),
  );
  renderAutoTiers();
  renderAutoProjects();
  renderAutoIssues();
  renderAutoModels();
  el.autoThresholds.textContent =
    `分数 ≤ ${auto.thresholds?.cheap} 使用轻量档；≥ ${auto.thresholds?.strong} 使用强力档；介于两者之间使用标准档。`;
}

async function saveAuto(event) {
  event.preventDefault();
  const tiers = {};
  for (const select of el.autoTiers.querySelectorAll("select[data-tier]")) {
    tiers[select.dataset.tier] = select.value || null;
  }
  const patch = {
    enabled: el.autoEnabled.checked,
    upgradeOnRetry: el.autoRetry.checked,
    useModelThinking: el.autoThinking.checked,
    pinned: el.autoPinned.value || null,
    thresholds: {
      cheap: Number(el.autoCheapThreshold.value),
      strong: Number(el.autoStrongThreshold.value),
    },
    tiers,
    projects: state.autoProjects,
  };
  setBusy(true);
  const result = await call(() => api.autoSet(patch));
  setBusy(false);
  if (!result.ok) {
    setNotice("error", result.error);
    return;
  }
  state.auto = result.auto;
  renderAuto();
  setNotice("ok", "自动路由配置已保存，pi 下一轮请求生效");
}

function addAutoProject() {
  const key = el.autoProjectKey.value.trim();
  if (!key) {
    setNotice("error", "请填写项目目录名或绝对路径");
    return;
  }
  if (/[*?[\]{}]/.test(key)) {
    setNotice("error", "项目规则不支持通配符或正则");
    return;
  }
  state.autoProjects[key] = el.autoProjectTier.value;
  el.autoProjectKey.value = "";
  renderAutoProjects();
}

async function previewAutoRoute() {
  const text = el.autoPreviewText.value;
  if (!text.trim()) {
    setNotice("error", "请先输入任务描述");
    return;
  }
  const result = await call(() => api.autoPreview({
    text,
    project: el.autoPreviewProject.value.trim() || null,
  }));
  if (!result.ok) {
    setNotice("error", result.error);
    return;
  }
  const preview = result.preview;
  el.autoPreview.replaceChildren();
  el.autoPreview.hidden = false;
  const lines = [
    ["分类档位", `${TIER_LABELS[preview.tier] ?? preview.tier} · ${preview.tier}`],
    ["实际档位", `${TIER_LABELS[preview.effectiveTier] ?? preview.effectiveTier} · ${preview.effectiveTier}`
      + (preview.pinnedSource === "project" ? `（项目固定：${preview.projectRule?.key}）` : preview.pinnedSource === "global" ? "（全局固定）" : "")
      + (preview.enabled ? "" : "（自动路由已关闭）")],
    ["模型", preview.target ?? "该档位未配置"],
    ["分数", String(preview.score)],
    ["信号", preview.reasons?.length ? preview.reasons.join("，") : "无明显信号（按常规任务）"],
  ];
  if (preview.thinking) lines.push(["思考等级", `${preview.thinking}（来自模型页配置）`]);
  for (const [label, value] of lines) {
    const row = document.createElement("div");
    row.append(elem("strong", "", `${label}：`), document.createTextNode(value));
    el.autoPreview.append(row);
  }
}

/* ---------- 用量 ---------- */

const GROUP_LABELS = { day: "按日", provider: "按站点", model: "按模型", project: "按项目" };

function compactTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

function exactTokens(value) {
  return (Number(value) || 0).toLocaleString("en-US");
}

function formatCost(value) {
  const n = Number(value) || 0;
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

async function loadUsage() {
  if (!api?.usage) return;
  const seq = ++state.usageSeq;
  state.usageParams = {
    range: el.usageRange.value,
    groupBy: el.usageGroup.value,
    branch: el.usageBranch.value,
  };
  el.usageState.textContent = "读取中";
  el.usageState.className = "badge";
  const result = await call(() => api.usage(state.usageParams));
  if (seq !== state.usageSeq) return;
  if (!result.ok) {
    state.usage = null;
    el.usageState.textContent = "读取失败";
    el.usageState.className = "badge off";
    setNotice("error", result.error);
    return;
  }
  state.usage = result.usage;
  renderUsage();
}

function usageCard(label, value, title) {
  const card = elem("div", "card stat");
  card.append(elem("span", "stat-label", label), elem("strong", "", value));
  if (title) card.title = title;
  return card;
}

function renderUsage() {
  const usage = state.usage;
  if (!usage) {
    el.usageCards.replaceChildren();
    el.usageRows.replaceChildren();
    el.usageEmpty.hidden = true;
    el.usageMissingCard.hidden = true;
    return;
  }
  const totals = usage.totals ?? {};
  const scan = usage.scan ?? {};
  const records = (usage.groups ?? []).reduce((sum, group) => sum + (group.records ?? 0), 0);

  el.usageState.textContent = `${scan.sessions ?? 0} 个会话`;
  el.usageState.className = `badge ${records > 0 ? "on" : "off"}`;

  const cards = [
    ["合计 Token", compactTokens(totals.totalTokens), exactTokens(totals.totalTokens)],
    ["输入", compactTokens(totals.input), exactTokens(totals.input)],
    ["输出", compactTokens(totals.output), exactTokens(totals.output)],
    ["缓存读", compactTokens(totals.cacheRead), exactTokens(totals.cacheRead)],
    ["缓存写", compactTokens(totals.cacheWrite), exactTokens(totals.cacheWrite)],
    ["费用", formatCost(totals.cost), "按记录实际值 → models.json → 内置快照"],
  ];
  if (totals.reasoning > 0) {
    cards.push(["推理（单列）", compactTokens(totals.reasoning), exactTokens(totals.reasoning)]);
  }
  el.usageCards.replaceChildren(...cards.map(([label, value, title]) => usageCard(label, value, title)));

  const range = usage.range ?? {};
  const branchLabel = state.usageParams.branch === "active" ? "仅活动分支" : "含放弃分支";
  const notes = [
    `${range.from ?? "起始"} → ${range.to ?? ""}`,
    range.timezone,
    GROUP_LABELS[state.usageParams.groupBy] ?? "",
    branchLabel,
    `${scan.files ?? 0} 个文件`,
  ].filter(Boolean);
  if (scan.truncated) notes.push("扫描已截断");
  if (scan.errors) notes.push(`${scan.errors} 行解析失败`);
  if (totals.unknownCostTokens) notes.push(`${compactTokens(totals.unknownCostTokens)} token 缺价`);
  el.usageNote.textContent = notes.join(" · ");

  el.usageRows.replaceChildren();
  for (const group of usage.groups ?? []) {
    const tr = document.createElement("tr");
    const cells = [
      ["", group.label],
      ["num", exactTokens(group.input)],
      ["num", exactTokens(group.output)],
      ["num", exactTokens(group.cacheRead)],
      ["num", exactTokens(group.cacheWrite)],
      ["num", exactTokens(group.tokens)],
      ["num", formatCost(group.cost)],
    ];
    for (const [className, text] of cells) tr.append(elem("td", className, text));
    el.usageRows.append(tr);
  }
  el.usageEmpty.hidden = (usage.groups ?? []).length > 0;

  const missing = usage.missingPrice ?? [];
  el.usageMissingCard.hidden = missing.length === 0;
  el.usageMissing.replaceChildren();
  for (const row of missing) {
    const tr = document.createElement("tr");
    tr.append(
      elem("td", "model", row.key),
      elem("td", "num", exactTokens(row.tokens)),
      elem("td", "num", exactTokens(row.records)),
    );
    el.usageMissing.append(tr);
  }
  renderStatus();
}

/* ---------- 对话框 ---------- */

function openDialog({ title, body, okLabel = "确定", danger = false, onSubmit }) {
  el.dialogTitle.textContent = title;
  el.dialogBody.replaceChildren();
  if (Array.isArray(body)) el.dialogBody.append(...body);
  else el.dialogBody.append(body);
  el.dialogOk.textContent = okLabel;
  el.dialogOk.className = danger ? "button danger" : "button primary";
  state.dialogSubmit = onSubmit;
  state.dialogBusy = false;
  el.dialog.showModal();
  const first = el.dialogBody.querySelector("input:not([readonly]), select");
  if (first) setTimeout(() => first.focus(), 0);
}

function closeDialog() {
  state.dialogSubmit = null;
  el.dialog.close();
}

function askConfirm({ title, message, expected, okLabel = "删除" }) {
  return new Promise((resolve) => {
    const input = makeInput({ placeholder: expected, maxLength: 200 });
    const error = elem("p", "dialog-error", "");
    const body = elem("div", "");
    body.append(
      elem("p", "dialog-text", message),
      field(`输入 ${expected} 确认`, input, "span2"),
      error,
    );
    state.pendingDialog = resolve;
    openDialog({
      title,
      body,
      okLabel,
      danger: true,
      onSubmit: () => {
        if (input.value.trim() !== expected) {
          error.textContent = `请输入 ${expected}`;
          return false;
        }
        state.pendingDialog = null;
        resolve(input.value.trim());
        return true;
      },
    });
  });
}

/* ---------- 事件 ---------- */

el.tabs.addEventListener("click", (event) => {
  const tab = event.target.closest(".tab")?.dataset.tab;
  if (tab) switchTab(tab);
});

el.search.addEventListener("input", () => {
  if (state.busy) return;
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    state.query = el.search.value;
    state.selectedKey = null;
    loadModels();
  }, 80);
});

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (state.tab !== "models") return;
  if (el.dialog.open) return;
  const key = event.key;
  const inSearch = document.activeElement === el.search;
  const active = document.activeElement;
  const onOtherButton =
    active?.tagName === "BUTTON" && !active.classList.contains("row") && (key === "Enter" || key === " ");

  if (key === "Tab") {
    event.preventDefault();
    cycleScope(event.shiftKey ? -1 : 1);
    return;
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    event.preventDefault();
    moveSelection(key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (!inSearch && key === "Home") {
    event.preventDefault();
    moveTo(0);
    return;
  }
  if (!inSearch && key === "End") {
    event.preventDefault();
    moveTo(-1);
    return;
  }
  if (key === "Enter") {
    if (onOtherButton) return;
    event.preventDefault();
    switchSelected();
    return;
  }
  if (key === "Escape") {
    event.preventDefault();
    if (state.query) {
      state.query = "";
      state.selectedKey = null;
      el.search.value = "";
      loadModels();
    } else {
      el.search.blur();
      el.list.focus({ preventScroll: true });
    }
    return;
  }
  if (inSearch || onOtherButton) return;
  if (key === "/") {
    event.preventDefault();
    el.search.focus();
    el.search.select();
    return;
  }
  if (key === "f") {
    event.preventDefault();
    toggleFavorite();
    return;
  }
  if (key === "r") {
    event.preventDefault();
    refresh();
  }
});

async function submitDialog() {
  if (!state.dialogSubmit) {
    closeDialog();
    return;
  }
  if (state.dialogBusy) return;
  state.dialogBusy = true;
  try {
    const keepOpen = (await state.dialogSubmit()) === false;
    if (!keepOpen) closeDialog();
  } catch (err) {
    setNotice("error", String(err?.message ?? err ?? "操作失败"));
  } finally {
    state.dialogBusy = false;
  }
}

el.dialogOk.addEventListener("click", submitDialog);
el.dialog.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  if (event.target?.tagName === "BUTTON") return;
  event.preventDefault();
  submitDialog();
});

el.dialogCancel.addEventListener("click", closeDialog);
el.dialog.addEventListener("close", () => {
  state.dialogSubmit = null;
  state.dialogBusy = false;
  el.dialogBody.replaceChildren();
  if (state.pendingDialog) {
    const resolve = state.pendingDialog;
    state.pendingDialog = null;
    resolve(null);
  }
});

el.refresh.addEventListener("click", refresh);
el.openDir.addEventListener("click", openDir);
el.providerForm.addEventListener("submit", saveProviderForm);
el.siteNew.addEventListener("click", startNewSite);
el.siteDelete.addEventListener("click", deleteSiteDialog);
el.keyClear.addEventListener("click", clearKeyDialog);
el.modelAdd.addEventListener("click", () => openModelDialog(null));
el.autoForm.addEventListener("submit", saveAuto);
el.autoProjectAdd.addEventListener("click", addAutoProject);
el.autoPreviewBtn.addEventListener("click", previewAutoRoute);
el.autoPreviewText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    previewAutoRoute();
  }
});
el.usageRefresh.addEventListener("click", loadUsage);
el.usageRange.addEventListener("change", loadUsage);
el.usageGroup.addEventListener("change", loadUsage);
el.usageBranch.addEventListener("change", loadUsage);

/* ---------- 启动 ---------- */

async function init() {
  if (!api) {
    el.status.className = "status error";
    el.statusText.textContent = "桌面接口不可用，请通过 npm run desktop 启动。";
    return;
  }
  const result = await call(() => api.init());
  if (!result.ok) {
    setNotice("error", result.error);
    return;
  }
  applyView(result.view);
  if (result.auto) state.auto = result.auto;
  switchTab("models");
  loadProviders();
}

init();
