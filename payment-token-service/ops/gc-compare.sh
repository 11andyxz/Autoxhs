#!/usr/bin/env bash
#
# The GC tuning A/B (S9.3): run the same load against baseline and tuned JVM flags, then compare the
# pause distributions.
#
# Method matters here. Both arms get:
#   * the same build, the same flag configuration for the service itself (optimized), the same load
#     profile and the same token pool size -- so the only variable is the JVM flag set;
#   * a warm-up run whose numbers are discarded, because JIT compilation dominates the first seconds
#     and would otherwise land in the tail and swamp the thing being measured.
#
# What this can and cannot show on a laptop: the DIRECTION and the MECHANISM (fewer evacuation
# failures, smaller p99.9 pauses) transfer. The absolute millisecond values do not -- they depend on
# core count, memory bandwidth and what else the machine is doing. Reporting one and claiming the
# other is how performance numbers become fiction.
#
# Usage: ops/gc-compare.sh [token_pool] [profile]
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TOKEN_POOL="${1:-400}"
PROFILE="${2:-ramp:100->800/20s,constant:800/60s,spike:1600/15s}"

JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
JAVA="$JAVA_HOME/bin/java"
V="1.0.0-SNAPSHOT"

GC_DIR="$ROOT/target/gc"
DB_URL="jdbc:h2:file:$GC_DIR/pts-gc;AUTO_SERVER=TRUE;DB_CLOSE_DELAY=-1"
HZ_PORT=5741
SEED="gc-bench-shared-hsm-seed-0001"

PIDS=()
trap 'for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done' EXIT

wait_for_health() {
  for _ in $(seq 1 120); do
    curl -sf "http://localhost:$1/actuator/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "!! service on port $1 never became healthy" >&2
  exit 1
}

COMMON=(
  "--spring.datasource.url=$DB_URL"
  "--spring.datasource.username=sa" "--spring.datasource.password="
  "--spring.datasource.driver-class-name=org.h2.Driver"
  "--spring.cloud.config.enabled=false" "--spring.jmx.enabled=false"
  "--pts.hsm.dev-seed=$SEED" "--pts.sim.hop-latency-ms=0"
)

echo "=== building ==="
mvn -o -q -DskipTests package || mvn -q -DskipTests package

rm -rf "$GC_DIR"; mkdir -p "$GC_DIR/logs" "$GC_DIR/reports"

echo "=== base stack ==="
nohup "$JAVA" -jar issuer-simulator/target/issuer-simulator-$V-exec.jar \
    --server.port=8085 "${COMMON[@]}" --spring.sql.init.mode=always \
    "--spring.sql.init.schema-locations=classpath:db/h2/schema.sql" \
    > "$GC_DIR/logs/issuer.log" 2>&1 & PIDS+=($!); wait_for_health 8085

nohup "$JAVA" -jar hazelcast-member/target/hazelcast-member-$V-exec.jar \
    --server.port=8090 "${COMMON[@]}" --spring.sql.init.mode=always \
    "--spring.sql.init.schema-locations=classpath:db/h2/schema.sql" \
    --pts.hazelcast.mode=MEMBER "--pts.hazelcast.port=$HZ_PORT" \
    "--pts.hazelcast.members[0]=127.0.0.1:$HZ_PORT" --pts.hazelcast.backup-count=0 \
    --pts.bins.seed-on-startup=false > "$GC_DIR/logs/hz.log" 2>&1 & PIDS+=($!); wait_for_health 8090

nohup "$JAVA" -jar token-provisioning-service/target/token-provisioning-service-$V-exec.jar \
    --server.port=8081 "${COMMON[@]}" --spring.sql.init.mode=always \
    "--spring.sql.init.schema-locations=classpath:db/h2/schema.sql" \
    --pts.bins.seed-on-startup=true --pts.hazelcast.mode=CLIENT \
    "--pts.hazelcast.members[0]=127.0.0.1:$HZ_PORT" \
    --provisioning.issuer-sim-url=http://localhost:8085 \
    --provisioning.events.transport=IN_MEMORY --provisioning.outbox.enabled=false \
    --provisioning.reconciliation.enabled=false \
    > "$GC_DIR/logs/provisioning.log" 2>&1 & PIDS+=($!); wait_for_health 8081

