#!/bin/zsh
# launchd 调用入口：补齐 PATH、进入 web 目录、用 tsx 跑自动评论脚本，日志追加到 LOG。
# launchd 每小时唤醒一次；真正发不发由脚本里的 24h 闸门 + 总开关 ENGAGE_AUTO_ENABLED 决定。
#
# 手动测试：
#   ./scripts/engage-auto.sh            # 正式（受总开关/闸门约束）
#   ./scripts/engage-auto.sh --dry-run  # 干跑，不发布
set -u

WEB_DIR="/Users/andyxiongzheng/AndyXiongZheng LLC/Autoxhs/web"
NODE_BIN_DIR="/opt/homebrew/bin"
LOG="${ENGAGE_AUTO_LOG:-$HOME/Library/Logs/autoxhs-engage-auto.log}"

export PATH="$NODE_BIN_DIR:$PATH"
mkdir -p "$(dirname "$LOG")"
cd "$WEB_DIR" || { echo "[$(date '+%F %T')] 找不到 web 目录: $WEB_DIR" >> "$LOG"; exit 1; }

echo "[$(date '+%F %T')] ===== engage-auto 触发 =====" >> "$LOG"
"$NODE_BIN_DIR/node" "$WEB_DIR/node_modules/.bin/tsx" "$WEB_DIR/scripts/engageAuto.ts" "$@" >> "$LOG" 2>&1
code=$?
echo "[$(date '+%F %T')] ===== 结束（退出码 $code）=====" >> "$LOG"
exit $code
