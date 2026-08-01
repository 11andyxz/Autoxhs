#!/usr/bin/env bash
# Stop the stack started by ops/run-local.sh.
#
# Terminates gracefully first so Hazelcast leaves the cluster cleanly and the ISO 8583 listener closes
# its socket; only escalates to SIGKILL for anything still alive after the grace period.
set -uo pipefail

cd "$(dirname "$0")/.."
PID_FILE="target/local/pids"

PORTS=(8081 8082 8083 8084 8085 8086 8087 8090 8583 5701)

# Fallback path: the pid file can be missing while processes are very much still running (a deleted
# target/ directory, a stack started by hand). Killing by listening port covers that, and without it
# the next run-local.sh attaches to stale processes and silently runs the previous build.
kill_by_port() {
  local found=0
  for port in "${PORTS[@]}"; do
    for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u); do
      echo "  killing pid $pid holding port $port"
      kill "$pid" 2>/dev/null || true
      found=1
    done
  done
  return $((1 - found))
}

if [[ ! -f "$PID_FILE" ]]; then
  echo "no $PID_FILE -- falling back to killing whatever holds the stack's ports."
  if kill_by_port; then
    sleep 1
    echo "done."
  else
    echo "nothing was listening on ${PORTS[*]}."
  fi
  exit 0
fi

# Read with a while loop rather than mapfile: macOS ships bash 3.2, where mapfile does not exist.
# A script that only runs on the author's machine is not an ops script.
pids=()
while IFS= read -r line; do
  [[ -n "$line" ]] && pids+=("$line")
done < "$PID_FILE"

if [[ ${#pids[@]} -eq 0 ]]; then
  echo "pid file is empty -- falling back to killing by port."
  kill_by_port || echo "nothing was listening."
  rm -f "$PID_FILE"
  exit 0
fi

echo "stopping ${#pids[@]} process(es)..."
for pid in "${pids[@]}"; do
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null && echo "  SIGTERM $pid"
done

for _ in $(seq 1 20); do
  alive=0
  for pid in "${pids[@]}"; do
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && alive=$((alive + 1))
  done
  [[ $alive -eq 0 ]] && break
  sleep 0.5
done

for pid in "${pids[@]}"; do
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "  SIGKILL $pid (did not exit within the grace period)"
    kill -9 "$pid" 2>/dev/null || true
  fi
done

# Anything left listening was not in the pid file; clear it so the next start is clean.
kill_by_port >/dev/null 2>&1 || true

rm -f "$PID_FILE"
echo "stopped. The H2 database is left in place at target/local/ so a demo can be resumed;"
echo "delete target/local to start from an empty vault."
