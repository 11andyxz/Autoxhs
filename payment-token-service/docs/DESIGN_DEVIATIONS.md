# Deviations from the technical design

Where the implementation differs from `network-tokenization-demo-technical-design.md`, and why.
Each entry is a decision someone could reasonably disagree with, so the reasoning is here rather
than buried in a commit message.

---

## 1. Cryptogram verification happens *before* the ATC advance

**Design (S6.1):** step 4 is "ATC monotonicity ... on success, check-and-set `last_atc`", step 5
is "cryptogram validation". Cheapest rejects first.

**Implementation:** the cryptogram is verified first by default
(`detok.atc-order=AFTER_CRYPTOGRAM`).

**Why.** Advancing a counter on an *unauthenticated* request is exploitable. Anyone who learns
a token PAN — and a token travels through acquirers, processors and logs — can submit garbage
cryptograms carrying a high ATC. Under the documented ordering the counter ratchets before
verification fails, and the genuine device's next authorization, carrying a lower ATC, is
rejected as a replay. That is a denial-of-service against a live card, achievable with no key
material at all.

**What it costs.** 1-2 ms of in-process HMAC before a replay is rejected. Negligible against a
network hop, and replays are rare by definition.

**What it does not change.** Both documented demo outcomes hold exactly: replaying a captured
transaction still returns `REPLAY_SUSPECTED` (its cryptogram is valid for that ATC, so it
reaches the ATC gate), and a tampered cryptogram still returns `CRYPTOGRAM_INVALID`.

**How to check both.** `detok.atc-order=BEFORE_CRYPTOGRAM` reproduces the document's ordering.
`DetokenizationMatrixIT.forgedCryptogramDoesNotConsumeTheCounter` asserts the safe behaviour
across all four flag combinations, and the ISSA certification suite covers it end to end
(`authorize-tampered-cryptogram` followed by `authorize-after-tamper`).

---

## 2. A declined provisioning attempt returns 200, not 201

**Design (S5.1):** "On DECLINE -> `201`-not-created; return `{ "decision": "DECLINE", ... }`".

**Implementation:** HTTP 200 with the same body.

**Why.** `201 Created` when nothing was created is self-contradictory, and a client that keys
off the status code would record a token that does not exist. This reads as a typo in the
document rather than a decision. 200 with an explicit decision field keeps the semantics
unambiguous: the request was processed successfully, and the answer was no.

APPROVE is 201 and STEP_UP is 202, so the status code still carries real information.

---

## 3. Token BIN allocation is keyed on the issuer, not the requestor

**Design (S5.1):** "allocate token PAN from the requestor's token-BIN range".

**Implementation:** the range is resolved from the *issuer* of the funding card
(`funding_bin_map` → `issuer_id` → `issuer_bin_map`). The requestor is recorded on the vault
record and enforced as part of the domain restriction.

**Why.** Token BIN ranges are an issuer-level allocation in practice, and S4.1 agrees — the
partitions are commented "demo issuer A range". One requestor (a wallet) provisions cards from
many issuers, so a requestor-keyed range would put several issuers' tokens in one partition and
destroy the operational-isolation argument that motivates the partitioning in the first place.

The requestor still matters, and is still enforced: it is half of the domain restriction that
makes a stolen token useless outside its binding.

---

## 4. Reissuing a card with no tokens returns 200 with zero updated

**Design (S5.5):** does not say.

**Implementation:** 200 with `tokensUpdated: 0`.

**Why.** Issuers reissue cards whether or not those cards were ever tokenized, so "no tokens
found" is a normal outcome rather than an error. 404 would push callers into treating a routine
case as a failure, and it would make the operation non-idempotent to retry.

---

## 5. Gatling is shipped as source; the measured numbers come from a JDK driver

**Design (S11):** Gatling simulations with the Gatling Maven plugin.

**Implementation:** `loadtest/src/gatling/java/PaymentTokenSimulation.java` is shipped and
reviewable but not part of the build. The numbers in [RESULTS.md](RESULTS.md) come from
`loadtest/`, a dependency-free open-model driver.

**Why.** The Gatling plugin pulls a Scala toolchain of well over 100 MB, which would have made
the build heavy and, on this machine, unverifiable. The methodology is what the claim actually
rests on, and the driver implements it explicitly: an open (arrival-rate) model, a Zipfian
feeder, and latency measured from each request's *scheduled* arrival time so queueing delay is
included rather than silently subtracted. That last point is the whole reason the design
argues for an open model, and it is asserted by a unit test
(`LoadHarnessTest.Driver.noCoordinatedOmission`).

---

## 6. The two Hazelcast maps are configured with one deliberate non-default

`hazelcast.map.invalidation.batch.enabled=false`.

Not a deviation from the design so much as something the design does not mention and which
turns out to be load-bearing: with Hazelcast's default batching, near-cache invalidations are
delayed by up to 10 seconds, and the S8.4 guarantee — a suspension visible to the authorization
path in milliseconds — is simply false. The integration suite caught it. See
[RESULTS.md](RESULTS.md) §5.

---

## 7. The certification harness reads token PANs from the vault

**Design (S10.5):** does not say how the harness obtains a token to authorize with.

**Implementation:** `HttpStepExecutor` reads the token PAN from the vault via
`VaultRepository`, because the provisioning API deliberately never returns it.

**Why.** The harness stands in for the token requestor's device, which legitimately holds the
token — that is what a wallet SDK has on the handset. Adding an API that returns token PANs
would have been the wrong fix: it would put the one value the whole design keeps out of APIs
into an endpoint, permanently, for the convenience of a test tool.
