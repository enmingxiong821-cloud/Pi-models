# pi-model（`pmh`）

<p>
  <a href="README.en.md">🇬🇧 English</a> ·
  <a href="README.md">🇨🇳 中文</a>
</p>

![Node](https://img.shields.io/badge/node-%3E%3D20-43853d?logo=node.js&logoColor=white)
![零依赖](https://img.shields.io/badge/dependencies-0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![pi-package](https://img.shields.io/badge/pi-package-5B5BD6)

让 [pi](https://pi.dev) 接上任意第三方 API（中转站 / 自建网关 / OpenRouter / Ollama 之类），
并且随时一键切换模型。

一条命令接入中转站，一个快捷键在 pi 里换模型：

```text
pmh quick                          # 一键：地址 + Key（Key 可先复制到剪贴板）→ 自动读模型 → 挑默认模型
```

```text
pi> /switch  sonnet        # 切模型，中转站排最前
```

## 一键安装

Windows：双击仓库里的 `一键安装.cmd`（或 `powershell -ExecutionPolicy Bypass -File install.ps1`）。
macOS / Linux：`sh install.sh`。

脚本做三件事：检查 Node ≥ 20 → 把 `bin/` 加进 PATH（以后直接敲 `pmh`）→ 如果检测到 pi，顺手把 `/switch` 扩展装好。

## 平台支持

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows 10/11 | ✅ 主力支持 | `pmh.cmd` / `install.ps1` / 剪贴板走 PowerShell |
| macOS | ✅ 支持 | `install.sh`，剪贴板走自带 `pbpaste` |
| Linux 桌面 | ✅ 支持 | `install.sh`，剪贴板走 `wl-paste`（Wayland）或 `xclip`/`xsel`（X11） |
| WSL | ✅ 支持 | 等同 Linux；如果 pi 装在 Windows 侧，用 `--agent-dir /mnt/c/Users/<你>/.pi/agent` 指过去 |
| Termux（Android） | ✅ 支持 | `pkg install nodejs`，剪贴板需 `termux-api`（`termux-clipboard-get`） |
| 无图形终端 / CI | ✅ 支持 | 非 TTY 自动禁用向导与箭头选择器，退化成参数模式（也可用 `PMH_NONINTERACTIVE=1` 强制） |

平台相关的行为都有自测覆盖（`node tools/platform-test.mjs`），CI 在 ubuntu / windows / macOS × Node 20/22/24 上跑这套矩阵。

## 安装

以 GitHub 为主要分发方式，npm 仅作可选补充。

```bash
git clone https://github.com/enmingxiong821-cloud/pi-model.git
cd pi-model
node bin/pmh.mjs doctor        # 先体检：会告诉你 pi 装在哪、配置目录是什么
```

四种可选姿势，任选：

1. **直接用**：`node bin/pmh.mjs <命令>`（零依赖，Node 20+ 即可）
2. **加进 PATH**：把仓库的 `bin/` 目录加入 PATH，之后直接敲 `pmh`
3. **当成 pi 包**：`pi install git:github.com/enmingxiong821-cloud/pi-model`
   （仓库根目录就是标准的 pi 包布局，`package.json` 里已声明 `"pi": { "extensions": [...] }`，
   装完 `/reload` 就有 `/switch`，不必再跑 `install-extension`）
4. **npm（可选）**：`npm i -g pmh-cli`（命令仍是 `pmh`）。
   npm 渠道尚未发布，当前请优先用上面三种；发布后此方式即可用。

## 为什么需要它

pi 的 `/login` 只列内置模型厂商，所以第一次接中转站的人会以为"不支持"。
实际上 pi 原生支持任意兼容端点，只要在 `~/.pi/agent/models.json` 里写一个 provider。
问题在于手写很麻烦：要填 baseUrl、API 协议、密钥位置，还要给每个模型补上下文窗口、
最大输出、是否支持推理、输入模态、价格 —— 否则 pi 的上下文管理和费用显示都不准。

`pmh` 把这些自动化：一条命令接入，元数据自动从 pi 自带的官方模型目录里对齐。

## 30 秒上手

```powershell
# 1) 接入（三种写法任选其一）
pmh quick https://你的中转站域名 sk-xxxx   # 一键：地址+Key → 自动读模型列表 → 挑默认模型
pmh quick                                  # 参数都省了也行：Key 先复制到剪贴板，它会自动认
pmh add                                    # 或者跟着向导走，一个个问
pmh local ollama                           # 本机 Ollama / LM Studio / vLLM 也能一条命令接入

# 2) 验证与切换（名称是接入时按域名推断的，比如 crow5）
pmh test crow5
pmh use sonnet          # 关键词模糊匹配，不用记全名
pmh run sonnet          # 直接以这个模型启动 pi
```

已经开着的 pi 里直接 `/model` 搜索、或 `Ctrl+P` 循环切换即可，**不用重启**。

> 没跑安装脚本、也没有 `pmh` 命令时，把上面的 `pmh` 换成 `node bin/pmh.mjs` 即可。

地址不必自己裁：`https://站/v1/chat/completions`、`…/v1/responses`、`…/v1/models`
这类完整端点会先归一到站点根，再按 `--api` 拼出正确的 `baseUrl`。带不带 `https://` 都认。

本机推理服务用 `pmh local ollama|lmstudio|vllm|sglang|llama-cpp`（`--port` 换端口）：
地址、协议、占位 Key 都会自动填好。本机服务通常不校验 Key，但 pi 解析不到凭据时会隐藏模型，
所以占位 Key 会写进 `models.json`（不碰 `auth.json`）。服务还没启动也能先写配置，之后再 `pmh sync`。

## 在 pi 里秒切（推荐）

```powershell
pmh install-extension --link     # 推荐：登记为 pi 包，直接从本仓库加载
# 或者：pmh install-extension    # 复制到 ~/.pi/agent/extensions/
```

`--link` 只往 pi 的 `settings.json` 里加一条本仓库路径，不复制、不改 pi 本体；
以后 `git pull` 或改代码，重启 pi 就生效。复制模式适合仓库不常驻的场景。

然后在 pi 里 `/reload`（或重启 pi），就有：

| 操作 | 效果 |
|---|---|
| `/switch` | 弹出选择器：**收藏 → 最近使用 → 中转站 → 当前 → 其他**，● 是当前模型，输入即过滤 |
| `/switch sonnet` | 关键词直接切；唯一命中时一步到位，不弹框 |
| `/switch @code sonnet` | 只在分组 `code` 里选；`@fav` 只看收藏，`recent` 只看最近 |
| `/switch relay crow5` | 直接切到该站上次用的模型（失效则用该站第一个） |
| `/switch-save` | 选完顺手写成新会话的默认模型（带备份） |
| `/switch-fav` | 收藏/取消收藏当前模型（只对中转站生效） |
| `/switch-widget [on\|off\|auto]` | 开关站点 widget；`auto`（默认）在 ≥2 个站时显示 |
| `Ctrl+Shift+M` | 快捷键，等同 `/switch` |

过滤条件可以混用：`@组`、`@fav`、`recent`、`reasoning`/`思考`、`image`/`图片`、
`ctx:>=200k`、`provider: crow5`，多个条件取交集。

选择器里每行还标了上下文窗口和「思考 / 图片 / 中转 / ★」标记，键盘 `↑↓` 选、`Enter` 确认、`Esc` 取消。
切换成功后状态栏会显示 `pmh · crow5/sonnet-4-5 · 200K · 思考 · key:default`。
恢复已有会话时（pi 还原上次的模型）**不会**写进「最近使用」，只有你主动切换才算，MRU 排序不会被冷启动打乱。
用 `/hotkeys` 可以确认快捷键已生效。

> 想先试用再装：`pi --extension ./extensions/quick-switch.js`

## 按难度自动选模型（省 token）

pi 里多了一个虚拟模型 `pmh/auto`：你只管提问，它按这轮任务的难度在三个档位里选一个真实模型。

```bash
# 1) 给三个档位各配一个模型（provider#模型）
pmh auto set cheap    crow5#gpt-5-mini
pmh auto set standard crow5#claude-sonnet-4-5
pmh auto set strong   crow5#claude-opus-4-1

# 2) 装扩展（已装过 /switch 的话重跑一次即可，会一并更新）
pmh install-extension --link
```

然后在 pi 里 `/model pmh/auto`。之后：

| 操作 | 效果 |
|---|---|
| `/auto status` | 看开关、各档位模型、当前档位 |
| `/auto off` / `/auto on` | 关闭/开启自动选档（关闭后固定用 `standard`，不再分类） |
| `/auto pin strong` | 临时锁死某一档；`/auto pin off` 解除 |
| `/auto explain 重构鉴权模块` | 只看分类结果，不切模型 |
| `pmh auto explain "..."` | 同一套逻辑在终端里预览（`--json` 可脚本化） |

**分类依据**（纯本地规则，不发额外请求）：架构/重构/并发/底层、报错与堆栈、测试或构建失败、
性能与安全、算法与协议等硬信号升档；格式化、重命名、翻译、解释、注释、单行小改降档；
再叠加多文件路径、代码块、祈使句、提示长度、图片等权重。阈值可调：

```bash
pmh auto thresholds 0.12 0.5    # ≤0.12 → cheap，≥0.5 → strong，中间 standard
```

**省 token 的关键是「一个任务内不来回切」**：分类只发生在你发新消息时，
工具调用续跑（continuation）沿用上一轮的物理模型与思考档，失败重试最多升一档且只升一次。
这样 prompt cache 不会因为自动切换被打断。

配置在 `~/.pi/agent/extension-settings/pmh-auto.json`，**不含任何密钥**；扩展每个请求都会重读，
大多数改动不用重载 pi。三个档位都没配时不会报错，会退回当前可用模型并提示一次。

### pi 升级后会自动适配

`pmh` 不改 pi 本体，只通过 pi 的扩展/包机制接入。每次启动会话时扩展会对比
`install/current-version` 与扩展 API（虚拟模型、命令、会话钩子）：

- **pi 包模式（`--link`）**：扩展直接从仓库加载，`pi update` 升级 pi 后重启即可，pmh 会校验 API 并提示结果。
- **复制模式**：检测到 pi 版本或 API 变化时，自动把仓库里的最新扩展同步到 agent 目录（旧文件留 `*.bak-<时间戳>` 备份），重启后生效。
- API 不兼容时只降级 `/auto` 并给出告警，`/switch` 不受影响；检测失败也绝不阻断 pi 启动。
- 已登记为 pi 包时，`pmh install-extension --copy` 会拒绝执行（避免扩展加载两次）；
  确需复制用 `--force`。仓库被移动/删除时，启动告警并保留当前可用版本。

```bash
pmh auto doctor     # 终端体检：pi 版本、扩展 API、安装方式、来源仓库、待同步文件
pmh auto sync       # 复制模式下手动同步（一般用不到，启动时会自动做）
```

pi 里对应 `/auto doctor` 与 `/auto sync`。

## 命令补全（终端里少打字）

`pmh completion` 会输出对应 shell 的补全脚本，补全子命令、provider、`provider#模型`、`@分组`、`@fav`、`recent` 和常用参数：

```bash
pmh completion powershell | Add-Content $PROFILE    # Windows PowerShell
pmh completion bash >> ~/.bashrc                    # bash
pmh completion zsh >> ~/.zshrc                      # zsh
pmh completion fish > ~/.config/fish/completions/pmh.fish
```

重新打开终端，之后 `pmh use <Tab>` 就能直接列站点和模型。补全只读本地配置，不会发起任何网络请求。

## 反馈问题

遇到问题时运行：

```bash
pmh feedback "切换模型后 pi 报 401"
```

会打印一份脱敏后的报告（pmh/Node/pi 版本、安装方式、配置规模、自动路由状态），并给出预填好的 GitHub Issue 链接。
交互终端会先问你是否打开浏览器；`--open` 直接打开，`--print` 只打印链接，`--json` 输出结构化结果。

报告只有版本与数量：**不含 API Key、站点地址、模型名和用户名**，也不会自动提交——最终内容由你在浏览器里确认。
pi 里也可以直接输入 `/feedback` 获取同样的入口。

## 命令

| 命令 | 作用 |
|---|---|
| `pmh add <名称> [--base <url>] [--key <key>]` | 新增/更新一个 provider，自动发现模型并补全元数据；更新已有站点时可省略地址与协议（沿用原值） |
| `pmh local <ollama\|lmstudio\|vllm\|sglang\|llama-cpp> [--port N] [--as 名称]` | 本机推理服务一键接入：自动填地址/协议/占位 Key，再读模型列表（服务没启动也能先写好配置） |
| `pmh model ls [provider] [--json]` | 列出单个 provider 的 `models` 与 `modelOverrides`，内置 provider 也能看 |
| `pmh model add <provider> <模型id> [--ctx 200k] [--max-output 64k] [--reasoning] [--image] [--cost-in 3 --cost-out 15]` | 在任意 provider（含 pi 内置）下新增/替换一个模型，元数据自动补全 |
| `pmh model override <provider> <模型id> [...同上]` | 只改内置/已有模型的元数据（写 `modelOverrides`），不碰 `api` / `baseUrl` |
| `pmh model rm <provider> <模型id> [--override-only]` | 删除模型条目或它的 override；provider 没有其他内容时会整条清理（避免 pi 报空 provider） |
| `pmh auto status [--json]` | 自动选模型配置：开关、三档模型、阈值、配置文件路径 |
| `pmh auto set <cheap\|standard\|strong> <provider#model>` | 配置档位；也可一次写多组：`auto set cheap=crow5#mini strong=crow5#opus` |
| `pmh auto on\|off` / `unset <档>` / `pin <档\|off>` / `thresholds <cheap> <strong>` | 开关、清空档位、临时固定档位、调整升降档阈值 |
| `pmh auto explain <任务描述> [--json]` | 预览这轮会被分到哪档、用哪个模型（不切模型） |
| `pmh auto install` | 只安装/刷新自动选模型扩展（pi 里选 `pmh/auto`） |
| `pmh import [来源...] [--from clipboard\|claude\|codex\|ccswitch\|all] [--yes] [--dry-run]` | 批量接入：粘贴文本、文件、URL、剪贴板、`ccswitch://` 深链，或扫已有 Claude Code / Codex / cc-switch 配置；去重并预览后再写 |
| `pmh scan` | 只扫描剪贴板和已有配置，列出候选，不写盘 |
| `pmh sync <名称> [--ratio] [--refresh-meta]` | 重新拉取模型清单（新模型上线后用；默认保留你手改过的元数据，`--refresh-meta` 才用上游值覆盖；`--ratio` 同步 NewAPI 倍率价） |
| `pmh key <名称> <api-key>` | 单独写/更新密钥（写进 `auth.json`） |
| `pmh key ls\|add\|use\|rm` | 多 Key 别名：`key add crow5 backup sk-…`、`key use crow5 backup`、`key ls crow5`（打码） |
| `pmh ls [--models] [--group <组>] [--json]` | 看已配置的 provider、凭据来源、默认模型 |
| `pmh current [--json] [--format 模板]` | 当前默认模型一行摘要（纯本地；`--format '{{provider}}/{{model}}'` 自定义输出，别名 `status`） |
| `pmh use [名称[#模型] \| 关键词 \| @组 [关键词] \| @fav \| recent]` | 设为默认；留空打开方向键选择器；`-` 切回上一个默认（CLI 历史） |
| `pmh group ls\|add <名> [--title 显示名]\|rm <名>` | 分组管理（`group add code --title 写代码`） |
| `pmh relay group <名称> <组\|->` | 把站放进/移出分组 |
| `pmh fav add\|rm\|toggle <名称>#<模型>` / `pmh fav ls` | 收藏模型，`/switch @fav` 和选择器都会优先展示 |
| `pmh recent [--limit N]` | 跨站最近使用（CLI 与扩展共用同一份 MRU） |
| `pmh meta <名称> [--drift] [--verbose] [--json]` | 对比上游 `/v1/models` 与实际配置，列出上下文/价格等差异 |
| `pmh scope <pattern...>` / `--clear` | 限定 pi 里 `Ctrl+P` 的循环范围 |
| `pmh test <名称> [--model id] [--no-chat]` | 体检：`/v1/models` + 真实最小请求 |
| `pmh run [名称[#模型] \| 关键词 \| @组 [关键词]] [-- <传给 pi 的参数>]` | 以指定模型启动 pi；留空先选 |
| `pmh pick [--run] [--filter @组]` | `↑↓` 方向键选择器，输入即过滤（可顺手启动 pi） |
| `pmh install-extension [--copy\|--link]` | 装 quick-switch 与 auto-router 扩展；`--link` 推荐（pi 包模式，随仓库更新） |
| `pmh completion [powershell\|bash\|zsh\|fish]` | 输出 shell 补全脚本；不带参数时按 `$SHELL`/平台自动识别 |
| `pmh alias [--shell powershell\|bash]` | 生成 `pi-<provider>` 快捷命令 |
| `pmh rm <名称> [--purge-key [--purge-backups]]` | 移除 provider（可选连密钥和所有 Key 别名一起删；`--purge-backups` 再清掉含该站凭据的旧备份）；顺手清掉 `settings.json` 里指向它的 `defaultProvider` / `enabledModels`，以及回退历史 |
| `pmh doctor` | 环境体检：pi 版本、配置路径、内置 provider 数、`models.json` 结构/模型字段/凭据/默认模型校验、注册表是否陈旧 |
| `pmh feedback [问题描述] [--print\|--open] [--json]` | 生成脱敏环境报告并打开预填的 GitHub Issue（不含 Key / 站点地址 / 模型名，不会自动提交） |

常用参数：

- `--api openai-completions \| openai-responses \| anthropic-messages`（默认 `openai-completions`）
- `--api-rule "正则=api"`，可重复。例如中转站同时挂 Claude 与 GPT：
  `--api-rule "^claude=anthropic-messages"`（此时 Claude 走 Anthropic 协议，其余走 OpenAI 协议）
- `--cost-multiplier 0.2`：中转站按折扣计价时，把官方价按比例折算；`--ratio` 则直接读站点的倍率配置
- `--no-cost` / `--no-reasoning-compat`：不写价格 / 不声明 `reasoning_effort` 兼容位
- `--group <组>` / `--tag a,b`：接入时顺手分组、打标签
- `--key-in models`：把密钥写进 `models.json` 而不是 `auth.json`
- `--key-ref VAR` / `--key-cmd CMD`：不落盘明文，改为在 `models.json` 写 `$VAR` 或 `!命令` 引用（pi 在请求时解析；探测模型列表时 pmh 会临时展开一次）
- `--refresh-meta`：`add`/`sync` 时用上游值覆盖你手改过的元数据（默认保留手改值）
- `--prompt-cache`：从 pi 官方目录透传 `promptCache` 缓存策略（默认不写，保持配置精简）
- `--model a,b,c` / `--models-file f.json`：不自动发现，手动指定模型
- `pmh model` 的参数：`--ctx 200k`、`--max-output 64k`、`--reasoning` / `--no-reasoning`、
  `--image` / `--text-only`、`--cost-in 3 --cost-out 15 [--cache-read 0.3 --cache-write 3.75]`、
  `--name 显示名`、`--override-only`、`--override`
- `--agent-dir <dir>` / `--catalog <dir>` / `--proxy <url>` / `--dry-run` / `--verbose`

## 它到底改了什么

一切都写在 pi 自己的配置目录 `~/.pi/agent/`（默认值，可用 `--agent-dir` 或 `PI_CODING_AGENT_DIR` 覆盖）：

| 文件 | 写入内容 |
|---|---|
| `models.json` | `providers.<名称> = { baseUrl, api, models: [...], modelOverrides: {...} }` |
| `auth.json` | `{ "<名称>": { "type": "api_key", "key": "..." }, "<名称>@<别名>": {...} }` |
| `settings.json` | `defaultProvider` / `defaultModel` / `defaultThinkingLevel` / `enabledModels` |
| `pmh-relays.json` | 只存运维元数据：分组、标签、收藏、MRU、Key 别名、元数据来源；**不含任何密钥** |
| `extension-settings/pmh-auto.json` | 自动选模型的开关、三档模型、阈值、固定档位；**不含任何密钥** |

每次写入前都会生成 `*.bak-<时间戳>` 备份，随时可以手工回滚（MRU 这类高频写入除外）。
密钥默认只进 `auth.json`，与 pi 自身的凭据存储一致（也可以用 `--key-in models` 改到 `models.json`）。
`pmh-relays.json` 丢了也不影响使用，`pmh ls` / 扩展会从 `models.json` + `auth.json` 自动补回来。

## 元数据从哪来

pi 自带一份完整的官方模型目录（43 个数据文件，含 OpenRouter 大目录）。
`pmh` 会读取它，把中转站里"名字和官方一致"的模型对齐过去：

- 精确匹配 → 归一化匹配（去掉 `anthropic/` 这类 vendor 前缀、`:free` 这类后缀、
  日期尾号、`4.5` 与 `4-5` 的点横线差异）→ 模糊匹配 → 启发式兜底。
- 实测接入 OpenRouter 公开模型列表：468 个模型里 427 个命中官方元数据，其余为新兴模型，
  用保守的启发式值估算，等你确认后再手工微调 `models.json` 即可。

价格的语义要留意：默认填的是**官方目录价**，中转站若有折扣，请用 `--cost-multiplier` 折算，
或 `--no-cost` 关掉，避免把估算费用当真。

## 定位与相关项目

同类事情已经有人在做，按需挑一个，也能一起用：

| 项目 | 形态 | 与 `pmh` 的关系 |
|---|---|---|
| [Wing900/Pi-switch](https://github.com/Wing900/Pi-switch) | Go + Wails 桌面 GUI | 图形界面配 provider/模型；`pmh` 是终端优先，且带 pi 内的 `/switch` 快捷键 |
| [Raingor/pi-web-switch](https://github.com/Raingor/pi-web-switch) | Web UI | 浏览器里管 pi 配置；适合喜欢面板的人 |
| [ttimasdf/pi-provider-newapi](https://github.com/ttimasdf/pi-provider-newapi) | pi 扩展 | 专给 NewAPI 网关，能读倍率；`pmh` 走 pi 原生 `models.json`，不挑网关 |
| [cc-switch](https://github.com/farion1231/cc-switch) | 桌面应用 | 给 Claude Code / Codex 切供应商的标杆；`pmh` 是它在 pi 生态里的轻量对应物，且能直接导入它的配置与分享深链 |
| [nicobailon/pi-model-switch](https://github.com/nicobailon/pi-model-switch) | pi 扩展 | 模型别名、`switch_model` 工具与 fallback 链；`pmh` 更偏重"接入 + 配置生成 + 秒切" |
| [Qihuanxishini/pi-model-manager](https://github.com/Qihuanxishini/pi-model-manager) | 终端 TUI | 原生 `models.json` 持久化 + header profiles + 代理路由；`pmh` 零依赖、命令可脚本化，并带 pi 内 `/switch` |
| [playmaker/pi-custom-openai-providers](https://github.com/playmaker/pi-custom-openai-providers) | pi 扩展 | 用 `/custom-providers` 注册多个 OpenAI-compatible provider；`pmh` 额外做模型发现、元数据补全与配置校验 |

`pmh` 自己只做三件事，并且尽量做薄：

1. **接入**：一条命令写 `models.json` + `auth.json`，自动发现模型、自动补元数据；
2. **切换**：pi 内 `/switch` 与 `Ctrl+Shift+M`，命令行侧 `pmh pick` / `pmh use 关键词`；
3. **不搞坏现状**：所有写入先备份，密钥只进 `auth.json`，不碰 pi 的官方文件。

零依赖、纯 Node 标准库，代码量小到可以通读一遍再用。

## 常见问题

**配置了但 `/model` 里看不到？** 依次查：① 凭据是否解析成功（`pmh ls` 的"凭据"列，
未解析到的模型 pi 会隐藏）；② `pmh doctor` 会校验 `models.json` 的结构、模型字段、凭据与默认模型，
并指出 pi 会静默忽略的项；③ 重启 pi 或用 `/reload`。

**报 401 / 403？** 用 `pmh test <名称>` 定位是 `/v1/models` 还是试聊失败；
有些中转站的模型列表端点不鉴权、聊天端点才鉴权，属正常。

**公司/学校网络要走代理？** Node 的 fetch 默认不读系统代理。本工具对联网命令会自动补
`NODE_USE_ENV_PROXY=1`，也支持 `--proxy http://127.0.0.1:7890`。

**中转站同时支持 Claude 与 GPT？** 用 `--api-rule` 按模型正则指定协议（见上）。

**已经在用 cc-switch？** 旧版配置能直接读：`pmh import --from ccswitch`；
新版（SQLite）请在 cc-switch 里用「分享」生成 `ccswitch://v1/import?...` 链接，
`pmh import "ccswitch://…"` 即可（链接里的 `model` 会作为该站的模型清单）。
`app=pi` 的 Gemini 原生协议（`apiFormat=gemini_native`）暂不支持，可用 OpenAI 兼容端点接入。

## 自测

```powershell
npm test                           # 全套（下列除 --real / --discover 外全跑）
node tools/smoke-test.mjs          # v0.1 主流程：add/sync/ls/use/模糊切换/装扩展/test/rm
node tools/args-test.mjs           # 参数解析：重复参数后者生效、可重复项、--no-x、-- 透传
node tools/registry-test.mjs       # 注册表：分组、收藏、MRU、陈旧条目
node tools/keyring-test.mjs        # Key 别名：命名校验、切换留档、删除保护
node tools/metadata-test.mjs       # 上游元数据解析、合并、价格换算
node tools/import-test.mjs         # 批量导入：JSON/YAML/env/curl/pmh:///base64/Codex/Claude
node tools/relay-test.mjs          # 端点归一（rootOf/baseUrlFor）、响应体积上限
node tools/cli-v02-test.mjs        # v0.2 命令面端到端（use -、@组 关键词、current --format、sync 保留手改、Key 引用、清理备份；打桩 fetch）
node tools/native-test.mjs         # 本机服务预设、内置 provider 解析、models.json 校验、model add/override/rm
node tools/router-test.mjs          # 自动选模型：分类器、配置读写、虚拟模型路由、失败升档、CLI
node tools/compat-test.mjs         # pi 版本/API 探测、扩展自同步、包模式与复制模式识别
node tools/feedback-test.mjs       # 反馈：脱敏、诊断计数、Issue 链接编码与截断、三平台打开
node tools/extension-test.mjs      # 扩展逻辑单测（过滤语法、排序、状态栏、widget）
node tools/platform-test.mjs       # Windows/macOS/Linux 启动器、剪贴板、shell 转义
node tools/rpc-test.mjs            # 让真实 pi 以 RPC 模式加载扩展，验证 /switch 真的换了模型
node tools/smoke-test.mjs --real   # 起真实 HTTP 服务 + spawn CLI（需在普通终端里跑）
node tools/rpc-test.mjs --discover # 用真实 ~/.pi/agent 验证扩展被自动发现
```

## 目录结构

```
bin/pmh.mjs          命令入口（分发与代理自重启）
bin/pmh.cmd          Windows 下免输 node 的启动器
src/args.mjs         命令行参数解析（可重复项、--no-x、-- 透传）
src/paths.mjs        定位 pi 安装、配置目录、官方模型目录
src/util.mjs         原子写 + 备份、终端输出、表格、shell 转义
src/catalog.mjs      官方目录索引、模型 id 归一化匹配、启发式元数据
src/native.mjs       pi 原生能力：本机服务预设、内置 provider 索引、models.json 校验
src/relay.mjs        /v1/models 探测、最小试聊请求、NewAPI 倍率端点、响应限流
src/metadata.mjs     上游元数据归一化、合并策略、价格换算
src/registry.mjs     多站注册表：分组、标签、收藏、MRU、元数据来源
src/keyring.mjs      多 Key 别名（活动 Key 写 auth.json，其余写 <relay>@<alias>）
src/import.mjs       批量接入：文本/JSON/YAML/env/curl/订阅解析、去重、扫描已有配置
src/completion.mjs   shell 补全：候选生成与 PowerShell/bash/zsh/fish 脚本
src/feedback.mjs     反馈：脱敏、环境摘要、GitHub Issue 预填链接
src/match.mjs        模型关键词打分（"sonnet"、"crow5 gemini" 这类写法）
src/picker.mjs       ↑↓ 方向键选择器（非 TTY 自动退化成输序号）
src/commands.mjs     各子命令实现
extensions/quick-switch.js  pi 内的 /switch 扩展（单文件，可单独拷走）
extensions/auto-router/     pmh/auto 虚拟模型：index.js（pi 扩展）+ router.mjs（分类器与配置）
                            + compat.mjs（pi 版本/API 探测与扩展自同步，CLI 共用）
tools/*-test.mjs     各模块自测（见上）
tools/ws.mjs         检索/抓页小工具
docs/进度与调研.md     调研过程与结论存档
```

## 文档

想深入理解设计或者参与改动，从 [`docs/README.md`](docs/README.md) 进：

- [`docs/蓝图-v0.2.md`](docs/蓝图-v0.2.md) —— 当前版本蓝图：多站/多 Key、批量接入、pi 内过滤与状态
- [`docs/蓝图.md`](docs/蓝图.md) —— v0.1 蓝图：定位、架构、数据模型、关键决策（ADR）、测试策略
- [`docs/资料/`](docs/资料/) —— 调研资料：pi 的配置与扩展机制、中转站接入约定、同类项目与生态、跨平台适配、全部来源与复核方法
- [`docs/进度与调研.md`](docs/进度与调研.md) —— 按时间记录的过程日志与验证证据

## 安全与隐私

- 密钥只写进 pi 自己的 `~/.pi/agent/auth.json`（或你显式指定的 `--key-in models`），
  不会出现在日志、缓存或本仓库里；`auth.json` 以 `0600` 权限写入，`--json` 模式把诊断信息改走 stderr。
  仓库的 `.gitignore` 也挡掉了 `*.bak-*` 之类的备份文件。
- 工具只读写 pi 的配置目录，不联网上传任何东西；联网只发生在两处：
  拉取你填的中转站 `/v1/models`、以及 `pmh test` 的那条最小试聊请求。
- 共用机器上记得 `pmh rm <名称> --purge-key --purge-backups` 清干净。

## 许可

[MIT](LICENSE)。用之前请自行确认你所接入的中转站服务条款与合规性，本项目只提供配置与切换能力。
