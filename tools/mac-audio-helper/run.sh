#!/usr/bin/env bash
# 启动 Autoxhs 的本机辅助程序(抓系统声音 + 屏幕画面给「AI 辅助面试」用)。
# 第一次运行需要在「系统设置 → 隐私与安全性 → 屏幕录制」里放行**你运行它的这个终端 App**,
# 勾上之后把终端完全退出再重开,然后再跑一次。
#
#   bash tools/mac-audio-helper/run.sh
#
# Ctrl-C 退出;退出时会自动删掉握手文件 ~/.autoxhs/helper.json。
set -euo pipefail

cd "$(dirname "$0")"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "这个辅助程序只支持 macOS。" >&2
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "缺少 Swift 编译器。先装命令行工具:xcode-select --install" >&2
  exit 1
fi

# 源码比二进制新(或还没编译)就重新编译
if [[ ! -x autoxhs-helper || main.swift -nt autoxhs-helper ]]; then
  echo "编译中…"
  swiftc -O -o autoxhs-helper main.swift
fi

echo "启动辅助程序(Ctrl-C 退出)。页面上「③ 怎么听到面试官」选「本机系统声音」即可。"
exec ./autoxhs-helper
