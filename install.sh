#!/usr/bin/env sh
# pi-model-hub 一键安装（macOS / Linux）
#   sh install.sh
set -e

repo="$(cd "$(dirname "$0")" && pwd)"
bin_dir="$repo/bin"

echo
echo "pi-model-hub 安装器"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 Node.js，请先安装 Node 20+：https://nodejs.org"
  exit 1
fi
version="$(node -v | sed 's/^v//')"
major="$(echo "$version" | cut -d. -f1)"
if [ "$major" -lt 20 ]; then
  echo "✗ Node 版本过低：$version（需要 20+）"
  exit 1
fi
echo "✓ Node $version"

# 把 pmh 链到 PATH 里已有的目录（优先 ~/.local/bin）
target=""
for dir in "$HOME/.local/bin" "/usr/local/bin"; do
  if [ -d "$dir" ] && [ -w "$dir" ]; then target="$dir"; break; fi
done
if [ -n "$target" ]; then
  ln -sf "$bin_dir/pmh.mjs" "$target/pmh"
  chmod +x "$bin_dir/pmh.mjs" 2>/dev/null || true
  echo "✓ 已链接 $target/pmh"
else
  echo "! 没找到可写的 bin 目录，手动加 PATH 即可：export PATH=\"$bin_dir:\$PATH\""
fi

# 给 pi 装上 /switch 扩展
if [ -d "$HOME/.pi/agent" ]; then
  node "$bin_dir/pmh.mjs" install-extension
else
  echo "! 没检测到 pi（~/.pi/agent 不存在），装好 pi 后运行：pmh install-extension"
fi

echo
echo "接下来三步："
echo "  1. 重开终端（让 PATH 生效）"
echo "  2. pmh quick —— 地址 + Key 一键接入，Key 可以直接从剪贴板读"
echo "  3. 在 pi 里输入 /reload，然后 /switch 或 Ctrl+Shift+M 切换模型"
echo
