#!/usr/bin/env bash
# 启动 Autoxhs 的本机辅助程序(抓系统声音 + 屏幕画面给「AI 辅助面试」用)。
#
# 正常用法:在 Autoxhs 页面上点「▶ 启动辅助程序」就行,不用碰终端。
# 手动跑(等价):bash tools/mac-audio-helper/run.sh
#
# 为什么要打成 .app 再用 open 启动:
#   macOS 的「屏幕录制」权限是按**负责进程**授予的。直接跑裸二进制,负责进程是启动它的
#   那个终端 / 编辑器(Terminal、Cursor…),于是「谁启动的」决定有没有权限 —— 换个地方
#   启动就又被拒。打成 .app 用 LaunchServices 启动后,**它自己就是负责进程**:
#   系统设置里会出现一条独立的「Autoxhs Helper」,勾一次,以后谁启动都算它的权限。
#
# 停止:页面上点「停止辅助程序」,或 pkill -f AutoxhsHelper
set -euo pipefail

cd "$(dirname "$0")"

APP="Autoxhs Helper.app"
BIN="$APP/Contents/MacOS/AutoxhsHelper"
LOG="$HOME/.autoxhs/helper.log"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "这个辅助程序只支持 macOS。" >&2
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "缺少 Swift 编译器。先装命令行工具:xcode-select --install" >&2
  exit 1
fi

# 源码比可执行文件新(或还没构建)就重新构建
if [[ ! -x "$BIN" || main.swift -nt "$BIN" ]]; then
  echo "构建中…(首次约 20 秒)"
  mkdir -p "$APP/Contents/MacOS"
  swiftc -O -o "$BIN" main.swift
  cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Autoxhs Helper</string>
  <key>CFBundleDisplayName</key><string>Autoxhs Helper</string>
  <key>CFBundleIdentifier</key><string>com.adxztech.autoxhs.helper</string>
  <key>CFBundleExecutable</key><string>AutoxhsHelper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <!-- 后台运行:不要 Dock 图标、不要菜单栏 -->
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>Autoxhs「AI 辅助面试」需要读取这台电脑正在播放的声音与屏幕画面,用于实时转写面试官的问题。</string>
</dict>
</plist>
PLIST
  # ad-hoc 签名:给这个 bundle 一个稳定身份,权限勾一次就一直有效
  codesign --force --sign - --identifier com.adxztech.autoxhs.helper "$APP" >/dev/null 2>&1 || true
fi

mkdir -p "$HOME/.autoxhs"
: > "$LOG"

# 用 LaunchServices 启动(-n 允许新实例,-g 不抢焦点)。它自己就是 TCC 的负责进程。
open -n -g -a "$PWD/$APP" || {
  echo "启动失败:open -n -a \"$PWD/$APP\"" >&2
  exit 1
}

# 等它把握手文件写出来(或把失败原因写进日志)
for _ in $(seq 1 20); do
  sleep 0.5
  if [[ -f "$HOME/.autoxhs/helper.json" ]]; then
    echo "已启动。要停止:页面上点「停止辅助程序」,或 pkill -f AutoxhsHelper"
    exit 0
  fi
done

echo "还没就绪,日志如下:" >&2
cat "$LOG" >&2 || true
exit 1
