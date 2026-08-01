# Demo script

The click-through for an interview. Roughly 8-10 minutes, sequenced so each beat sets up the
next. Every command below was executed against the local stack; the outputs shown are real.

```bash
./build.sh                      # 260 tests. Do this before the call, not during it.
ops/run-local.sh optimized      # eight services, no Docker required
```

Ports: provisioning 8081, detokenization 8082, switch 8083 (+ ISO 8583 on 8583), controls 8084,
issuer 8085, notifications 8086, cert harness 8087, Hazelcast member 8090.

---

## Beat 0 — open with the framing (30 seconds)

> "Production code at a payment network is confidential, so this is a from-scratch reference
> implementation of the same concepts, on publicly documented standards only: EMVCo
> tokenisation, ISO 8583, PKCS#11. Every real cryptographic and infrastructure component is a
> clearly labelled stand-in. Every claim on my résumé maps to something you can run here, and
> I'll tell you which parts I have actually executed and which I haven't."

That last sentence is the one that buys you credibility for everything after it.

---

## Beat 1 — provisioning and ID&V (2 minutes)

```bash
curl -s -X POST localhost:8081/v1/tokens \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' \
  -d '{"fundingPan":"4111100000000725","expiry":"2812","cardholderName":"A XIONG",
       "requestorId":"40010030001","domainType":"ECOM","deviceId":"demo-device-01"}'
```

```json
{"tokenRef":"4ce99bcb-...","tokenLast4":"2512","status":"ACTIVE",
 "tokenExpiry":"3112","decision":"APPROVE"}
```

**Point at two things.** There is no token PAN in that response — APIs speak `tokenRef` and
`last4`, and the token itself only ever travels on the authorization rails. And the token expiry
is 3112 while the card expires 2812: the token outlives the plastic, which is what makes beat 5
possible.

Now replay the same request with the same idempotency key:

```bash
# same command again
```
```
HTTP/1.1 201
Idempotent-Replay: true
tokenRef: 4ce99bcb-...   <- the same token, not a second one
```

> "A client timeout must not create two tokens for one card. The key is claimed by an insert
> before the work starts, so two concurrent retries can't both provision, and the *response* is
> stored rather than just the key — so the retry gets the same tokenRef."

Then the yellow path. The issuer simulator scores deterministically from the card's last four
digits, so demos are reproducible:

```bash
curl -s -X POST localhost:8081/v1/tokens -H 'Content-Type: application/json' \
  -d '{"fundingPan":"4111100000000345","expiry":"2812","requestorId":"40010030001",
       "domainType":"ECOM","deviceId":"demo-device-02","idvChannel":"SMS"}'
```
```json
{"tokenRef":"40c44507-...","status":"PENDING_IDV","decision":"STEP_UP",
 "idvSessionId":"e7fadf22-...","idvChannel":"SMS"}
```

202, not 201, and the token cannot authorize yet. Complete it:

```bash
OTP=$(curl -s localhost:8081/v1/idv/sessions/<sessionId>/otp)   # simulated SMS channel
curl -s -X POST localhost:8081/v1/tokens/<tokenRef>/idv/verify \
  -H 'Content-Type: application/json' -d "{\"idvSessionId\":\"<sessionId>\",\"otp\":\"$OTP\"}"
```
```json
{"tokenRef":"40c44507-...","status":"ACTIVE","decision":"APPROVE"}
```

And the two decline paths — the second is the interesting one:

```bash
# risk 85 -> red path
-d '{"fundingPan":"4111100000000485", ...}'  =>  {"decision":"DECLINE","reason":"RISK_SCORE_85_AT_OR_ABOVE_70"}
# risk 25 (clean!) but the BIN is blocklisted
-d '{"fundingPan":"4333300000000525", ...}'  =>  {"decision":"DECLINE","reason":"FUNDING_BIN_BLOCKED"}
```

> "Local rules are evaluated before the issuer's score, so a blocklist can't be overridden by a
> favourable risk signal. And a declined attempt persists nothing — there's no vault row to
> clean up later."

---

## Beat 2 — ISO 8583 and issuer backward compatibility (2 minutes)

This is the strongest beat. Run the certification suite for a **token-unaware** issuer:

```bash
curl -s -X POST "localhost:8087/cert/run?suite=suites/issuer-a-legacy.yml"
```
```
ISSA legacy issuer certification — 17 passed, 0 failed, 0 skipped in 1475 ms
  PASS capability-legacy / provision-green / authorize-approved / authorize-replay
  PASS authorize-tampered-cryptogram / authorize-after-tamper / authorize-wrong-requestor
  PASS suspend / authorize-while-suspended / suspend-again-is-conflict / resume
  PASS authorize-after-resume / reissue-card / token-reflects-new-card
  PASS authorize-after-reissue / delete / authorize-after-delete
```

