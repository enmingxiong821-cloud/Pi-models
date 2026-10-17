// pi 自动选模型扩展：把 `pmh/auto` 注册成虚拟模型，按每轮用户输入的难度挑物理模型。
//
// 用法（在 pi 里）：
//   /auto                 查看状态与档位映射
//   /auto off             关闭自动升降档（固定用 standard）
//   /auto on              重新开启
//   /auto pin strong      固定档位（off 取消固定）
//   /auto explain <任务>  看分类结果与将使用的模型
//
// 设计要点：
// - 只在 reason === "user" 时重新分类；工具调用、失败重试沿用当前模型，避免 prompt cache 失效。
// - 虚拟模型只记录“选择”，不写 settings.json；会话恢复时不会污染默认模型。
// - 重试失败时升一档（可关），给质量兜底。
import {
  AUTO_MODEL,
  AUTO_PROVIDER,
  TIERS,
  TIER_LABELS,
  bumpTier,
  classifyTask,
  readAutoConfig,
  writeAutoConfig,
} from "./router.mjs";
import {
  checkCompat,
  installedMode,
  piAgentDir,
  probePiApi,
  readSourceMarker,
  repoAvailable,
  staleCopies,
  syncCopiedExtensions,
} from "./compat.mjs";

function lastTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function lastUserText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    return lastTextFromContent(message.content);
  }
  return "";
}

function sessionLastUserText(ctx) {
  try {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const entry = branch[i];
      const message = entry?.message ?? entry;
      if (message?.role !== "user") continue;
      const text = lastTextFromContent(message.content);
      if (text) return text;
    }
  } catch {
    // 会话 API 变化时不影响命令本身
  }
  return "";
}

function modelLabel(model) {
  return model ? `${model.provider}/${model.id}` : "（未解析到）";
}

/**
 * pi 升级检测：每次启动会话时对比版本与扩展 API。
 * copy 模式下顺手把仓库里的最新扩展同步过来（下次启动生效）；
 * package 模式由 pi 直接从仓库加载，无需复制。
 * 任何异常都吞掉，绝不影响 pi 启动。
 */
function registerCompatGuard(pi, notify) {
  if (typeof pi.on !== "function") return;
  pi.on("session_start", (_event, ctx) => {
    try {
      const agentDir = piAgentDir();
      const result = checkCompat(agentDir);
      if (!result.changed) return;
      if (result.firstRun && !result.missing.length) return; // 首次记录不打扰
      const marker = readSourceMarker(agentDir);
      if (marker?.repoRoot && !repoAvailable(marker.repoRoot)) {
        notify(
          ctx,
          `pmh 扩展的仓库路径不存在：${marker.repoRoot}。`
            + "当前已加载的版本仍可用；移动仓库后请重新运行 pmh install-extension。",
          "warning",
        );
        return;
      }
      const synced = marker?.mode === "copy" && marker.repoRoot
        ? syncCopiedExtensions(agentDir, marker.repoRoot, marker.scope)
        : [];
      if (result.missing.length) {
        notify(
          ctx,
          `pi ${result.version ?? "（未知版本）"} 的扩展 API 有变化（缺少 ${result.missing.join("、")}），`
            + "pmh 自动路由已降级；/switch 不受影响。",
          "warning",
        );
        return;
      }
      const from = result.previousVersion ? `${result.previousVersion} → ` : "";
      if (synced.length) {
        notify(ctx, `检测到 pi 更新（${from}${result.version ?? "未知"}），pmh 扩展已自动同步 ${synced.length} 个文件，重启 pi 或 /reload 后生效。`, "info");
      } else if (marker?.mode === "package") {
        notify(ctx, `pi 已更新（${from}${result.version ?? "未知"}），pmh 兼容性校验通过（包模式，随仓库实时更新）。`, "info");
      } else {
        notify(ctx, `pi 已更新（${from}${result.version ?? "未知"}），pmh 兼容性校验通过。`, "info");
      }
    } catch {
      /* 兼容检测失败不能影响 pi 启动 */
    }
  });
}

