# Simplifications and honest limitations

Read this before the interview. Knowing exactly where the demo diverges from a real Token
Service Provider — and what the production-grade equivalent is — is what turns "a project"
into "an engineer who understands the domain". Volunteer these; do not wait to be caught.

The one-line summary to say aloud:

> *"This is a faithful reference implementation of the concepts on publicly documented
> standards. Every real cryptographic and infrastructure component is replaced by a clearly
> labelled stand-in, and I can walk you through exactly what would change to make each piece
> production-grade."*

---

## Verification status: what actually runs here

The distinction that matters most, because it is the one an interviewer can check.

| Path | Status |
|---|---|
| Pure-JVM stack: H2, embedded Hazelcast, HTTP events, JCE keys | **Verified.** 260 tests, `ops/run-local.sh`, `ops/bench-ab.sh`, `ops/gc-compare.sh` all executed; results in [RESULTS.md](RESULTS.md). |
| Docker Compose stack: Oracle, Kafka, Toxiproxy, nginx, Prometheus, Grafana | **Written and reviewed, not executed.** The authoring machine had no Docker. Treat the compose files, the Oracle DDL and the Grafana dashboard as code review, not as demonstrated. |
| SoftHSM2 / PKCS#11 key service | **Written, not executed.** SoftHSM2 was not installed. `Pkcs11KeyService` compiles and is deliberately small; `ops/softhsm/init-softhsm.sh` sets up the token. |
| Gatling simulation | **Source shipped, not compiled.** See `loadtest/GATLING.md`. The equivalent open-model driver in `loadtest/` is what produced the measured numbers. |

Saying "the Oracle path is reviewed but unrun" costs nothing and buys credibility.
Claiming it works and being asked to prove it costs everything.

---

## Component-by-component

| Area | Demo simplification | Production equivalent |
|---|---|---|
| **Cryptogram** | HMAC-SHA-256 over a pinned canonical input, truncated to 8 bytes (`CryptogramService`) | EMVCo TAVV/ARQC: issuer master keys, session-key derivation, EMV-specified algorithms, computed inside a payShield-class HSM |
| **HSM** | SoftHSM2 via SunPKCS11, or HKDF-derived keys from a config seed in dev | Physical payment HSM (Thales/Futurex), key ceremonies, dual control, tamper response, split knowledge |
| **Detokenization "swap"** | The service decrypts the funding PAN and returns it over mTLS | In-network, in-HSM operations; the PAN never exists in general application memory; strict HSM command boundaries |
| **Vault database** | H2 for the verified path; Oracle DDL with real partitioning shipped but unrun | Oracle with the partitioning in `db/oracle/01_schema.sql`, plus TDE, audit vault and access reviews |
| **Cross-DC** | Two replicas behind nginx on one host; dual-DC is design discussion only (S10.4) | Data Guard or GoldenGate with stated RPO/RTO, a cross-DC ATC strategy, quarterly DR drills |
| **Network latency** | `pts.sim.hop-latency-ms`, an in-process fixed delay; Toxiproxy in the compose stack | Real cross-rack and cross-AZ RTT, TCP and TLS handshake costs, connection pooling at scale |
| **ID&V** | Deterministic score from the card's last four digits plus a local rule table (S5.2) | Issuer risk platforms, device attestation, wallet SDK attestation, 3-D Secure interplay |
| **OTP delivery** | Generated, hashed, and readable from an endpoint that is off by default | SMS/push via a real channel, rate limiting, anti-enumeration, fraud feedback |
| **PCI scope** | PAN redaction in logs, envelope encryption, no PAN in APIs or events | Full PCI DSS: network segmentation, CDE controls, QSA audit, documented key management, access reviews |
| **ISO 8583** | A documented subset of data elements, ASCII packager (S6.2) | Full network message specification, network-specific dialects, certification against real endpoints |
| **Change management** | Spring profile gating plus Jenkinsfile stages with a manual gate | Regulated CAB, segregation of duties, audited approvals, change-freeze windows |
| **Admin endpoints** | Unauthenticated (key rotation, capability flags, reconciliation) | Admin authentication, dual approval for key operations, full audit trail |
| **mTLS** | Plain HTTP between services | mTLS everywhere, per-service identities, short-lived certificates |

---

## Deliberate design choices that are *not* simplifications

Distinguishing these from the list above matters: some are improvements on the specification,
and some are the specification's own trade-offs implemented faithfully.

- **Ciphertext, not plaintext, in the cache.** The cached vault record holds
  `funding_pan_enc`. The latency win comes from removing a network hop, not from
  pre-decrypting, so caching ciphertext costs nothing measurable and means a heap dump or a
  replication snoop yields nothing without the KEK.
- **The token PAN is bound in as AES-GCM AAD.** Ciphertext is not portable between vault
  rows, so copying `funding_pan_enc` from one token to another fails authentication instead of
  silently re-pointing a token at another cardholder's account.
- **HMAC, not SHA-256, for the funding-PAN fingerprint.** A bare hash of a 16-digit PAN is
  brute-forceable; the search space is about 10^15 before BIN and Luhn constraints reduce it
  much further.
- **Cryptogram verified before the ATC advances.** A deliberate deviation from the ordering in
  S6.1 — see [DESIGN_DEVIATIONS.md](DESIGN_DEVIATIONS.md).
- **The cache write happens after commit.** The cache can therefore only lag the vault, never
  lead it, and lag is bounded and detectable where "ahead" would be a correctness failure.
- **Near-cache invalidation batching is disabled.** Hazelcast's 10-second default made the
  S8.4 guarantee false; see [RESULTS.md](RESULTS.md) §5.

---

## Known weak points, stated plainly

If asked "what would you fix first", these — not the stand-ins above.

1. **The ATC write-behind window is a real durability trade.** With
   `detok.atc-mode=CLUSTER`, a member dying with unflushed counters can let a token's stored
   ATC regress by up to the write-behind interval, which is a replay window. Mitigations are
   in place and documented on `AtcMapStore` (short interval, database anchoring on cold load,
   monotonic writes, and the cryptogram binding ATC/UN/amount anyway). For production I would
   either tune the interval down hard or keep ATC synchronous in a dedicated fast store.
2. **Cache/vault divergence on `status` is the highest-consequence bug class.** It is why
   writes are write-through plus invalidate rather than TTL-based, why `CacheSafetyIT`
   manufactures the divergence and watches the repair, and why `pts.cache.drift_repaired` is a
   metric worth alerting on rather than an assumption.
3. **Admin endpoints have no authentication.** Fine for a simulator on localhost, not fine
   anywhere else, and the first thing to add.
4. **Single-region only.** The failover demo shows replica-level HA. Dual-DC is a design
   conversation, and the ATC coordination question across DCs is genuinely hard rather than a
   configuration detail.
5. **The load driver runs on the same host as the service.** It competes for CPU with what it
   is measuring, which inflates the tail. A separate load generator would tighten the p99.9
   numbers; it would not change the p50 attribution that the latency claim rests on.
