# 参与贡献

这是一个个人维护的开源项目，欢迎 Issue 和 Pull Request。改动越大，越建议先开 Issue
说明使用场景和方案，避免做完才发现方向不一致。

## 开发环境

- Node.js 20 或更高版本（CI 覆盖 20 / 22 / 24）
- 桌面端开发需要 `npm install` 安装 Electron 与 electron-builder（仅开发依赖）
- Windows、macOS、Linux 均可开发和测试；打包必须在对应系统上执行

```bash
npm install          # 首次
npm test             # 全量自测，不依赖网络与真实 pi 配置
npm run test:ui      # 桌面端 UI 测试，需要 Electron
npm run desktop      # 启动桌面控制台
```

`npm test` 使用进程内打桩和临时目录，不会读取或修改真实的 `~/.pi`。

## 代码约定

- CLI 保持零运行时依赖；新增依赖前请先说明理由。
- 支持 Node 20+ 的 ESM，不引入构建步骤。
- 密钥只写 `~/.pi/agent/auth.json`（`0600`），不写入模型配置、日志、备份或错误信息。
- 所有平台相关路径都要考虑 Windows 反斜杠、空格与大小写差异。
- 改动遵循现有文件结构与命名，不做顺手的大规模格式化。

## 提交与 PR

- 提交信息使用 `type: 简述`，例如 `fix: 修复代理端口解析`、`feat: 支持自定义请求头`。
- 一个 PR 聚焦一件事；附带复现步骤或验证方式。
- 提交前至少运行 `npm test`；涉及桌面端时再跑 `npm run test:ui`。
- 不要提交 `node_modules/`、`release/`、`dist/` 或真实凭据、会话记录。

## 发布

版本号同时覆盖 CLI 与桌面端。发布由维护者执行：更新版本号与 `CHANGELOG.md` → 跑全量测试 →
推送 `main` → 打 `v*` 标签，`release.yml` 会在 Windows、macOS、Linux 上构建并上传产物。

## 安全问题

请按 [SECURITY.md](SECURITY.md) 的说明私密报告，不要开公开 Issue。
