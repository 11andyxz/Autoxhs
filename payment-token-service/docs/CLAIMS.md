# Claims traceability

Every résumé claim from S2 of the design, mapped to the code that implements it, the test that
proves it, and how to see it yourself. Where a claim is only partly evidenced, that is said in
the Status column rather than glossed.

Legend — **Verified**: executed on this machine, result in [RESULTS.md](RESULTS.md).
**Reviewed**: implemented and readable, not executed here (see [SIMPLIFICATIONS.md](SIMPLIFICATIONS.md)).
**Design**: discussion only, deliberately.

---

### 1. Token provisioning and lifecycle APIs (issue / suspend / resume / delete)

**Status: Verified.**
- Code: `TokenController`, `ProvisioningService`, `LifecycleService`, `TokenStateMachine`
- Proof: `TokenStateMachineTest` (19 tests, every state/op pair decided),
  `ProvisioningLifecycleIT.lifecycleTransitions`
- See it: `curl -X POST localhost:8081/v1/tokens ...`, then `/suspend`, `/resume`, `DELETE`
- Note: the transition table is total — every one of the 16 (state, op) pairs is asserted either
  legal with a specific target or illegal with a 409. A partially specified state machine is how
  a suspended token quietly becomes authorizable again.

### 2. ID&V decisioning (approve / step-up / decline) with OTP step-up

**Status: Verified.**
- Code: `IdvDecisionEngine`, `OtpService`, `IssuerSimController`
- Proof: `ProvisioningLifecycleIT` — yellow path requires OTP, trusted requestor skips it, three
  wrong codes lock the session, a session cannot activate a different token, red path persists
  nothing, a blocklisted BIN beats a clean risk score
- See it: provision `4111100000000345` from a wallet → 202 + `idvSessionId`

### 3. Card reissue / expiry update keeping tokens valid

**Status: Verified.**
- Code: `CardUpdateService`, `VaultRepository.findByFundingFingerprint`
- Proof: `CardReissueIT` (5 tests), ISSA certification suite steps `reissue-card` →
  `authorize-after-reissue`
- See it: authorize token T, `POST /v1/cards/update`, authorize the *same* T — approved against
  the new PAN, and `GET /sim/last-authorization` shows the issuer received the new card

### 4. ISO 8583 field-level handling, backward compatible across issuer processors

**Status: Verified.**
- Code: `TokenAuthRequestListener`, `PtsPackager` + `packager/pts-iso87ascii.xml`,
  `TokenCryptogramTlv`, `De48Markers`
- Proof: `Iso8583CodecTest` (pack/unpack round trip through the real packager),
  `IsoAuthEndToEndIT` (10 tests over a real TCP socket), both certification suites
- See it: `GET localhost:8083/sim/last-forwarded` after an authorization. Token-unaware issuer →
  `de2IsToken:false`, `strippedFields:[55,48]`. Token-aware issuer → `de2IsToken:true`,
  `strippedFields:[]`. One capability flag, two genuinely different outbound messages.

### 5. HSM-backed key services (PKCS#11), vault encryption, key rotation

**Status: Verified for envelope encryption and rotation; Reviewed for PKCS#11.**
- Code: `KeyService` with `JceKeyService` / `Pkcs11KeyService`, `EnvelopeCipher`,
  `JdbcDekRegistry`, `PanFingerprint`
- Proof: `CryptoTest` (25 tests: wrap/unwrap, tamper detection, AAD binding, IV uniqueness, key
  isolation), `JdbcDekRegistryTest` (9 tests including five sequential rotations),
  `KeyRotationIT` (rotation under live ISO traffic)
- Not executed: the PKCS#11 path — SoftHSM2 was not installed. The code compiles and is
  deliberately small; `ops/softhsm/init-softhsm.sh` creates the token.

### 6. p99 detokenization 38 ms → 22 ms via near-cache and a removed round trip

**Status: Verified, with the calibration disclosed.**
- Code: `DetokenizationService`, `VaultReader`, `ControlsGate`, `AtcGuards`, `DetokProperties`
- Proof: `ops/bench-ab.sh` — **p99 42.43 ms → 3.28 ms**; per-arm p50 tracks ~7 ms per removed
  hop; `DetokenizationMatrixIT` (48 tests) proves all four flag combinations behave identically
- Read the caveats: [RESULTS.md](RESULTS.md) §2. The per-hop latency is injected (the Toxiproxy
  stand-in), the middle arms' p99 is noisy on a laptop, and the harness refuses to report a
  comparison if any arm's accept rate drops below 95%.

### 7. G1 tuning, p99.9 pause outliers reduced

**Status: Verified, direction only.**
- Code: `ops/jvm/baseline.env`, `ops/jvm/tuned.env`, `ops/gc-compare.sh`,
  `ops/gc-log-summarize.py`
- Proof: max pause 22.84 → 15.24 ms (33% lower), request p99.9 23.96 → 12.79 ms (47% lower)
- Honest limit: 14 and 20 collections is too small a sample for a real p99.9, and the parser
  says so itself whenever a log has under 100 collections. The transferable part is the
  mechanism — earlier marking plus reserved space prevents the evacuation failures that produce
  outliers — not the millisecond values.

### 8. Oracle vault partitioned by token BIN, storage lookups under 5 ms p99

