# payment-token-service

A from-scratch reference implementation of network payment tokenization: EMVCo-style provisioning
and lifecycle, and detokenization **inside the authorization path**, built only on publicly
documented standards (EMVCo Payment Tokenisation, ISO 8583, PKCS#11, PCI DSS principles).

Built from [`network-tokenization-demo-technical-design.md`](../network-tokenization-demo-technical-design.md).
Section references below (S4.1, S8.2, …) point into that document.

Production code at a payment network is confidential. This implements the same *concepts* with every
real cryptographic and infrastructure component replaced by a clearly labelled stand-in — SoftHSM2
for a payment HSM, simulators for the issuer and the authorization switch, an injected delay for
datacentre network latency.

**Independent of everything else in this repository.** Its own Maven build, its own package root
(`com.adxztech.pts`), no shared configuration or database with the rest of the project.

---

## Quick start

```bash
./build.sh              # 260 tests: unit + the whole stack in one JVM   (~2 min)
ops/run-local.sh        # eight services, no Docker required             (~40 s)
ops/stop-local.sh
```

Then walk [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

Requires JDK 17 and Maven. Nothing else — no Docker, no Oracle, no Kafka.

```bash
ops/bench-ab.sh         # the detokenization latency A/B, all four flag combinations
ops/gc-compare.sh       # the G1 tuning comparison
```

---

## What has actually been executed

The most important table here, because it is the one an interviewer can check.

| Path | Status |
|---|---|
| Pure-JVM stack: H2, embedded Hazelcast, HTTP events, JCE key service | **Verified** — 260 tests, both benchmarks, both certification suites. [RESULTS.md](docs/RESULTS.md) |
| Docker Compose stack: Oracle, Kafka, Toxiproxy, nginx, Prometheus, Grafana | **Reviewed, not executed** — no Docker on the authoring machine |
| SoftHSM2 / PKCS#11 key service | **Reviewed, not executed** — SoftHSM2 not installed |
| Gatling simulation | **Source shipped, not compiled** — the equivalent JDK driver produced the numbers |

Full detail, component by component: [SIMPLIFICATIONS.md](docs/SIMPLIFICATIONS.md).

## Measured results

| Claim | Result |
|---|---|
| Detokenization p99 (S8) | **42.43 ms → 3.28 ms**, and the p50 tracks ~7 ms per removed round trip |
| G1 tuning (S9) | max pause 22.84 → 15.24 ms; request p99.9 23.96 → 12.79 ms |
| Certification suites (S10.5) | ISSA 17/17, ISSB 9/9, over real ISO 8583 TCP |
| Test suite | 260 tests, all passing |

Numbers, method and caveats: [RESULTS.md](docs/RESULTS.md). The per-hop latency is **injected** and
disclosed; the first version of the A/B was invalid and the harness now refuses to repeat the
mistake.

---

## Architecture

```
   curl / Postman                      load driver / cert harness
        │ REST                                │ REST + ISO 8583 (TCP)
        ▼                                     ▼
 ┌───────────────────────────┐        ┌──────────────────────────────┐
 │ token-provisioning-service│        │    auth-switch-simulator     │
 │  ID&V, OTP, lifecycle,    │        │  jPOS: 0100 in → 0110 out    │
 │  card reissue, key mgmt,  │        │  DE 2 token → detokenize →   │
 │  the ONLY writer          │        │  swap → forward to issuer    │
 └──────┬──────────┬─────────┘        └───────────────┬──────────────┘
        │          │ write-through                    │ REST
        │          ▼                    ┌─────────────▼────────────────┐
        │  ┌────────────────┐  client   │   detokenization-service     │
        │  │ hazelcast-     │◄──────────┤  ┌────────────────────────┐  │
        │  │ member(s)      │  IMap +   │  │ near-cache (in-process)│  │
        │  │ vault-records  │  near-    │  └────────────────────────┘  │
        │  │ token-atc      │  cache    │  cryptogram → KeyService     │
        │  └───────┬────────┘           └──────────────┬───────────────┘
        │          │ read-through MapLoader            │ miss / DIRECT mode
        ▼          ▼                                   ▼
 ┌────────────────┐   ┌──────────────────────┐   ┌──────────────────┐
 │ vault (Oracle  │   │ token-controls-svc   │◄──┤ baseline-only    │
 │ / H2) range-   │   │ the "legacy hop"     │   │ synchronous hop  │
 │ partitioned by │   │ removed in v2        │   └──────────────────┘
 │ TOKEN_BIN      │   └──────────────────────┘
 └───────┬────────┘
         │ transactional outbox → poller
         ▼
 ┌────────────────┐   ┌──────────────────────────┐   ┌─────────────────┐
 │ Kafka / HTTP   ├──►│ issuer-notification-sim  │   │ issuer-simulator│
 │ token.lifecycle│   │ dedupe by eventId        │   │ ID&V + auth     │
 └────────────────┘   └──────────────────────────┘   └─────────────────┘
```

### Modules

| Module | Role |
|---|---|
| `common` | Domain model, crypto, ISO 8583 codec, portable SQL, cache and cluster plumbing |
| `token-provisioning-service` | The only writer. State machine, ID&V, OTP, reissue, key rotation, outbox |
| `detokenization-service` | The latency-critical read path; both cache modes behind flags |
| `token-controls-service` | The "legacy hop", built to be inlined away (S8.2) |
| `auth-switch-simulator` | jPOS ISO 8583 switch: DE 2 swap and the issuer capability split |
| `issuer-simulator` | ID&V risk decisions and authorization decisioning |
| `issuer-notification-sim` | Idempotent consumer of lifecycle events |
| `hazelcast-member` | Cluster member carrying the MapLoader, MapStore and entry processor |
| `cert-harness` | Replays YAML issuer certification suites, emits an HTML report |
| `loadtest` | Open-model load driver, Zipfian feeder, latency histogram |
| `config-server` | Spring Cloud Config, shared configuration per zone |
| `integration-tests` | Boots the whole stack in one JVM |

---

## The three things worth reading first

If you have ten minutes and want the parts with actual engineering in them:

1. **[`DetokenizationService`](detokenization-service/src/main/java/com/adxztech/pts/detok/DetokenizationService.java)**
   — the authorization pipeline, its stage ordering, and a documented, tested deviation from the
   design: the cryptogram is verified *before* the ATC advances, because advancing a counter on an
   unauthenticated request is a denial-of-service against a live card.
2. **[`VaultClusterConfig`](common/src/main/java/com/adxztech/pts/common/cluster/VaultClusterConfig.java)**
   — why the near-cache is on the client and not the member, why cluster members run this project's
   jar rather than a stock image, and the one non-default setting that the whole S8.4 guarantee
   turned out to depend on.
3. **[`VaultWriter`](token-provisioning-service/src/main/java/com/adxztech/pts/provisioning/VaultWriter.java)**
   — why the cache write is ordered *after* commit, so the cache can lag the vault but never lead
   it, and what remains at risk after that (which is what `CacheReconciliationJob` exists for).

---

## Documentation

| Document | Contents |
|---|---|
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | The 8-minute interview click-through, with real outputs |
| [docs/RESULTS.md](docs/RESULTS.md) | Every measured number, how to reproduce it, and its caveats |
| [docs/CLAIMS.md](docs/CLAIMS.md) | All 16 résumé claims → code → test → how to see it |
| [docs/SIMPLIFICATIONS.md](docs/SIMPLIFICATIONS.md) | What is a stand-in, what is unrun, what is weak |
| [docs/DESIGN_DEVIATIONS.md](docs/DESIGN_DEVIATIONS.md) | Where the code differs from the design, and why |
| [ops/runbooks/latency-rca.md](ops/runbooks/latency-rca.md) | Latency regression: which stage, and what to do |
| [ops/runbooks/failover.md](ops/runbooks/failover.md) | Failover drills, and where dual-DC is design only |

---

## Running the full-fidelity stack

Needs Docker. **Not executed here** — see the status table above.

```bash
docker compose up -d --wait                                    # baseline JVM flags
docker compose -f docker-compose.yml -f docker-compose.tuned.yml up -d   # tuned JVM flags
docker compose --profile cert run --rm cert-harness            # the release gate
```

Grafana on :3000, Prometheus on :9090, Toxiproxy control API on :8474. What this adds over the
pure-JVM path: real Oracle partitioning, a real broker, real cross-container latency, and two
load-balanced detokenization replicas for the failover drill.

---

## Layout

```
payment-token-service/
├── build.sh                     # build + all 260 tests
├── docker-compose.yml           # full-fidelity stack (reviewed, unrun)
├── docker-compose.tuned.yml     # overlay: tuned G1 flags
├── Jenkinsfile                  # build → test → cert gate → manual approval → package
├── config/                      # config-server content: per-zone configuration
├── db/oracle/                   # partitioned DDL, seed, explain-plan proof
├── docs/                        # results, claims, simplifications, deviations, demo script
├── ops/
│   ├── run-local.sh  stop-local.sh
│   ├── bench-ab.sh              # the latency A/B
│   ├── gc-compare.sh  gc-log-summarize.py  jvm/
│   ├── seed-tokens.py           # provision a token pool for load runs
│   ├── docker/  grafana/  nginx/  prometheus/  toxiproxy/  softhsm/
│   └── runbooks/
└── <12 Maven modules>
```

---

## Demo data

The issuer simulator scores risk deterministically as `last4 mod 100`, so a card's last two digits
*are* its ID&V outcome and every demo is reproducible. Defined in
[`DemoCards`](common/src/main/java/com/adxztech/pts/common/demo/DemoCards.java).

| Card | Risk | Outcome |
|---|---|---|
| `4111100000000725` | 25 | APPROVE |
| `4111100000000345` | 45 | STEP_UP for a wallet; APPROVE for a trusted merchant |
| `4111100000000485` | 85 | DECLINE |
| `4333300000000525` | 25 | DECLINE — the BIN block is blocklisted, and the local rule wins |

Token BIN blocks: `49996000-49996099` ISSA (token-unaware), `49996100-49996199` ISSB
(token-aware), `49996200-49996299` ISSC. All fabricated test numbers in test BIN ranges.
