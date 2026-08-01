#!/usr/bin/env bash
#
# Bring up the whole stack with no Docker: H2 in place of Oracle, an embedded Hazelcast member,
# HTTP in place of Kafka, and the JCE key service in place of SoftHSM2.
#
# This is the path that is actually verified on this machine. docker-compose.yml is the
# full-fidelity stack and needs Docker; see docs/SIMPLIFICATIONS.md for what differs.
#
#   ops/run-local.sh                 # baseline detokenization flags
#   ops/run-local.sh optimized       # near-cache + inlined controls + cluster ATC
#   ops/stop-local.sh                # shut everything down
#
# Then follow docs/DEMO_SCRIPT.md.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

ARM="${1:-baseline}"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
JAVA="$JAVA_HOME/bin/java"
V="1.0.0-SNAPSHOT"

RUN_DIR="$ROOT/target/local"
DB_URL="jdbc:h2:file:$RUN_DIR/pts-local;AUTO_SERVER=TRUE;DB_CLOSE_DELAY=-1"
LOGS="$RUN_DIR/logs"
PID_FILE="$RUN_DIR/pids"
HZ_PORT=5701
# Every service must share this: provisioning seals funding PANs with it and detokenization opens
# them. In the Compose stack the config server distributes it (S12); here it is one variable.
SEED="local-stack-shared-hsm-seed-01"

case "$ARM" in
  baseline)  CACHE=DIRECT;     INLINE=false; ATC=DB;      HZ=DISABLED ;;
  optimized) CACHE=NEAR_CACHE; INLINE=true;  ATC=CLUSTER; HZ=CLIENT ;;
  *) echo "usage: ops/run-local.sh [baseline|optimized]" >&2; exit 2 ;;
esac

mkdir -p "$LOGS"

# Pre-flight: fail loudly if anything already holds a port we need.
#
# Without this the script starts a service, the new process dies with "port in use", and
# wait_for_health then succeeds against the STALE process still listening there -- so the script
# reports a healthy stack that is running the previous build. That is a genuinely expensive way to
# lose half an hour, and it is trivially detectable.
REQUIRED_PORTS=(8081 8082 8083 8084 8085 8086 8087 8090 8583 "$HZ_PORT")
BUSY=()
for port in "${REQUIRED_PORTS[@]}"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    BUSY+=("$port")
  fi