Every `authorize` step opened a real TCP socket to the jPOS listener. Now show *what the switch
sent to the issuer*:

```bash
curl -s localhost:8083/sim/last-forwarded
curl -s localhost:8085/sim/last-authorization
```

For ISSA (token-unaware): `"de2IsToken": false`, `"strippedFields": [55, 48]` — DE 2 swapped to
the funding PAN, the cryptogram TLV and the token markers removed. The issuer received a message
indistinguishable from a plain card transaction and needed no changes at all.

Then run the **token-aware** suite:

```bash
curl -s -X POST "localhost:8087/cert/run?suite=suites/issuer-b-token-aware.yml"   # 9/9
curl -s localhost:8083/sim/last-forwarded
```

`"de2IsToken": true`, `"strippedFields": []` — the token and its cryptogram forwarded intact.

> "Same inbound authorization, one capability flag different, two genuinely different outbound
> messages. That's what 'field-level handling preserving backward compatibility across issuer
> processors' actually means. And note the response back to the acquirer always carries the
> token, never the funding PAN — returning the PAN there would leak exactly what tokenization
> exists to hide."

Also worth pointing out from the suite output: `authorize-tampered-cryptogram` is followed by
`authorize-after-tamper`, which re-uses the *same* ATC successfully. That is a deliberate
deviation from the design document — see [DESIGN_DEVIATIONS.md](DESIGN_DEVIATIONS.md) §1 — and
it is a good thing to be asked about.

---

## Beat 3 — the latency A/B (2 minutes)

```bash
ops/bench-ab.sh 7 400 "ramp:50->400/15s,constant:400/30s,spike:900/10s"
```

```
ARM                p50      p95      p99    p99.9       max       ok  accept%
baseline         27.48    32.58    42.43   115.00    334.01    23897     98.1
cache-only       18.52    22.86    57.00   148.00    186.38    23942     98.2
inline-only       9.11    11.67    25.01    84.95    140.55    24129     99.0
optimized         0.28     1.30     3.28    58.79    151.76    24364    100.0

p99: 42.43 ms -> 3.28 ms  (92% reduction), all arms on the accept path
```

**Lead with the p50 column, not the p99.** 27.5 → 18.5 → 9.1 → 0.28, against a calibrated 7 ms
per hop:

| arm | synchronous hops remaining | p50 |
|---|---|---|
| baseline | 3 — vault read, controls call, ATC update | 27.48 |
| cache-only | 2 — controls call, ATC update | 18.52 |
| inline-only | 1 — vault read | 9.11 |
| optimized | 0 | 0.28 |

> "Each optimization removes one synchronous round trip and about 9 ms of p50 goes with it. The
> improvement is attributable per hop, not one aggregate number."

**Then volunteer the three caveats before you're asked.** The 7 ms is injected — it stands in
for Toxiproxy, because a local database answers in under a millisecond and removing a round trip
would otherwise measure as free. The `cache-only` p99 is *worse* than baseline, which is laptop
tail noise from running four JVMs and the load driver on one machine, not a property of the
near-cache. And the first version of this benchmark was wrong: reusing tokens across arms meant
later arms were rejected as ATC replays and measured a short-circuited path, reporting "94%".
Each arm now gets a disjoint token slice and the harness refuses to print a comparison if any
arm's accept rate falls below 95%.

Volunteering that last one is worth more than the number itself.

---

## Beat 4 — cache safety under lifecycle change (1 minute)

The obvious objection: doesn't caching risk authorizing a suspended token?

```bash
# authorize -> suspend -> authorize -> resume -> authorize
curl -s -X POST "localhost:8087/cert/run?suite=target/local/cache-safety.yml"
```
```
  PASS auth-1                 [iso-authorize]   DE 39 00
  PASS suspend                [suspend]
  PASS auth-while-suspended   [iso-authorize]   DE 39 05   <- immediately, no TTL wait
  PASS resume                 [resume]
  PASS auth-after-resume      [iso-authorize]   DE 39 00
```

> "Writes are write-through and trigger cluster-wide near-cache invalidation, so the next
> authorization sees the change. TTL is only a backstop — we never rely on it for
> security-relevant state."

**Then tell the invalidation story**, because it is the best evidence the tests are real:

> "This actually failed the first time I ran it. Hazelcast batches near-cache invalidations by
> default and flushes every ten seconds, so on a low-write map a suspended token kept
> authorizing for up to ten seconds. The guarantee was quietly false and it would have demoed
> fine on any cold cache. One member property fixed it, at the cost of one small cluster message
> per vault write."

And the residual risk, with the mitigation:

```bash
curl -s -X POST localhost:8081/admin/cache/reconcile   # {"repaired": 0}
```