export default function (pi) {
  const uiNotify = (ctx, message, type = "info") => {
    try {
      ctx?.ui?.notify?.(message, type);
    } catch {
      /* UI 不可用时静默 */
    }
  };

  registerCompatGuard(pi, uiNotify);

  if (typeof pi.registerVirtualModel !== "function") {
    pi.registerCommand("auto", {
      description: "按任务难度自动选模型（需要 pi >= 1.3）",
      handler: async (_args, ctx) => {
        ctx.ui?.notify?.("当前 pi 版本不支持虚拟模型，请先升级 pi（>= 1.3.0）", "warning");
      },
    });
    return;
  }

  const registryOf = (ctx) => ctx.modelRegistry ?? pi.modelRegistry;

  const hasAuth = (ctx, model) => {
    try {
      const reg = registryOf(ctx);
      return !reg?.hasConfiguredAuth || reg.hasConfiguredAuth(model);
    } catch {
      return true;
    }
  };

  const findPhysical = (ctx, spec) => {
    if (!spec?.provider || !spec?.model) return null;
    try {
      const model = registryOf(ctx)?.find?.(spec.provider, spec.model);
      return model && hasAuth(ctx, model) ? model : null;
    } catch {
      return null;
    }
  };

  const firstAvailable = (ctx) => {
    try {
      const models = registryOf(ctx)?.getAvailable?.() ?? [];
      return models[0] ?? null;
    } catch {
      return null;
    }
  };

  /**
   * 优先请求的档位，其次按“强度方向”就近兜底。
   * 例如 strong 没配时退到 standard，而不是直接掉到 cheap。
   */
  const pickTier = (ctx, config, tier) => {
    const order = tier === "strong"
      ? ["strong", "standard", "cheap"]
      : tier === "cheap"
        ? ["cheap", "standard", "strong"]
        : ["standard", "strong", "cheap"];
    for (const candidate of order) {
      const model = findPhysical(ctx, config.tiers[candidate]);
      if (model) return { model, tier: candidate };
    }
    return null;
  };

  const notify = (ctx, message, type = "info") => {
    try {
      ctx.ui?.notify?.(message, type);
    } catch {
      // 无 UI 模式忽略
    }
  };

  const failNoModel = () => {
    throw new Error("pmh auto：没有可用模型。先在终端运行 pmh auto set cheap|standard|strong <provider#model>");
  };

  pi.registerVirtualModel({
    provider: AUTO_PROVIDER,
    id: AUTO_MODEL,
    name: "Auto (pmh)",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    contextWindow: 128000,
    maxTokens: 32768,
    input: ["text", "image"],
    route(request, ctx) {
      const config = readAutoConfig();
      const thinkingLevel = request.thinkingLevel ?? "medium";
      const state = request.state && typeof request.state === "object" ? request.state : {};
      const previous = request.previous?.model;

      // 工具调用 / 扩展消息：完全沿用上一轮的物理模型，保住 prompt cache。
      if (request.reason === "continuation" && previous) {
        return {
          model: previous,
          thinkingLevel: request.previous?.thinkingLevel ?? thinkingLevel,
        };
      }

      // 失败重试：先固定用失败前那个模型；可选升一档，并且每个会话只升一次。
      if (request.reason === "retry") {
        const failed = request.failed?.model;
        if (config.enabled && config.upgradeOnRetry && state.tier && !state.escalated) {
          const nextTier = bumpTier(state.tier);
          if (nextTier !== state.tier) {
            const picked = pickTier(ctx, config, nextTier);
            if (picked && (!failed || picked.model.provider !== failed.provider || picked.model.id !== failed.id)) {
              notify(ctx, `重试失败，升档到${TIER_LABELS[picked.tier]}：${modelLabel(picked.model)}`, "warning");
              return {
                model: picked.model,
                thinkingLevel: request.failed?.thinkingLevel ?? thinkingLevel,
                state: { ...state, tier: picked.tier, escalated: true, why: "失败重试升档" },
              };
            }
          }
        }
        if (failed && hasAuth(ctx, failed)) {
          return { model: failed, thinkingLevel: request.failed?.thinkingLevel ?? thinkingLevel, state };
        }
        const picked = pickTier(ctx, config, state.tier ?? (config.pinned ?? "standard"));
        if (!picked) failNoModel();
        return { model: picked.model, thinkingLevel, state };
      }

      // 压缩摘要、扩展发起的旁路请求：用便宜档省 token，但不要改变会话状态。
      if (request.reason === "direct") {
        const tier = config.enabled ? "cheap" : (config.pinned ?? "standard");
        const picked = pickTier(ctx, config, tier)
          ?? (previous && hasAuth(ctx, previous) ? { model: previous, tier } : null);
        if (picked) return { model: picked.model, thinkingLevel };
        const fallback = firstAvailable(ctx);
        if (fallback) return { model: fallback, thinkingLevel };
        return failNoModel();
      }

      // 新一轮用户输入：这里才做难度判断。
      let tier;
      let reasons;
      if (!config.enabled) {
        tier = config.pinned ?? "standard";
        reasons = ["自动路由已关闭"];
      } else if (config.pinned) {
        tier = config.pinned;
        reasons = ["固定档位"];
      } else {
        const result = classifyTask(lastUserText(request.messages));
        tier = result.tier;
        reasons = result.reasons;
      }

      const picked = pickTier(ctx, config, tier);
      if (!picked) {
        // 没配任何档位时，至少别让会话直接报错：退回上一轮模型或第一个可用模型。
        if (previous && hasAuth(ctx, previous)) {
          return { model: previous, thinkingLevel };
        }
        const fallback = firstAvailable(ctx);
        if (fallback) {
          if (!state.warned) {
            notify(ctx, "pmh auto 还没配置档位，暂时使用第一个可用模型。运行 pmh auto set 配置。", "warning");
            return { model: fallback, thinkingLevel, state: { ...state, warned: true } };
          }
          return { model: fallback, thinkingLevel };
        }
        return failNoModel();
      }

      // 分类档位与当前物理模型一致时不做切换，进一步减少 cache miss。
      const sameModel = previous
        && previous.provider === picked.model.provider
        && previous.id === picked.model.id;
      const changed = state.tier !== picked.tier;
      const nextState = changed || !request.state
        ? { ...state, tier: picked.tier, escalated: false, why: reasons?.join("，") ?? "" }
        : state;

      if (changed && config.enabled && !config.pinned) {
        const why = reasons?.length ? `（${reasons.slice(0, 3).join("，")}）` : "";
        notify(ctx, `自动选模型：${TIER_LABELS[picked.tier]} · ${modelLabel(picked.model)}${why}`);
      }

      return {
        model: sameModel ? previous : picked.model,
        thinkingLevel,
        state: nextState,
      };
    },
  });

  const usage = "用法：/auto status | on | off | pin <cheap|standard|strong|off> | explain <任务> | doctor | sync";

  const statusText = (ctx, config) => {
    const lines = [
      `pmh/auto：${config.enabled ? "已开启" : "已关闭（固定 standard）"}${config.pinned ? ` · 固定 ${config.pinned}` : ""}`,
    ];
    for (const tier of TIERS) {
      const spec = config.tiers[tier];
      const mark = tier === "cheap" ? "轻量" : tier === "strong" ? "强力" : "标准";
      lines.push(`${mark} ${tier}: ${spec ? `${spec.provider}#${spec.model}` : "未配置"}`);
    }
    const current = ctx.model;
    if (current) lines.push(`当前选择：${current.provider}/${current.id}`);
    lines.push("用 /auto off 关闭，/auto pin strong 固定档位");
    return lines.join("\n");
  };

  pi.registerCommand("auto", {
    description: "按任务难度自动选模型：/auto status|on|off|pin|explain|doctor",
    getArgumentCompletions: (prefix) => {
      const items = ["status", "on", "off", "pin", "explain", "doctor", "sync", "cheap", "standard", "strong"];
      const q = String(prefix ?? "").toLowerCase();
      return items.filter((item) => item.startsWith(q)).map((item) => ({ value: item, label: item }));
    },
    handler: async (args, ctx) => {
      const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "status";
      const rest = tokens.slice(1);
      const config = readAutoConfig();

      if (sub === "status" || sub === "ls") {
        notify(ctx, statusText(ctx, config));
        return;
      }
      if (sub === "on" || sub === "off") {
        const enabled = sub === "on";
        const file = writeAutoConfig({ ...config, enabled });
        notify(ctx, enabled ? "已开启自动选模型" : `已关闭自动选模型，固定使用 ${config.pinned ?? "standard"} 档`);
        if (!enabled) notify(ctx, `配置：${file}`, "info");
        return;
      }
      if (sub === "pin") {
        const target = rest[0] ?? "";
        if (!target) {
          notify(ctx, usage, "warning");
          return;
        }
        if (target === "off" || target === "auto" || target === "none") {
          writeAutoConfig({ ...config, pinned: null });
          notify(ctx, "已取消固定档位，恢复按任务难度自动选择");
          return;
        }
        if (!TIERS.includes(target)) {
          notify(ctx, `未知档位 "${target}"，可选：cheap / standard / strong / off`, "warning");
          return;
        }
        writeAutoConfig({ ...config, pinned: target });
        notify(ctx, `已固定使用${TIER_LABELS[target]}档（${target}）`);
        return;
      }
      if (sub === "explain" || sub === "test") {
        const text = rest.join(" ") || sessionLastUserText(ctx);
        if (!text) {
          notify(ctx, "用法：/auto explain <任务描述>（也可以先发一条消息再用 /auto explain）", "warning");
          return;
        }
        const result = classifyTask(text);
        const target = config.pinned ?? result.tier;
        const spec = config.tiers[target];
        const detail = result.reasons.length ? `（${result.reasons.join("，")}）` : "";
        notify(
          ctx,
          `任务：${text.slice(0, 80)}${text.length > 80 ? "…" : ""}\n`
            + `档位：${TIER_LABELS[target]} ${target} · 分数 ${result.score}${detail}\n`
            + `模型：${spec ? `${spec.provider}#${spec.model}` : "该档位未配置"}`,
        );
        return;
      }
      if (sub === "doctor") {
        const agentDir = piAgentDir();
        const probe = probePiApi(agentDir);
        const marker = readSourceMarker(agentDir);
        const mode = marker?.repoRoot ? installedMode(agentDir, marker.repoRoot) : "unknown";
        const repoOk = repoAvailable(marker?.repoRoot);
        const stale = repoOk && mode === "copy" ? staleCopies(agentDir, marker.repoRoot, marker.scope) : [];
        const apiState = probe.known
          ? Object.entries(probe.apis).map(([key, value]) => `${key}=${value ? "ok" : "missing"}`).join(" ")
          : "类型声明不可读（按旧版处理，自动路由会降级）";
        const lines = [
          `pi 版本：${probe.version ?? "未检测到（非 managed install）"}`,
          `扩展 API：${apiState}`,
          `安装方式：${mode === "package" ? "pi 包（随仓库更新）" : mode === "copy" ? "复制到 agent 扩展目录" : mode === "unknown" ? "手动加载（无安装记录）" : "未安装"}`,
          marker?.repoRoot ? `来源仓库：${marker.repoRoot}${repoOk ? "" : "（不存在，请重新运行 pmh install-extension）"}` : "来源仓库：未记录",
          stale.length ? `待同步：${stale.join("、")}（运行 /auto sync）` : "扩展文件：已是最新",
        ];
        notify(ctx, lines.join("\n"));
        return;
      }
      if (sub === "sync") {
        const agentDir = piAgentDir();
        const marker = readSourceMarker(agentDir);
        if (!marker?.repoRoot) {
          notify(ctx, "找不到安装来源记录，请运行 pmh install-extension 重新安装", "warning");
          return;
        }
        if (!repoAvailable(marker.repoRoot)) {
          notify(ctx, `仓库路径不存在：${marker.repoRoot}。请把仓库放回原处，或重新运行 pmh install-extension。`, "warning");
          return;
        }
        if (marker.mode === "package") {
          notify(ctx, "当前是 pi 包模式，扩展直接从仓库加载；更新仓库后重启 pi 即可", "info");
          return;
        }
        const changed = syncCopiedExtensions(agentDir, marker.repoRoot);
        notify(ctx, changed.length ? `已同步 ${changed.length} 个文件，重启 pi 或 /reload 后生效：${changed.join("、")}` : "扩展文件已是最新");
        return;
      }
      notify(ctx, usage, "warning");
    },
  });
}
