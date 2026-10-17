#!/usr/bin/env sh
# pmh 一键安装（macOS / Linux / Termux / WSL）
# 一行命令：
#   curl -fsSL https://raw.githubusercontent.com/enmingxiong821-cloud/pi-model/main/install.sh | sh
# 本地安装：
#   sh install.sh
# 可选参数：
#   --version <tag|main>  版本，默认最新 Release
#   --dir <path>          安装目录，默认 ~/.local/share/pmh
#   --url <地址>          预设中转站地址
#   --copy                复制扩展，而不是登记为 pi 包
#   --no-setup            只安装，不进入配置向导
#   --no-path             不修改 PATH
#   --dry-run             只打印计划
set -eu

REPO="enmingxiong821-cloud/pi-model"
VERSION="latest"
DIR="${PMH_HOME:-$HOME/.local/share/pmh}"
DIR_SET=0
URL=""
SETUP=1
NO_PATH=0
COPY_EXT=0
DRY=0

usage() {
  sed -n '2,17p' "$0" 2>/dev/null || true
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version 需要一个值}"; shift 2 ;;
    --dir) DIR="${2:?--dir 需要一个值}"; DIR_SET=1; shift 2 ;;
    --url) URL="${2:?--url 需要一个值}"; shift 2 ;;
    --copy) COPY_EXT=1; shift ;;
    --no-setup) SETUP=0; shift ;;
    --no-path) NO_PATH=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 Node.js，请先安装 Node 20+：https://nodejs.org" >&2
  echo "  Termux: pkg install nodejs；macOS: brew install node" >&2
  exit 1
fi
NODE_VERSION="$(node -v | sed 's/^v//')"
case "$NODE_VERSION" in
  *[!0-9.]*|"") echo "✗ 无法识别 Node 版本：$NODE_VERSION" >&2; exit 1 ;;
esac
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node 版本过低：$NODE_VERSION（需要 20+）" >&2
  exit 1
fi
echo "✓ Node $NODE_VERSION"

# 当前脚本所在目录有源码时优先本地安装
LOCAL_SRC=""
if [ -f "$0" ]; then
  SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P)" || SELF_DIR=""
  if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/bin/pmh.mjs" ]; then
    LOCAL_SRC="$SELF_DIR"
  fi
fi

IN_PLACE=0
if [ -n "$LOCAL_SRC" ] && [ -d "$LOCAL_SRC/.git" ]; then
  if [ "$DIR_SET" -eq 0 ]; then
    DIR="$LOCAL_SRC"
    IN_PLACE=1
  elif [ "$(CDPATH= cd -- "$DIR" 2>/dev/null && pwd -P)" = "$LOCAL_SRC" ]; then
    IN_PLACE=1
  fi
fi

if [ -z "$LOCAL_SRC" ]; then
  if [ "$VERSION" = "latest" ]; then
    VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)" || VERSION=""
    if [ -z "$VERSION" ]; then
      VERSION="main"
      echo "! 获取最新 Release 失败，改用 main 分支" >&2
    fi
  fi
  case "$VERSION" in
    main|master) ARCHIVE="https://github.com/$REPO/archive/refs/heads/$VERSION.tar.gz" ;;
    *) ARCHIVE="https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz" ;;
  esac
else
  ARCHIVE=""
fi

if [ "$DRY" -eq 1 ]; then
  echo "源码:     ${LOCAL_SRC:-$ARCHIVE}"
  echo "安装目录: $DIR$([ "$IN_PLACE" -eq 1 ] && echo '（仓库原地使用）')"
  echo "PATH:     $([ "$NO_PATH" -eq 1 ] && echo '不修改' || echo "加入可用 bin 目录")"
  echo "配置:     $([ "$SETUP" -eq 1 ] && echo '安装后进入 bootstrap 向导' || echo '跳过')"
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pmh-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

