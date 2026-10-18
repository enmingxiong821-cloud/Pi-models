# 安全策略

## 支持的版本

只维护最新 GitHub Release（当前为 v0.7.0）。更早的版本请先升级再复现问题。

## 报告漏洞

请通过 GitHub 的私密漏洞报告提交，不要开公开 Issue：

https://github.com/enmingxiong821-cloud/pi-model/security/advisories/new

报告中请附上：版本、操作系统与 Node 版本、复现步骤、影响范围。日志请先运行
`pmh feedback --print`，确认已经脱敏；**不要**粘贴 API Key、`auth.json`、站点地址或完整配置原文。

## 响应时间

这是一个个人维护的项目，我会尽力在 7 天内确认，并在 30 天内给出修复或缓解方案。
不提供漏洞赏金。修复发布前请勿公开细节；如果你愿意，我会在 Release Notes 中致谢。

## 在范围内

- 凭据处理：密钥写入错误位置、跨站复用、日志 / 备份 / 报错信息泄露
- 命令注入与路径穿越：`pmh run`、安装脚本、导入解析、启动器参数
- 配置完整性：`models.json` / `auth.json` / `pmh-relays.json` 的非预期覆盖或破坏
- 反馈脱敏：`pmh feedback` 是否可能带出密钥、用户名或站点信息
- 安装脚本：`install.sh` / `install.ps1` 的下载来源、校验与 PATH 修改

## 不在范围内

- 上游中转站或自建网关自身的安全问题
- pi 本体及其依赖的漏洞
- 用户主动把密钥提交到公开仓库或分享给他人
- 需要本机已被完全控制才能利用的问题

## 安全使用建议

- 密钥只放在 `~/.pi/agent/auth.json`，pmh 会以 0600 权限写入
- 共用机器上移除站点时使用 `pmh rm <名称> --purge-key --purge-backups`
- 不要把 `auth.json`、`models.json` 或含明文的备份提交到任何仓库
- 怀疑密钥泄露时，先到中转站后台吊销，再运行 `pmh key` 更换

## English

Report vulnerabilities privately through GitHub Security Advisories:
<https://github.com/enmingxiong821-cloud/pi-model/security/advisories/new>.

Never post API keys, `auth.json`, relay URLs, or unredacted logs in public issues.
This is a personally maintained project; reports are acknowledged on a best-effort basis
within 7 days, with a fix or mitigation target of 30 days. No bug bounty is offered.
