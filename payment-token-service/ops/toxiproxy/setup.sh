#!/bin/sh
# Create the proxies and attach the latency toxics (S11.3).
#
# THIS IS THE CALIBRATION, AND IT IS DELIBERATELY VISIBLE.
# On one host a local Oracle answers in well under a millisecond. Measured there, removing a network
# round trip looks like removing nothing. These toxics represent realistic cross-rack RTT so the
# before/after percentile curves take production shape. The transferable claim is the SHAPE -- N
# round trips of ~7 ms each removed -- not the absolute milliseconds.
#
# Latency is applied in BOTH directions of a hop, so `latency` is set to half the intended RTT.
set -e
API="http://toxiproxy:8474"

until curl -sf "$API/version" >/dev/null 2>&1; do
  echo "waiting for toxiproxy..."; sleep 1
done

create_proxy() {
  name="$1"; listen="$2"; upstream="$3"
  curl -sf -X POST "$API/proxies" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"listen\":\"$listen\",\"upstream\":\"$upstream\",\"enabled\":true}" \
    >/dev/null || echo "  ($name already exists)"
}

add_latency() {
  proxy="$1"; direction="$2"; ms="$3"; jitter="$4"
  curl -sf -X POST "$API/proxies/$proxy/toxics" -H 'Content-Type: application/json' \
    -d "{\"name\":\"${direction}_latency\",\"type\":\"latency\",\"stream\":\"$direction\",
         \"toxicity\":1.0,\"attributes\":{\"latency\":$ms,\"jitter\":$jitter}}" >/dev/null \
    || echo "  ($proxy $direction latency already set)"
}

echo "creating proxies..."
create_proxy oracle         "0.0.0.0:21521" "oracle:1521"
create_proxy token-controls "0.0.0.0:28084" "token-controls-service:8084"

# ~7 ms RTT per hop (3.5 ms each way), with jitter so the tail is not artificially smooth -- a
# perfectly constant delay would make the p99 suspiciously close to the p50.
echo "attaching ~7ms RTT to the JDBC path..."
add_latency oracle upstream 3 1
add_latency oracle downstream 4 1

echo "attaching ~7ms RTT to the token-controls path..."
add_latency token-controls upstream 3 1
add_latency token-controls downstream 4 1

echo
echo "toxics attached. Current state:"
curl -s "$API/proxies" || true
echo
echo "To measure WITHOUT calibration (and see why it is needed):"
echo "  curl -X DELETE $API/proxies/oracle/toxics/upstream_latency"
