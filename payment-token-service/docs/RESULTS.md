# Measured results

Everything here was produced by scripts in this repository on one developer machine
(Apple Silicon, macOS 15.5, JDK 17.0.17, 2026-07-31). Reproduce with the commands shown.
Where a number depends on calibration or on the host, that is stated next to the number
rather than in a footnote.

---

## 1. Test suite

```bash
./build.sh
```

| Module | Tests | Result |
|---|---|---|
| `common` (domain, crypto, ISO 8583 codec, portable SQL) | 148 | pass |
| `loadtest` (the measuring instrument itself) | 16 | pass |
| `integration-tests` (whole stack in one JVM) | 96 | pass |
| **Total** | **260** | **pass** |

The integration suite boots eight Spring contexts, a Hazelcast member, four Hazelcast
clients and a real ISO 8583 TCP listener in about 3.8 seconds, then runs everything
against them.

---

## 2. Detokenization latency A/B (S8, claim 6)

```bash
ops/bench-ab.sh 7 400 "ramp:50->400/15s,constant:400/30s,spike:900/10s"
```

24,372 authorizations per arm, open-model arrival schedule, Zipfian token selection
(exponent 1.0), one build, nothing varying but the flags.

| Arm | cache | controls | ATC | p50 | p95 | **p99** | p99.9 | max | accept |
|---|---|---|---|---|---|---|---|---|---|
| baseline | DIRECT | remote | DB | 27.48 | 32.58 | **42.43** | 115.00 | 334.01 | 98.1% |
| cache-only | NEAR_CACHE | remote | DB | 18.52 | 22.86 | **57.00** | 148.00 | 186.38 | 98.2% |
| inline-only | DIRECT | inline | CLUSTER | 9.11 | 11.67 | **25.01** | 84.95 | 140.55 | 99.0% |
| optimized | NEAR_CACHE | inline | CLUSTER | 0.28 | 1.30 | **3.28** | 58.79 | 151.76 | 100.0% |

All times in milliseconds. **p99: 42.43 ms → 3.28 ms.**

### The p50 is the interesting column, not the p99

Each arm removes a known number of synchronous round trips, and the p50 tracks that
almost exactly at the calibrated ~7 ms per hop:

| Arm | injected hops remaining | expected | measured p50 |
|---|---|---|---|
| baseline | 3 (vault read, controls call, ATC update) | ~21 ms + overhead | 27.48 ms |
| cache-only | 2 (controls call, ATC update) | ~14 ms + overhead | 18.52 ms |
| inline-only | 1 (vault read) | ~7 ms + overhead | 9.11 ms |
| optimized | 0 | overhead only | 0.28 ms |

That is the claim, and it is attributable per hop rather than being one aggregate number:
roughly 9 ms of p50 disappears for each round trip removed, and ~6 ms of framework and
transport overhead accounts for the rest of the baseline.

### Three honest caveats

1. **The ~7 ms per hop is injected**, by `pts.sim.hop-latency-ms`, and only into the
   detokenization service. It stands in for Toxiproxy, which does the same job properly in
   the Docker Compose stack. A local database answers in under a millisecond, so without
   calibration removing a round trip would measure as free and the comparison would be
   meaningless. What transfers to production is the *shape* — N round trips removed — not
   the absolute milliseconds.
2. **`cache-only` has a worse p99 than baseline** (57.00 vs 42.43) despite a much better
   p50. That is tail noise on a laptop running four JVMs, a Hazelcast member and the load
   driver at once, not a property of the near-cache. The p50/p95 ordering is stable across
   runs; the p99 of the middle arms is not. Quoting the 42→3 headline without saying this
   would be selective reading of my own data.
3. **`optimized` reaching 0.28 ms p50** is fast because everything left is in-process
   (near-cache hit, inlined controls, HMAC, AES-GCM) plus one localhost hop for the ATC
   entry processor. In production the client-to-member hop is a real network hop, so expect
   single-digit rather than sub-millisecond.

### The guard that makes this trustworthy

The first version of this benchmark was **wrong**, and the harness now refuses to repeat the
mistake. Because the ATC is a monotonic per-token counter, reusing tokens across arms meant
arms 2-4 presented counters that arm 1 had already consumed, so nearly every request was
rejected as a replay — short-circuiting before decryption and inflating the improvement to
"94%". Each arm now gets a disjoint token slice, and both the driver and the summary refuse
to report a comparison when any arm's accept rate falls below 95%.

---

## 3. G1 tuning (S9, claim 7)

```bash
ops/gc-compare.sh 300 "ramp:100->700/15s,constant:700/40s,spike:1400/12s"
```

Identical service configuration and load in both arms; the heap is held at 2 GB in both so
the only variables are the marking and reserve flags. A discarded warm-up run precedes each
measurement, because JIT compilation otherwise lands in the tail.

| Metric | baseline | tuned | change |
|---|---|---|---|
| collections | 14 | 20 | more, shorter |
| total pause | 88.0 ms | 58.6 ms | 33% lower |
| pause p50 | 3.63 ms | 2.12 ms | 42% lower |
| **max pause** | **22.84 ms** | **15.24 ms** | **33% lower** |
| to-space exhausted | 0 | 0 | — |
| full GCs | 0 | 0 | — |
| **request p99.9** | **23.96 ms** | **12.79 ms** | **47% lower** |

Tuned flags: `-XX:MaxGCPauseMillis=15 -XX:G1HeapRegionSize=8m
-XX:InitiatingHeapOccupancyPercent=35 -XX:G1ReservePercent=15 -XX:+ParallelRefProcEnabled
-XX:+AlwaysPreTouch`.

**Caveat, and the parser says so itself:** 14 and 20 collections is a small sample. At those
counts "p99.9" and "max" are the same observation, so the honest statement is about the
maximum pause and the direction, not about a 99.9th percentile. `ops/gc-log-summarize.py`
prints this warning whenever a log has fewer than 100 collections, so the caveat travels with
the number instead of living only here.

---

## 4. Certification suites (S10.5, claims 14-15)

```bash
ops/run-local.sh optimized
curl -X POST "localhost:8087/cert/run?suite=suites/issuer-a-legacy.yml"
curl -X POST "localhost:8087/cert/run?suite=suites/issuer-b-token-aware.yml"
```

| Suite | Steps | Result | Duration |
|---|---|---|---|
| ISSA — token-unaware issuer | 17 | 17 passed | 1475 ms |
| ISSB — token-aware issuer | 9 | 9 passed | 205 ms |

Every `iso-authorize` step opens a real TCP socket to the jPOS listener. The suites are also
run by `CertHarnessIT` in `./build.sh`, so a change that breaks ISO 8583 field handling turns
the build red before anyone reads a message trace.

---

## 5. A defect the tests found

Worth recording because it is the clearest evidence that the test suite does something.

**Hazelcast batches near-cache invalidation for up to 10 seconds by default.**
`hazelcast.map.invalidation.batch.enabled` defaults to `true`, and the batch flushes when it
reaches 100 entries or after `hazelcast.map.invalidation.batchfrequency.seconds` (10). On a
low-write map — and lifecycle changes are inherently low-TPS — neither trigger fires promptly.

The consequence was not a performance nuance. `CacheSafetyIT` failed with a suspended token
still authorizing, and `CardReissueIT` failed with a reissued card still resolving to the old
PAN. The S8.4 property — "a suspension reaches the authorization path in milliseconds" — was
quietly false, and it would have demoed as working on any test where the cache happened to be
cold.

Fixed in `VaultClusterConfig` by disabling invalidation batching on the member, at a cost of
one small cluster message per vault write.