**Status: Reviewed. Partitioning not executed.**
- Code: `db/oracle/01_schema.sql` (range partitions, LOCAL and GLOBAL indexes),
  `db/oracle/03_explain_plan.sql`
- Verified instead: SQL portability and correctness against H2 (`VaultRepositoryTest`, 11 tests
  including atomic ATC advance under 16 concurrent threads)
- To prove pruning: run `03_explain_plan.sql` against the Oracle stack and read PSTART/PSTOP.
  The hot path should show a single partition; the reissue lookup should show all of them, which
  is the documented cost of the global fingerprint index.

### 9. Kafka lifecycle events, idempotent producers, no duplicate notifications

**Status: Verified for the outbox and consumer dedupe; Reviewed for Kafka.**
- Code: `OutboxRepository`, `OutboxPoller`, `KafkaEventBroker`, `NotificationHandler`,
  `NotificationDedupeRepository`
- Proof: `OutboxNotificationIT` (6 tests) — events queued in the same transaction as the state
  change, delivered once per event, redelivery suppressed, ordering preserved per token, and no
  PAN or full token in any payload
- The guarantee does not depend on Kafka: it comes from the outbox plus the consumer's
  `eventId` dedupe, which is why it holds across all three transports.

### 10. Spring Cloud shared configuration across environments

**Status: Reviewed.**
- Code: `config-server/`, `config/application{,-dev,-cert,-prod}.yml`
- Verified instead: the shared-default mechanism (`spring.config.import` of
  `config/pts-defaults.yml`) is used by every service in the verified path
- Why it matters concretely: `pts.hsm.dev-seed` must be identical across services or
  provisioning seals PANs that detokenization cannot open. That failure surfaces as
  authorization declines, not as a configuration error, which is exactly the class of problem a
  single source of configuration prevents.

### 11. Active-active dual-DC, failover runbooks

**Status: Replica-level HA Reviewed; dual-DC is Design, deliberately.**
- Code: `ops/nginx/detok-lb.conf` (two replicas, fast ejection, retry on the other),
  `ops/runbooks/failover.md`
- Do not overclaim: the compose stack demonstrates *replica*-level failover. True active-active
  across datacentres needs Data Guard or GoldenGate with a stated RPO, and a cross-DC ATC
  strategy — which is a genuinely hard problem, not a configuration detail.

### 12. Gatling load tests against peak profiles

**Status: Methodology Verified; Gatling itself Reviewed.**
- Code: `loadtest/` (open-model driver, Zipfian feeder, latency histogram),
  `loadtest/src/gatling/java/PaymentTokenSimulation.java`
- Proof: `LoadHarnessTest` (16 tests on the measuring instrument itself, including a test that
  the driver does not suffer coordinated omission)
- Why the driver rather than Gatling: [DESIGN_DEVIATIONS.md](DESIGN_DEVIATIONS.md) §5

### 13. Regulated change management

**Status: Reviewed.**
- Code: `Jenkinsfile` (build → unit → integration → cert suite → manual gate → package),
  `config/application-cert.yml`
- The mechanism is that the `cert` profile mirrors production configuration but points at
  simulators, and the cert suite must pass before a production build is permitted.

### 14-15. Issuer onboarding and the certification replay harness

**Status: Verified.**
- Code: `cert-harness/`, `suites/issuer-a-legacy.yml`, `suites/issuer-b-token-aware.yml`
- Proof: `CertHarnessIT` — both shipped suites pass, plus three self-tests that the runner
  reports genuine failures rather than passing them
- Live: 17/17 and 9/9 steps, [RESULTS.md](RESULTS.md) §4
- The onboarding claim in one sentence: adding an issuer is a BIN block, a `token_aware` flag
  and a YAML file, instead of a round of manual test transactions negotiated by email.

### 16. On-call and latency RCA

**Status: Verified for the mechanism; the runbook is a document.**
- Code: per-stage Micrometer timers in `DetokenizationService` (`resolve`, `controls`,
  `cryptogram`, `atc`, `decrypt`, `total`), `TraceFilter` + `TraceHeaderInterceptor`,
  `PanScrubber`
- Proof: `PanScrubberTest` (9 tests — no PAN reaches a log line, and it fails closed)
- Runbook: `ops/runbooks/latency-rca.md`
- The point: the S8.1 latency budget is *observable*, not estimated. A regression is attributed
  to a stage from the dashboard instead of being guessed at, which is what makes the budget a
  diagnostic tool rather than a design document.

---

## Bonus: things not claimed but built

Because they came up while making the claims true.

| Thing | Why it exists |
|---|---|
| `CacheReconciliationJob` + `pts.cache.drift_repaired` | S16 names cache/vault divergence as the biggest risk. This detects it, repairs it and emits a metric worth alerting on — measured rather than assumed to be zero. |
| Near-cache invalidation batching disabled | Hazelcast's 10-second default made the S8.4 guarantee false. See [RESULTS.md](RESULTS.md) §5. |
| Accept-rate guard in the load driver | The first A/B run was invalid — later arms measured the replay-rejection path. The harness now refuses to report such a comparison. |
| AAD binding of ciphertext to its token PAN | Makes `funding_pan_enc` non-portable between vault rows. |
| Cache write ordered after commit | The cache can lag the vault but never lead it. |
