#!/bin/sh
# macOS 双击安装入口（Finder 里双击会用终端运行本文件）
cd "$(dirname "$0")" || exit 1
./install.sh "$@"
status=$?
if [ -t 0 ]; then
  printf '\n按回车关闭窗口…'
  read -r _
fi
exit $status