if [ -z "$LOCAL_SRC" ]; then
  echo "==> 下载 pmh $VERSION"
  if ! command -v curl >/dev/null 2>&1; then
    echo "✗ 需要 curl 才能下载安装包" >&2
    exit 1
  fi
  curl -fL --retry 2 -o "$TMP/pmh.tar.gz" "$ARCHIVE"
  mkdir -p "$TMP/src"
  tar -xzf "$TMP/pmh.tar.gz" -C "$TMP/src" --strip-components=1
  LOCAL_SRC="$TMP/src"
fi

[ -f "$LOCAL_SRC/bin/pmh.mjs" ] || {
  echo "✗ 安装包不完整：缺少 bin/pmh.mjs" >&2
  exit 1
}

copy_tree() {
  src="$1"
  dst="$2"
  mkdir -p "$dst"
  (cd "$src" && tar -cf - bin src extensions package.json README.md README.en.md LICENSE) \
    | (cd "$dst" && tar -xf -)
}

if [ "$IN_PLACE" -eq 0 ]; then
  echo "==> 安装到 $DIR"
  if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null || true)" ]; then
    BACKUP="$DIR.bak-$(date +%Y%m%d%H%M%S)"
    mv "$DIR" "$BACKUP"
    echo "! 旧版本已备份到 $BACKUP"
  fi
  copy_tree "$LOCAL_SRC" "$DIR"
fi
chmod +x "$DIR/bin/pmh" "$DIR/bin/pmh.mjs"
echo "✓ pmh 已就位：$DIR"

# 选一个可写、通常已在 PATH 里的 bin 目录做软链
if [ "$NO_PATH" -eq 0 ]; then
  LINK_DIR=""
  for d in "$HOME/.local/bin" "${PREFIX:-}/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
    [ -n "$d" ] && [ "$d" != "/bin" ] || continue
    if [ -d "$d" ] && [ -w "$d" ]; then LINK_DIR="$d"; break; fi
  done
  if [ -z "$LINK_DIR" ]; then
    LINK_DIR="$HOME/.local/bin"
    mkdir -p "$LINK_DIR"
  fi
  ln -sf "$DIR/bin/pmh" "$LINK_DIR/pmh"
  echo "✓ 已链接 $LINK_DIR/pmh"

  case ":$PATH:" in
    *":$LINK_DIR:"*) ;;
    *)
      MARKER="# pmh: add to PATH"
      LINE="export PATH=\"$LINK_DIR:\$PATH\""
      UPDATED=0
      for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
        [ -f "$rc" ] || continue
        if ! grep -qF "$MARKER" "$rc" 2>/dev/null; then
          printf '\n%s\n%s\n' "$MARKER" "$LINE" >> "$rc"
          echo "✓ 已把 $LINK_DIR 加入 $rc"
          UPDATED=1
        fi
      done
      if [ "$UPDATED" -eq 0 ]; then
        printf '%s\n%s\n' "$MARKER" "$LINE" >> "$HOME/.profile"
        echo "✓ 已把 $LINK_DIR 加入 ~/.profile"
      fi
      if [ -d "$HOME/.config/fish" ]; then
        mkdir -p "$HOME/.config/fish/conf.d"
        printf 'fish_add_path "%s"\n' "$LINK_DIR" > "$HOME/.config/fish/conf.d/pmh.fish"
      fi
      export PATH="$LINK_DIR:$PATH"
      ;;
  esac
fi

if [ "$SETUP" -eq 1 ]; then
  set -- bootstrap
  [ "$COPY_EXT" -eq 1 ] && set -- "$@" --copy
  if [ -n "$URL" ]; then set -- "$@" --base "$URL"; fi
  # curl | sh 时 stdin 是脚本本身，需要从 /dev/tty 读向导输入
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    echo ""
    echo "==> 进入配置向导"
    if ! node "$DIR/bin/pmh.mjs" "$@" < /dev/tty > /dev/tty 2>&1; then
      echo "! 配置未完成，之后可以重新运行：pmh bootstrap" >&2
      exit 1
    fi
  else
    echo ""
    echo "非交互环境，已跳过配置。之后运行：pmh bootstrap"
  fi
fi

echo ""
echo "完成。重开终端后可直接运行 pmh；在 pi 里输入 /switch。"
