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

## 安装

```bash
git clone https://github.com/enmingxiong821-cloud/pi-model.git
cd pi-model
node bin/pmh.mjs doctor        # 先体检：会告诉你 pi 装在哪、配置目录是什么
```

三种可选姿势，任选：

1. **直接用**：`node bin/pmh.mjs <命令>`（零依赖，Node 20+ 即可）
2. **加进 PATH**：把仓库的 `bin/` 目录加入 PATH，之后直接敲 `pmh`
3. **当成 pi 包**：`pi install git:github.com/enmingxiong821-cloud/pi-model`
   （仓库根目录就是标准的 pi 包布局，`extensions/` 会被自动加载）

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

# 2) 验证与切换（名称是接入时按域名推断的，比如 crow5）
pmh test crow5
pmh use sonnet          # 关键词模糊匹配，不用记全名
pmh run sonnet          # 直接以这个模型启动 pi
```

已经开着的 pi 里直接 `/model` 搜索、或 `Ctrl+P` 循环切换即可，**不用重启**。

> 没跑安装脚本、也没有 `pmh` 命令时，把上面的 `pmh` 换成 `node bin/pmh.mjs` 即可。

## 在 pi 里秒切（推荐）

```powershell
node bin/pmh.mjs install-extension    # 装到 ~/.pi/agent/extensions/
```

然后在 pi 里 `/reload`（或重启 pi），就有：

| 操作 | 效果 |
|---|---|
| `/switch` | 弹出选择器：**中转站的模型排最前**，● 是当前模型，输入即过滤 |
| `/switch sonnet` | 关键词直接切；唯一命中时一步到位，不弹框 |
| `/switch-save` | 选完顺手写成新会话的默认模型（带备份） |
| `Ctrl+Shift+M` | 快捷键，等同 `/switch` |

选择器里每行还标了上下文窗口和「思考 / 图片 / 中转」能力，键盘 `↑↓` 选、`Enter` 确认、`Esc` 取消。
用 `/hotkeys` 可以确认快捷键已生效。

> 想先试用再装：`pi --extension ./extensions/quick-switch.js`

## 命令

| 命令 | 作用 |
|---|---|
| `pmh add <名称> --base <url> [--key <key>]` | 新增/更新一个 provider，自动发现模型并补全元数据 |
| `pmh sync <名称>` | 重新拉取模型清单（新模型上线后用；保留你手改过的字段） |
| `pmh key <名称> <api-key>` | 单独写/更新密钥（写进 `auth.json`） |
| `pmh ls [--models]` | 看已配置的 provider、凭据来源、默认模型 |
| `pmh use [名称[#模型] \| 关键词]` | 设为默认；留空打开方向键选择器；`pmh use sonnet` 支持模糊 |
| `pmh scope <pattern...>` / `--clear` | 限定 pi 里 `Ctrl+P` 的循环范围 |
| `pmh test <名称> [--model id] [--no-chat]` | 体检：`/v1/models` + 真实最小请求 |
| `pmh run [名称[#模型] \| 关键词] [-- <传给 pi 的参数>]` | 以指定模型启动 pi；留空先选 |
| `pmh pick [--run]` | `↑↓` 方向键选择器，输入即过滤（可顺手启动 pi） |
| `pmh install-extension` | 把 quick-switch 扩展装进 pi（`/switch` + 快捷键） |
| `pmh alias [--shell powershell\|bash]` | 生成 `pi-<provider>` 快捷命令 |
| `pmh rm <名称> [--purge-key]` | 移除 provider（可选连密钥一起删） |
| `pmh doctor` | 环境体检：pi 版本、配置路径、JSON 是否损坏、目录是否可读 |

常用参数：

- `--api openai-completions \| openai-responses \| anthropic-messages`（默认 `openai-completions`）
- `--api-rule "正则=api"`，可重复。例如中转站同时挂 Claude 与 GPT：
  `--api-rule "^claude=anthropic-messages"`（此时 Claude 走 Anthropic 协议，其余走 OpenAI 协议）
- `--cost-multiplier 0.2`：中转站按折扣计价时，把官方价按比例折算
- `--no-cost`：不写价格（不想看到估算费用时）
- `--key-in models`：把密钥写进 `models.json` 而不是 `auth.json`
- `--model a,b,c` / `--models-file f.json`：不自动发现，手动指定模型
- `--agent-dir <dir>` / `--catalog <dir>` / `--proxy <url>` / `--dry-run` / `--verbose`

## 它到底改了什么

一切都写在 pi 自己的配置目录 `~/.pi/agent/`（默认值，可用 `--agent-dir` 或 `PI_CODING_AGENT_DIR` 覆盖）：

| 文件 | 写入内容 |
|---|---|
| `models.json` | `providers.<名称> = { baseUrl, api, models: [...] }` |
| `auth.json` | `{ "<名称>": { "type": "api_key", "key": "..." } }` |
| `settings.json` | `defaultProvider` / `defaultModel` / `defaultThinkingLevel` / `enabledModels` |

每次写入前都会生成 `*.bak-<时间戳>` 备份，随时可以手工回滚。
密钥默认只进 `auth.json`，与 pi 自身的凭据存储一致（也可以用 `--key-in models` 改到 `models.json`）。

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
| [cc-switch](https://github.com/farion1231/cc-switch) | 桌面应用 | 给 Claude Code / Codex 切供应商的标杆；`pmh` 是它在 pi 生态里的轻量对应物 |

`pmh` 自己只做三件事，并且尽量做薄：

1. **接入**：一条命令写 `models.json` + `auth.json`，自动发现模型、自动补元数据；
2. **切换**：pi 内 `/switch` 与 `Ctrl+Shift+M`，命令行侧 `pmh pick` / `pmh use 关键词`；
3. **不搞坏现状**：所有写入先备份，密钥只进 `auth.json`，不碰 pi 的官方文件。

零依赖、纯 Node 标准库，代码量小到可以通读一遍再用。

## 常见问题

**配置了但 `/model` 里看不到？** 依次查：① 凭据是否解析成功（`pmh ls` 的"凭据"列，
未解析到的模型 pi 会隐藏）；② `pmh doctor` 看 `models.json` 是否 JSON 损坏；③ 重启 pi 或用 `/reload`。

**报 401 / 403？** 用 `pmh test <名称>` 定位是 `/v1/models` 还是试聊失败；
有些中转站的模型列表端点不鉴权、聊天端点才鉴权，属正常。

**公司/学校网络要走代理？** Node 的 fetch 默认不读系统代理。本工具对联网命令会自动补
`NODE_USE_ENV_PROXY=1`，也支持 `--proxy http://127.0.0.1:7890`。

**中转站同时支持 Claude 与 GPT？** 用 `--api-rule` 按模型正则指定协议（见上）。

## 自测

```powershell
node tools/smoke-test.mjs          # 进程内打桩，跑通 add/sync/ls/use/模糊切换/装扩展/test/rm
node tools/smoke-test.mjs --real   # 起真实 HTTP 服务 + spawn CLI（需在普通终端里跑）
node tools/extension-test.mjs      # 扩展逻辑单测（12 项，含选择器与凭据缺失分支）
node tools/rpc-test.mjs            # 让真实 pi 以 RPC 模式加载扩展，验证 /switch 真的换了模型
node tools/rpc-test.mjs --discover # 用真实 ~/.pi/agent 验证扩展被自动发现
```

## 目录结构

```
bin/pmh.mjs          命令入口（参数解析、分发、代理自重启）
bin/pmh.cmd          Windows 下免输 node 的启动器
src/paths.mjs        定位 pi 安装、配置目录、官方模型目录
src/util.mjs         原子写 + 备份、终端输出、表格
src/catalog.mjs      官方目录索引、模型 id 归一化匹配、启发式元数据
src/relay.mjs        /v1/models 探测、最小试聊请求、NewAPI 倍率端点
src/match.mjs        模型关键词打分（"sonnet"、"crow5 gemini" 这类写法）
src/picker.mjs       ↑↓ 方向键选择器（非 TTY 自动退化成输序号）
src/commands.mjs     各子命令实现
extensions/quick-switch.js  pi 内的 /switch 扩展（单文件，可单独拷走）
tools/smoke-test.mjs 端到端自测
tools/extension-test.mjs 扩展单测
tools/rpc-test.mjs   真实 pi 的 RPC 集成测试
tools/ws.mjs         检索/抓页小工具
docs/进度与调研.md     调研过程与结论存档
```

## 安全与隐私

- 密钥只写进 pi 自己的 `~/.pi/agent/auth.json`（或你显式指定的 `--key-in models`），
  不会出现在日志、缓存或本仓库里；仓库的 `.gitignore` 也挡掉了 `*.bak-*` 之类的备份文件。
- 工具只读写 pi 的配置目录，不联网上传任何东西；联网只发生在两处：
  拉取你填的中转站 `/v1/models`、以及 `pmh test` 的那条最小试聊请求。
- 共用机器上记得 `pmh rm <名称> --purge-key` 清掉密钥。

## 许可

[MIT](LICENSE)。用之前请自行确认你所接入的中转站服务条款与合规性，本项目只提供配置与切换能力。
