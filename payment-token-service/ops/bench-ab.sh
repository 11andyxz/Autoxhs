#!/usr/bin/env bash
#
# The latency A/B (S8, S11): measure detokenization p50/p95/p99/p99.9 at all four points of the
# cache-mode x controls-inline matrix, on one build, changing nothing but the flags.
#
# WHY THIS SCRIPT DISCLOSES ITS CALIBRATION
# On a laptop a local database answers in well under a millisecond. Measured there, removing a network
# round trip looks like removing nothing, and the before/after curves say nothing about production. The
# Docker Compose stack solves this properly with Toxiproxy; this script uses the in-process equivalent,
# pts.sim.hop-latency-ms, and applies it ONLY to the detokenization service -- the one whose hops are
# being counted. The honest claim is about SHAPE: removing N synchronous round trips of ~7 ms each. The
# absolute milliseconds are host- and calibration-dependent, which the output states.
#
# Note on quoting: every argument list is a bash ARRAY. A string plus word-splitting breaks the moment
# a path contains a space, and it fails in a spectacularly confusing way -- H2 silently opens a database
# at the prefix before the space rather than reporting a bad URL.
#
# Usage:  ops/bench-ab.sh [hop_latency_ms] [token_pool] [profile]
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

HOP_MS="${1:-7}"
TOKEN_POOL="${2:-400}"
PROFILE="${3:-ramp:50->400/15s,constant:400/30s,spike:900/10s}"

JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
JAVA="$JAVA_HOME/bin/java"
V="1.0.0-SNAPSHOT"

BENCH_DIR="$ROOT/target/bench"
DB_URL="jdbc:h2:file:$BENCH_DIR/pts-bench;AUTO_SERVER=TRUE;DB_CLOSE_DELAY=-1"
REPORTS="$BENCH_DIR/reports"
LOGS="$BENCH_DIR/logs"
HZ_PORT=5731
SEED="bench-shared-hsm-seed-000001"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

wait_for_health() {
  local port="$1" name="$2"
  for _ in $(seq 1 120); do
    if curl -sf "http://localhost:$port/actuator/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "!! $name did not become healthy on port $port; see $LOGS/$name.log" >&2
  tail -30 "$LOGS/$name.log" >&2 || true
  exit 1
}

# Shared arguments. hop-latency is 0 here on purpose: only the detokenization service pays the
# calibrated latency, because it is the service whose round trips are being counted.
COMMON_ARGS=(
  "--spring.datasource.url=$DB_URL"
  "--spring.datasource.username=sa"
  "--spring.datasource.password="
  "--spring.datasource.driver-class-name=org.h2.Driver"
  "--spring.sql.init.mode=always"
  "--spring.sql.init.schema-locations=classpath:db/h2/schema.sql"
  "--spring.cloud.config.enabled=false"
  "--spring.jmx.enabled=false"
  "--pts.hsm.dev-seed=$SEED"
  "--pts.sim.hop-latency-ms=0"
)

start_service() {
  local name="$1" module="$2" port="$3"
  shift 3
  echo "  starting $name on :$port"
  nohup "$JAVA" -jar "$ROOT/$module/target/$module-$V-exec.jar" \
      "--server.port=$port" "${COMMON_ARGS[@]}" "$@" > "$LOGS/$name.log" 2>&1 &
  PIDS+=($!)
  wait_for_health "$port" "$name"
}

echo "=== building (tests skipped; they are run by mvn verify) ==="
mvn -o -q -DskipTests package || mvn -q -DskipTests package

rm -rf "$BENCH_DIR"
mkdir -p "$REPORTS" "$LOGS"

echo
echo "=== bringing up the base stack ==="
start_service issuer-simulator issuer-simulator 8085

start_service hazelcast-member hazelcast-member 8090 \
    "--pts.hazelcast.mode=MEMBER" \
    "--pts.hazelcast.port=$HZ_PORT" \
    "--pts.hazelcast.members[0]=127.0.0.1:$HZ_PORT" \
    "--pts.hazelcast.backup-count=0" \
    "--pts.hazelcast.write-behind-seconds=1" \
    "--pts.bins.seed-on-startup=false"

start_service token-controls-service token-controls-service 8084 \
    "--pts.bins.seed-on-startup=false"

start_service token-provisioning-service token-provisioning-service 8081 \
    "--pts.bins.seed-on-startup=true" \
    "--pts.hazelcast.mode=CLIENT" \
    "--pts.hazelcast.members[0]=127.0.0.1:$HZ_PORT" \
    "--provisioning.issuer-sim-url=http://localhost:8085" \
    "--provisioning.events.transport=IN_MEMORY" \
    "--provisioning.outbox.enabled=false" \
    "--provisioning.reconciliation.enabled=false"

echo
echo "=== seeding the token pool ==="
# Four disjoint slices, one per arm. The ATC is a monotonic per-token counter, so an arm cannot reuse
# another arm's tokens: it would present counters already consumed and every request would be rejected
# as a replay. That would silently make arms 2-4 measure the (much cheaper) rejection path and report a
# far larger improvement than the code delivers. Disjoint slices keep every arm on the accept path.
TOTAL_TOKENS=$((TOKEN_POOL * 4))
python3 ops/seed-tokens.py --count "$TOTAL_TOKENS" --url http://localhost:8081 --concurrency 24