echo "=== seeding (two disjoint slices, one per arm) ==="
python3 ops/seed-tokens.py --count $((TOKEN_POOL * 2)) --url http://localhost:8081 --concurrency 24

run_arm() {
  local label="$1" offset="$2"; shift 2
  local gc_log="$GC_DIR/logs/gc-$label.log"
  echo
  echo "=== JVM arm: $label ==="
  echo "    flags: $*"

  nohup "$JAVA" "$@" \
      "-Xlog:gc*,safepoint:file=$gc_log:t,uptime,level,tags" \
      -jar detokenization-service/target/detokenization-service-$V-exec.jar \
      --server.port=8082 "${COMMON[@]}" --spring.sql.init.mode=never \
      --pts.bins.seed-on-startup=false \
      --pts.hazelcast.mode=CLIENT "--pts.hazelcast.members[0]=127.0.0.1:$HZ_PORT" \
      --detok.cache-mode=NEAR_CACHE --detok.atc-mode=CLUSTER --detok.controls.inline=true \
      > "$GC_DIR/logs/detok-$label.log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  wait_for_health 8082

  # Warm-up, discarded: JIT compilation dominates the first seconds and would otherwise be
  # attributed to garbage collection.
  echo "    warm-up (discarded)..."
  "$JAVA" -jar loadtest/target/loadtest-$V-exec.jar "${COMMON[@]}" \
      --pts.bins.seed-on-startup=false --load.url=http://localhost:8082 \
      "--load.profile=constant:300/12s" --load.label="warmup-$label" \
      "--load.token-pool=$TOKEN_POOL" "--load.token-offset=$offset" \
      "--load.out=$GC_DIR/reports" > /dev/null 2>&1 || true

  echo "    measured run..."
  "$JAVA" -jar loadtest/target/loadtest-$V-exec.jar "${COMMON[@]}" \
      --pts.bins.seed-on-startup=false --load.url=http://localhost:8082 \
      "--load.profile=$PROFILE" --load.label="$label" \
      "--load.token-pool=$TOKEN_POOL" "--load.token-offset=$offset" \
      "--load.out=$GC_DIR/reports"

  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 60); do
    curl -sf http://localhost:8082/actuator/health >/dev/null 2>&1 || break
    sleep 0.25
  done
  sleep 1
}

run_arm baseline 0 -Xms2g -Xmx2g -XX:+UseG1GC

run_arm tuned "$TOKEN_POOL" -Xms2g -Xmx2g -XX:+UseG1GC \
    -XX:MaxGCPauseMillis=15 \
    -XX:G1HeapRegionSize=8m \
    -XX:InitiatingHeapOccupancyPercent=35 \
    -XX:G1ReservePercent=15 \
    -XX:+ParallelRefProcEnabled \
    -XX:+AlwaysPreTouch

echo
echo "=== GC pause comparison ==="
python3 ops/gc-log-summarize.py "$GC_DIR/logs/gc-baseline.log" "$GC_DIR/logs/gc-tuned.log"

echo
echo "=== request-latency tails for the same two arms ==="
printf "%-10s %8s %8s %9s %9s\n" ARM p99 p99.9 max "accept%"
python3 - "$GC_DIR/reports" <<'PY'
import csv, glob, os, sys
rows = {}
for path in glob.glob(os.path.join(sys.argv[1], "load-*.csv")):
    with open(path) as f:
        for row in csv.DictReader(f):
            rows[row["label"]] = row
for label in ("baseline", "tuned"):
    r = rows.get(label)
    if r:
        print(f"{label:<10} {float(r['p99ms']):8.2f} {float(r['p999ms']):8.2f} "
              f"{float(r['maxms']):9.2f} {float(r['acceptPercent']):9.1f}")
PY
echo
echo "NOTE: -Xmx is held at 2g in BOTH arms here on purpose. Raising the heap as well would improve"
echo "the tail for a reason unrelated to the flags being demonstrated, and the point of the exercise"
echo "is to isolate the marking/reserve behaviour. ops/jvm/tuned.env carries the full production set."
