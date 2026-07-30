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

# ---- 构建 ----
# arm64 上 **必须**至少有 ad-hoc 签名,否则 launchd 直接拒绝启动(error 153)。
# 而 ad-hoc 签名的指纹按二进制内容算 → 每次重编指纹都变 → TCC 把授权钉在旧指纹上,
# 就会出现「系统设置里显示已开启、程序却被判未授权」这种最难查的状态(实测踩过)。
# 所以:①只在源码**内容**真的变了才重编(不看 mtime);②一旦重编就顺手重置这个
# App 的屏幕录制授权,让系统干净地重新弹一次框,而不是留一条对不上的旧记录。
# 注意:**不能放进 .app 内部** —— codesign 会把 Contents/ 下的未知文件当成待签子组件而失败
HASH_FILE=".build-sha"
SRC_HASH="$(cat main.swift tap.swift | shasum -a 256 | cut -d' ' -f1)"
NEED_BUILD=1
if [[ -x "$BIN" && -f "$HASH_FILE" && "$(cat "$HASH_FILE")" == "$SRC_HASH" ]]; then
  NEED_BUILD=0
fi

if [[ "$NEED_BUILD" == "1" ]]; then
  REBUILD=0
  [[ -x "$BIN" ]] && REBUILD=1
  echo "构建中…(首次约 20 秒)"
  mkdir -p "$APP/Contents/MacOS"
  swiftc -O -o "$BIN" main.swift tap.swift
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
  <key>NSAudioCaptureUsageDescription</key>
  <string>Autoxhs「AI 辅助面试」需要读取这台电脑正在播放的声音,用于实时转写面试官的问题。</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>Autoxhs「AI 辅助面试」需要读取这台电脑正在播放的声音与屏幕画面,用于实时转写面试官的问题。</string>
</dict>
</plist>
PLIST
  # 关键:**显式指定「指定要求」只认标识符,不认二进制指纹**。
  # ad-hoc 签名默认的指定要求是 `cdhash H"…"`,而 macOS 的屏幕录制授权(TCC)会钉住这个要求 ——
  # 于是每次重新编译指纹一变,授权就对不上号:系统设置里开关明明开着,程序却仍被判未授权,
  # 每改一行代码就得重新授权一次(这个坑折腾了好几轮)。
  # 改成 `identifier "com.adxztech.autoxhs.helper"` 之后,重编不影响要求 → **授权一次,永久有效**。
  if ! codesign --force --sign - --identifier com.adxztech.autoxhs.helper \
      --requirements '=designated => identifier "com.adxztech.autoxhs.helper"' "$APP"; then
    echo "codesign 失败 —— arm64 上没签名的 app 无法启动,先解决上面的报错。" >&2
    exit 1
  fi
  echo "$SRC_HASH" > "$HASH_FILE"
  if [[ "$REBUILD" == "1" ]]; then
    # 指定要求只认标识符,重编不会失效 —— 所以这里**不要**再 tccutil reset,
    # 那样只会白白让你重新授权一次。
    echo "源码有改动,已重新编译(屏幕录制授权不受影响,不需要重新授权)。"
  fi
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