> "A crash between the database commit and the cache push would still leave a stale entry until
> TTL. That's the highest-consequence bug class in the design, so it's measured: this sweep
> compares cache against vault, repairs drift, and increments a counter worth alerting on. The
> integration test manufactures the divergence, shows a suspended token really does authorize,
> then watches the sweep fix it."

---

## Beat 5 — card reissue keeps tokens valid (1 minute)

The most commercially interesting beat, and it is one screen.

```bash
# 1. authorize token T; the issuer sees card ...0725
# 2. reissue the underlying card
curl -s -X POST localhost:8081/v1/cards/update -H 'Content-Type: application/json' \
  -d '{"oldFundingPan":"4111100000000725","newFundingPan":"4111100000002325","newExpiry":"3012"}'
# => {"tokensUpdated":1,"tokenRefs":["..."]}
# 3. authorize the SAME token T
curl -s localhost:8085/sim/last-authorization   # fundingPan is now ...2325
```

> "Same token PAN, same tokenRef, new funding card underneath. The merchant changed nothing and
> never learns anything happened. That removes a whole class of avoidable declines — and it's why
> the fingerprint index has to be global: one cardholder's tokens can span several token-BIN
> partitions, so finding them all crosses partitions. That's the one place I pay for a global
> index, and it's affordable because reissue is low-rate write-side traffic."

---

## Beat 6 — key rotation under live traffic (45 seconds)

```bash
curl -s -X POST localhost:8081/admin/keys/rotate
# {"previousVersion":1,"activeVersion":2,"keyService":"JCE-DEV (...NOT a security boundary)"}
curl -s localhost:8081/admin/keys
```

Then authorize a token provisioned *before* the rotation — it still works.

> "Each row stores the key version it was sealed under, so rotation needs no re-encryption sweep
> before the vault is readable again. That's the difference between a rotation you run on a
> Tuesday afternoon and one that needs a maintenance window. Only the wrapped DEK is ever
> persisted — the registry table is useless without the HSM-held KEK."

Note the `keyService` string names itself as a dev stand-in. That is deliberate: it is the label
that stops anyone mistaking this for real key custody.

---

## Beat 7 — events, exactly-once in effect (45 seconds)

```bash
curl -s localhost:8081/admin/outbox        # {"pending": 0}
curl -s localhost:8086/sim/counters        # {"notifications": 12, "dedupeEntries": 12}
```

> "The state change and the event are one transaction, so a crash can't lose the event. Publish
> happens before the row is stamped, so a crash produces a duplicate rather than a loss — a
> duplicate the idempotent producer and the consumer's eventId dedupe absorb. A lost suspend
> notification is unrecoverable; a duplicate never is. And the dedupe is in the database, not in
> memory, because a consumer restart is exactly when a redelivery is most likely."

Show a payload: no PAN, no full token, only `tokenRef` and `tokenLast4`, plus a `schemaVersion`.

---

## Beat 8 — close on what you have not proven (30 seconds)

Have [SIMPLIFICATIONS.md](SIMPLIFICATIONS.md) open.

> "The pure-JVM path is what I've actually executed — 260 tests, the A/B, the GC comparison, both
> certification suites. The Docker Compose stack with Oracle, Kafka and Toxiproxy is written and
> reviewed but I haven't run it, because this machine has no Docker. The PKCS#11 path is the same
> — SoftHSM2 isn't installed. The Oracle partitioning claim is DDL plus an explain-plan script,
> not a measurement. If you want to push on any of those, that's the honest boundary."

Then the one-liner:

> "It's a faithful reference implementation of the concepts on publicly documented standards.
> Every stand-in is labelled, and I can tell you exactly what would change to make each piece
> production-grade."

---

## Questions to be ready for

Full answers in S16 of the design document. The four most likely, and where the code is:

| Question | Where to point |
|---|---|
| Why Hazelcast rather than Redis? | Redis is a *remote* cache — every hit is still the hop you're trying to remove. Near-cache is in-process with cluster-wide invalidation. `VaultClusterConfig` explains why the near-cache is on the client and not the member. |
| Isn't the ATC write-behind a durability risk? | Yes, and it is the one place the design trades durability for latency. The replay window equals the write-behind lag. Mitigations are documented on `AtcMapStore`: short interval, database anchoring on cold load, monotonic writes, and the cryptogram binds ATC/UN/amount regardless. |
| How do you know the p99 isn't cherry-picked? | Four arms, one build, identical profile, per-stage timers, the calibration disclosed, and a guard that refuses to report a comparison built on rejected traffic. [RESULTS.md](RESULTS.md) §2. |
| Biggest risk if this were real? | Cache/vault divergence on `status`. Hence write-through plus invalidate, hence `CacheSafetyIT` manufacturing the divergence, hence `pts.cache.drift_repaired` as an alertable metric. |
