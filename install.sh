#!/usr/bin/env sh
# pi-model-hub 一键安装（macOS / Linux / Termux / WSL）
#   sh install.sh            安装：链接到 PATH + 给 pi 装上 /switch 扩展
#   sh install.sh --no-path  只装扩展，不动 PATH
set -e

repo="$(cd "$(dirname "$0")" && pwd)"
bin_dir="$repo/bin"
no_path=0
[ "$1" = "--no-path" ] && no_path=1

echo
echo "pi-model-hub 安装器"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 Node.js，请先安装 Node 20+：https://nodejs.org"
  echo "  Termux: pkg install nodejs；macOS: brew install node"
  exit 1
fi
version="$(node -v | sed 's/^v//')"
major="$(echo "$version" | cut -d. -f1)"
if [ "$major" -lt 20 ]; then
  echo "✗ Node 版本过低：$version（需要 20+）"
  exit 1
fi
echo "✓ Node $version"

# 找一个可写、且在 PATH 里的 bin 目录并放软链；Termux 用 $PREFIX/bin
if [ "$no_path" -eq 0 ]; then
  target=""
  for dir in "$HOME/.local/bin" "$PREFIX/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
    [ -n "$dir" ] || continue
    if [ -d "$dir" ] && [ -w "$dir" ]; then target="$dir"; break; fi
  done
  if [ -n "$target" ]; then
    chmod +x "$bin_dir/pmh"
    ln -sf "$bin_dir/pmh" "$target/pmh"
    echo "✓ 已链接 $target/pmh"
    case ":$PATH:" in
      *":$target:"*) ;;
      *) echo "! $target 不在当前 PATH 里，把下面这行加进 shell 配置（~/.bashrc / ~/.zshrc）："
         echo "    export PATH=\"$target:\$PATH\"" ;;
    esac
  else
    echo "! 没找到可写的 bin 目录，手动加 PATH：export PATH=\"$bin_dir:\$PATH\""
  fi
fi

# 给 pi 装上 /switch 扩展
if [ -d "$HOME/.pi/agent" ]; then
  node "$bin_dir/pmh.mjs" install-extension
else
  echo "! 没检测到 pi（~/.pi/agent 不存在），装好 pi 后运行：pmh install-extension"
fi

# 顺手提示剪贴板依赖（pmh quick 会用到）
if command -v pbpaste >/dev/null 2>&1 || command -v wl-paste >/dev/null 2>&1 || command -v xclip >/dev/null 2>&1 || command -v termux-clipboard-get >/dev/null 2>&1; then
  echo "✓ 剪贴板工具可用（pmh quick 可以自动读地址和 Key）"
else
  echo "! 没找到剪贴板工具：Debian/Ubuntu 装 wl-clipboard 或 xclip，Termux 装 termux-api"
fi

echo
echo "接下来三步："
echo "  1. 重开终端（让 PATH 生效）"
echo "  2. pmh quick —— 地址 + Key 一键接入，Key 可以直接从剪贴板读"
echo "  3. 在 pi 里输入 /reload，然后 /switch 或 Ctrl+Shift+M 切换模型"
echo