done
if [[ ${#BUSY[@]} -gt 0 ]]; then
  echo "!! ports already in use: ${BUSY[*]}" >&2
  echo "   A previous stack is probably still running. Stop it first:" >&2
  echo "     ops/stop-local.sh" >&2
  echo "   Or see what holds them:" >&2
  echo "     lsof -nP -iTCP:$(IFS=,; echo "${BUSY[*]}") -sTCP:LISTEN" >&2
  exit 1
fi

: > "$PID_FILE"

wait_for_health() {
  local port="$1" name="$2"
  for _ in $(seq 1 120); do
    curl -sf "http://localhost:$port/actuator/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "!! $name never became healthy on :$port -- see $LOGS/$name.log" >&2
  tail -30 "$LOGS/$name.log" >&2 || true
  exit 1
}

COMMON=(
  "--spring.datasource.url=$DB_URL"
  "--spring.datasource.username=sa"
  "--spring.datasource.password="
  "--spring.datasource.driver-class-name=org.h2.Driver"
  "--spring.cloud.config.enabled=false"
  "--spring.jmx.enabled=false"
  "--pts.hsm.dev-seed=$SEED"
  "--pts.sim.hop-latency-ms=0"
)

launch() {
  local name="$1" module="$2" port="$3"
  shift 3
  echo "  $name -> :$port"
  nohup "$JAVA" -jar "$ROOT/$module/target/$module-$V-exec.jar" \
      "--server.port=$port" "${COMMON[@]}" "$@" > "$LOGS/$name.log" 2>&1 &
  echo $! >> "$PID_FILE"
  wait_for_health "$port" "$name"
}

echo "=== building ==="
mvn -o -q -DskipTests package || mvn -q -DskipTests package

echo
echo "=== starting the local stack (arm: $ARM) ==="

launch issuer-simulator issuer-simulator 8085

launch hazelcast-member hazelcast-member 8090 \
    "--spring.sql.init.mode=always" \
    "--spring.sql.init.schema-locations=classpath:db/h2/schema.sql" \
    "--pts.hazelcast.mode=MEMBER" \
    "--pts.hazelcast.port=$HZ_PORT" \
    "--pts.hazelcast.members[0]=127.0.0.1:$HZ_PORT" \
    "--pts.hazelcast.backup-count=0" \
    "--pts.bins.seed-on-startup=false"

launch issuer-notification-sim issuer-notification-sim 8086 \
    "--spring.sql.init.mode=always" \
    "--spring.sql.init.schema-locations=classpath:db/h2/schema.sql" \
    "--pts.bins.seed-on-startup=false"

launch token-controls-service token-controls-service 8084 \
    "--spring.sql.init.mode=always" \
    "--spring.sql.init.schema-locations=classpath:db/h2/schema.sql" \
    "--pts.bins.seed-on-startup=false"

# Provisioning owns reference data: it seeds the BIN maps and bootstraps the DEK through the HSM.
launch token-provisioning-service token-provisioning-service 8081 \
    "--spring.sql.init.mode=always" \
    "--spring.sql.init.schema-locations=classpath:db/h2/schema.sql" \
    "--pts.bins.seed-on-startup=true" \
    "--pts.hazelcast.mode=CLIENT" \
    "--pts.hazelcast.members[0]=127.0.0.1:$HZ_PORT" \
    "--provisioning.issuer-sim-url=http://localhost:8085" \
    "--provisioning.events.transport=HTTP" \
    "--provisioning.events.notification-url=http://localhost:8086" \
    "--provisioning.idv.expose-otp-for-demo=true" \
    "--provisioning.idv.trusted-requestors[0]=50020040002"

launch detokenization-service detokenization-service 8082 \
    "--spring.sql.init.mode=never" \
    "--pts.bins.seed-on-startup=false" \
    "--pts.hazelcast.mode=$HZ" \
    "--pts.hazelcast.members[0]=127.0.0.1:$HZ_PORT" \
    "--detok.cache-mode=$CACHE" \
    "--detok.atc-mode=$ATC" \
    "--detok.controls.inline=$INLINE" \
    "--detok.controls.url=http://localhost:8084"

launch auth-switch-simulator auth-switch-simulator 8083 \
    "--spring.sql.init.mode=never" \
    "--pts.bins.seed-on-startup=false" \
    "--auth-switch.iso-port=8583" \
    "--auth-switch.detokenize-url=http://localhost:8082" \
    "--auth-switch.issuer-sim-url=http://localhost:8085"

launch cert-harness cert-harness 8087 \
    "--spring.sql.init.mode=never" \
    "--pts.bins.seed-on-startup=false" \
    "--cert.provisioning-url=http://localhost:8081" \
    "--cert.auth-switch-url=http://localhost:8083" \
    "--cert.iso-host=127.0.0.1" \
    "--cert.iso-port=8583"

cat <<INFO

=== stack up (arm: $ARM) ==========================================================
  provisioning API      http://localhost:8081/v1/tokens
  detokenization        http://localhost:8082/v1/detokenize
                        flags: $(curl -s http://localhost:8082/v1/detokenize/config)
  auth switch (admin)   http://localhost:8083/sim/status
  ISO 8583 (TCP)        localhost:8583
  token controls        http://localhost:8084/internal/controls/check
  issuer simulator      http://localhost:8085/sim/counters
  notification consumer http://localhost:8086/sim/notifications
  cert harness          POST http://localhost:8087/cert/run?suite=suites/issuer-a-legacy.yml
  hazelcast member      http://localhost:8090/cluster/status

  logs                  $LOGS
  database              $DB_URL

Next: docs/DEMO_SCRIPT.md    Stop: ops/stop-local.sh
===================================================================================
INFO