# cache-mode | controls-inline | atc-mode. The ATC move rides with the controls inlining because S8.2
# groups them as one optimization.
ARM_INDEX=0
run_arm() {
  local label="$1" cache_mode="$2" inline="$3" atc_mode="$4" hz_mode="$5"
  local offset=$((ARM_INDEX * TOKEN_POOL))
  ARM_INDEX=$((ARM_INDEX + 1))
  echo
  echo "=== arm: $label  (cache=$cache_mode controls-inline=$inline atc=$atc_mode, tokens [$offset,$((offset + TOKEN_POOL))) ) ==="

  nohup "$JAVA" -jar "$ROOT/detokenization-service/target/detokenization-service-$V-exec.jar" \
      "--server.port=8082" \
      "--spring.datasource.url=$DB_URL" \
      "--spring.datasource.username=sa" \
      "--spring.datasource.password=" \
      "--spring.datasource.driver-class-name=org.h2.Driver" \
      "--spring.sql.init.mode=never" \
      "--spring.cloud.config.enabled=false" \
      "--spring.jmx.enabled=false" \
      "--pts.hsm.dev-seed=$SEED" \
      "--pts.bins.seed-on-startup=false" \
      "--pts.sim.hop-latency-ms=$HOP_MS" \
      "--pts.hazelcast.mode=$hz_mode" \
      "--pts.hazelcast.members[0]=127.0.0.1:$HZ_PORT" \
      "--detok.cache-mode=$cache_mode" \
      "--detok.atc-mode=$atc_mode" \
      "--detok.controls.inline=$inline" \
      "--detok.controls.url=http://localhost:8084" \
      > "$LOGS/detok-$label.log" 2>&1 &
  local detok_pid=$!
  PIDS+=("$detok_pid")
  wait_for_health 8082 "detok-$label"

  "$JAVA" -jar "$ROOT/loadtest/target/loadtest-$V-exec.jar" \
      "--spring.datasource.url=$DB_URL" \
      "--spring.datasource.username=sa" \
      "--spring.datasource.password=" \
      "--spring.datasource.driver-class-name=org.h2.Driver" \
      "--spring.cloud.config.enabled=false" \
      "--pts.hsm.dev-seed=$SEED" \
      "--pts.bins.seed-on-startup=false" \
      "--load.url=http://localhost:8082" \
      "--load.profile=$PROFILE" \
      "--load.label=$label" \
      "--load.token-pool=$TOKEN_POOL" \
      "--load.token-offset=$offset" \
      "--load.out=$REPORTS"

  kill "$detok_pid" 2>/dev/null || true
  for _ in $(seq 1 60); do
    curl -sf http://localhost:8082/actuator/health >/dev/null 2>&1 || break
    sleep 0.25
  done
  sleep 1
}

run_arm baseline     DIRECT     false DB      DISABLED
run_arm cache-only   NEAR_CACHE false DB      CLIENT
run_arm inline-only  DIRECT     true  CLUSTER CLIENT
run_arm optimized    NEAR_CACHE true  CLUSTER CLIENT

echo
echo "==========================================================================================="
echo " DETOKENIZATION LATENCY A/B          simulated hop latency: ${HOP_MS} ms per round trip"
echo " token pool: ${TOKEN_POOL}   profile: ${PROFILE}"
echo "==========================================================================================="
printf "%-13s %8s %8s %8s %8s %9s %8s %8s\n" ARM p50 p95 p99 p99.9 max ok "accept%"
python3 - "$REPORTS" <<'PY'
import csv, glob, os, sys
order = ["baseline", "cache-only", "inline-only", "optimized"]
rows = {}
for path in glob.glob(os.path.join(sys.argv[1], "load-*.csv")):
    with open(path) as f:
        for row in csv.DictReader(f):
            rows[row["label"]] = row
for label in order:
    r = rows.get(label)
    if not r:
        continue
    print(f"{label:<13} {float(r['p50ms']):8.2f} {float(r['p95ms']):8.2f} "
          f"{float(r['p99ms']):8.2f} {float(r['p999ms']):8.2f} {float(r['maxms']):9.2f} "
          f"{int(r['ok']):8d} {float(r['acceptPercent']):8.1f}")

suspect = [label for label in order
           if label in rows and float(rows[label]["acceptPercent"]) < 95.0]
base, opt = rows.get("baseline"), rows.get("optimized")
if suspect:
    print()
    print("!! INVALID COMPARISON: these arms mostly REJECTED and therefore measured a short-circuited")
    print("!! path rather than full detokenization: " + ", ".join(suspect))
    print("!! Usual cause: token slices overlap, so a later arm replays ATCs an earlier arm consumed.")
    sys.exit(1)
if base and opt:
    b, o = float(base["p99ms"]), float(opt["p99ms"])
    print()
    print(f"p99: {b:.2f} ms -> {o:.2f} ms  ({(b - o) / b * 100:.0f}% reduction), "
          f"all arms on the accept path")
PY
echo
echo "Reports: $REPORTS"
echo "DISCLOSURE: the ~${HOP_MS} ms per-hop latency is injected (the Toxiproxy stand-in, S11.3) and is"
echo "applied only to the detokenization service. What transfers to production is the SHAPE of the"
echo "result -- each optimization removes one synchronous round trip -- not the absolute milliseconds."
