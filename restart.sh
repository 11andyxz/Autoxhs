#!/usr/bin/env bash
#
# Autoxhs web dev 一键重启。
#
# 解决「改了代码却好像还在跑旧代码」——常见原因:
#   ① 旧的 next dev 进程没退干净(甚至多实例抢写同一个 .next);
#   ② .next 构建缓存陈旧;
#   ③ 改了 web/.env.local(比如 OPENAI_TTS_VOICE 之类),但没重启——env 只在启动时读一次。
#
# 本脚本做三件事:杀掉占用 dev 端口的旧进程 → 删掉 .next 缓存 → 重新 npm run dev(前台,直接看日志)。
#
# 用法:  ./restart.sh          # 默认端口 3100
#         PORT=3100 ./restart.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$ROOT/web"
PORT="${PORT:-3100}"

echo "▶ [1/3] 停止占用端口 ${PORT} 的旧 dev 进程…"
PIDS="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
if [ -n "${PIDS}" ]; then
  echo "    结束进程: ${PIDS}"
  # shellcheck disable=SC2086
  kill ${PIDS} 2>/dev/null || true
  sleep 1
  PIDS="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
  if [ -n "${PIDS}" ]; then
    echo "    仍在运行,强制结束: ${PIDS}"
    # shellcheck disable=SC2086
    kill -9 ${PIDS} 2>/dev/null || true
  fi
else
  echo "    没有进程占用该端口。"
fi
# 兜底:清掉本项目残留的 next dev(按端口匹配,不会误伤其它项目/端口)。
pkill -f "next dev.*${PORT}" 2>/dev/null || true

echo "▶ [2/3] 清理 .next 构建缓存(保证跑的是最新代码)…"
rm -rf "${WEB}/.next"

echo "▶ [3/3] 启动 dev → http://localhost:${PORT}"
cd "${WEB}"
exec npm run dev
