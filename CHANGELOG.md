# 更新日志

版本号遵循语义化版本。桌面端与 CLI 共用同一个版本号。

## 0.7.3 — 2026-10-18

展示与仓库配置更新，无功能变更。

- README 中英文版加入桌面控制台真实截图：模型、站点、自动路由、用量。
- 新增 1280×640 社交预览横幅（`docs/images/social-preview.png`）。
- 新增本更新日志与 `CONTRIBUTING.md`。
- GitHub Actions 升级：`checkout` / `setup-node` / `upload-artifact` 到 v7，`download-artifact` 到 v8。

## 0.7.2 — 2026-10-18

- 修复 macOS 只产出 Apple 芯片安装包的问题。`desktop:dist:mac` 现在显式传入 `--x64 --arm64`，
  Release 同时提供 Intel 与 Apple 芯片的 dmg / zip。

## 0.7.1 — 2026-10-18

- 修复 Windows 会话记录中的项目路径在 macOS / Linux 上无法匹配的问题。
  项目名与路径现在同时兼容 `\` 与 `/` 分隔符，`pmh usage --project` 跨平台结果一致。

## 0.7.0 — 2026-10-18

- 新增桌面控制台：模型、站点、自动路由、用量四个页签；支持搜索、收藏、切换模型，
  编辑站点与模型，替换 / 清除 Key，设置思考等级。
- 新增 `pmh usage`：聚合 pi 会话的输入、输出、缓存、推理 token 与费用，
  支持按日、站点、模型、项目分组，并标记缺少价格的模型。
- 自动路由扩展升级到 v2：轻量 / 标准 / 强力三档、两个阈值、失败自动升档、
  按项目固定档位、可复用模型页的思考等级。
- 桌面端新增 Windows 安装版 / 便携版、macOS dmg / zip、Linux AppImage / deb 构建，
  由 GitHub Actions 在三个原生平台上产出。

## 0.4.2 — 2026-10-17

- 完善仓库协作与安全配置：Issue 表单、PR 模板、Dependabot、Secret Scanning、
  Push Protection、私密漏洞报告与分支保护。
- 安装说明明确以 GitHub Release 为主要分发渠道。

## 0.4.1 — 2026-10-17

- 修复凭据处理、跨平台路径与退出码问题。
- `purge-key` 不再生成包含明文的备份；导入流程不再回显 Key。

## 0.4.0 — 2026-10-17

- 新增跨平台一键安装脚本与 `pmh bootstrap`。
- 安装脚本支持从 GitHub Release 下载，失败时回落 `main`。

## 0.3.0 — 2026-10-17

- 新增 `pmh feedback`：生成脱敏的环境与配置摘要，方便提交问题。

## 0.2.0 — 2026-10-17

- 多站点、多 Key 别名、批量导入与扫描。
- 按任务难度自动选择模型。
- 站点分组、收藏、最近使用与模糊切换。
