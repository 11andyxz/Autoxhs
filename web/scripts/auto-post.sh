#!/bin/zsh
# launchd 调用入口：补齐 PATH、进入 web 目录、用 tsx 跑自动发布脚本，日志追加到 LOG。
# launchd 每 10 分钟唤醒一次；真正发不发由脚本里的排期 + 节流 + 总开关 AUTO_POST_ENABLED 决定。
#
# 手动测试：
#   ./scripts/auto-post.sh --dry-run              # 干跑，不发布
#   ./scripts/auto-post.sh --now --count 2 --privacy 1   # 连发 2 篇「仅自己可见」
set -u

WEB_DIR="/Users/andyxiongzheng/AndyXiongZheng LLC/Autoxhs/web"
NODE_BIN_DIR="/opt/homebrew/bin"
LOG="${AUTO_POST_LOG:-$HOME/Library/Logs/autoxhs-auto-post.log}"

export PATH="$NODE_BIN_DIR:$PATH"
mkdir -p "$(dirname "$LOG")"
cd "$WEB_DIR" || { echo "[$(date '+%F %T')] 找不到 web 目录: $WEB_DIR" >> "$LOG"; exit 1; }

echo "[$(date '+%F %T')] ===== auto-post 触发 =====" >> "$LOG"
"$NODE_BIN_DIR/node" "$WEB_DIR/node_modules/.bin/tsx" "$WEB_DIR/scripts/autoPost.ts" "$@" >> "$LOG" 2>&1
code=$?
echo "[$(date '+%F %T')] ===== 结束（退出码 $code）=====" >> "$LOG"
exit $code
