# Network Payment Tokenization Service — Technical Design & Demo Specification

**Codename:** `payment-token-service` (a from-scratch reference implementation)
**Author:** Andy Xiong · **Stack:** Java 17 · Spring Boot 3 · Spring Cloud · Hazelcast · Oracle Database · Kafka · ISO 8583 (jPOS) · PKCS#11 HSM (SoftHSM2) · Docker Compose · Gatling · Prometheus/Grafana

> **How to position this in an interview.** Production code at a payment network is confidential, so this repository is a from-scratch reference implementation of the same *concepts*: EMVCo-style network tokenization (provisioning, lifecycle, detokenization inside the authorization path), built only on publicly documented standards (EMVCo Payment Tokenisation framework, ISO 8583, PCI DSS, PKCS#11). Real production components are replaced by faithful stand-ins — SoftHSM2 for a payment HSM, simulators for the issuer and the authorization switch, Toxiproxy to reproduce realistic datacenter network latency. Every headline claim on the résumé maps to something you can run and measure in this demo (see §2 traceability table).

---

## 1. Business Context

### 1.1 Why network tokenization exists

A payment card's **PAN** (Primary Account Number) is a long-lived, high-value secret. If a merchant or wallet stores it and is breached, the card must be reissued and every recurring relationship breaks. **Network tokenization** (the EMVCo Payment Tokenisation framework, implemented by the card networks as a **Token Service Provider / TSP**) replaces the funding PAN with a **network token** (a **DPAN** when bound to a device):

- The token is **format-identical to a PAN** — 16 digits, Luhn-valid, drawn from dedicated **token BIN ranges** — so it can travel through existing ISO 8583 authorization rails unchanged.
- The token is **domain-restricted**: bound to a specific token requestor (a wallet like Apple Pay/Google Pay, or a merchant's card-on-file), and to a usage domain (contactless, e-commerce). Stolen tokens are useless outside their domain.
- Each transaction carries a **one-time cryptogram** (a TAVV-style value) computed with keys held in HSMs, plus an **ATC** (Application Transaction Counter) for replay protection.
- During authorization, the network performs **detokenization**: it swaps the token back to the funding PAN before forwarding to the issuer (for issuers not yet token-aware), and validates the cryptogram. This sits **inside the authorization path**, so its latency budget is measured in single-digit-to-low-tens of milliseconds — that is the engineering center of gravity of this project.

### 1.2 The three planes of the system

| Plane | Traffic profile | Consistency need | Latency need |
|---|---|---|---|
| **Provisioning / ID&V** | Low TPS, bursty (device setup) | Strong (uniqueness, state machine) | Seconds acceptable |
| **Lifecycle management** (suspend/resume/delete, card reissue updates) | Low TPS, issuer/wallet initiated | Strong, must propagate to auth path fast | Sub-second propagation |
| **Detokenization (authorization path)** | Very high TPS, read-heavy, holiday peaks | Read-mostly; bounded staleness acceptable *only* for some fields | **p99 ≈ 20–25 ms hard budget** |

The architectural tension — *strongly consistent lifecycle writes* vs *ultra-low-latency reads that must reflect those writes within milliseconds* — is what motivates the Hazelcast near-cache design in §8 and is the story behind the **p99 38 ms → 22 ms** improvement.

---

## 2. Scope & Claims Traceability

What the demo **implements**, what it **simulates**, and what is **design-discussion only** — plus which résumé claim each part evidences.

| # | Résumé claim | Demo evidence |
|---|---|---|
| 1 | Token provisioning & lifecycle APIs (issue / suspend / resume / delete) | `token-provisioning-service` REST APIs + token state machine (§5.1, §6.1) |
| 2 | ID&V decisioning (approve / step-up / decline) with OTP step-up | Rule-based decision engine + issuer-simulator risk response + OTP session flow (§5.2) |
| 3 | Card-reissue / expiry-update lifecycle keeping tokens valid | `POST /v1/cards/{panRef}/update` re-mapping flow + live demo: same token authorizes after funding-PAN refresh (§5.5) |
| 4 | ISO 8583 field-level handling for token cryptogram data, backward compatible | jPOS-based `auth-switch-simulator`, DE-level mapping, per-issuer capability flags (§6.2) |
| 5 | HSM-backed key services (PKCS#11), vault encryption, key rotation | SoftHSM2 via SunPKCS11: HSM-resident cryptogram key + KEK-wrapped DEK envelope encryption + `key_version` rotation (§7) |
| 6 | **p99 detokenization 38 ms → 22 ms** via Hazelcast near-cache + eliminating a synchronous round trip | A/B feature flags: `detok.cache.mode=DIRECT|NEAR_CACHE` and `detok.controls.inline=true|false`; Gatling + Grafana show the before/after percentile curves (§8, §11) |
| 7 | G1 tuning, p99.9 pause outliers −40% | Baseline vs tuned JVM flag sets, `-Xlog:gc*` analysis, GC-pause Grafana panel under load (§9) |
| 8 | Oracle vault partitioned by token BIN range, storage lookups < 5 ms p99 | Range-partitioned `TOKEN_VAULT` DDL + partition-pruning explain plan + DB-side timer metric (§4) |
| 9 | Kafka lifecycle events, idempotent producers, no duplicate notifications | Transactional outbox → Kafka producer with `enable.idempotence=true`; consumer-side dedupe by `eventId` (§10.2) |
| 10 | Spring Cloud shared config across environments | `config-server` (native/file backend) with `dev` / `cert` / `prod` profiles (§12) |
| 11 | Active-active dual-DC, failover runbooks | Two detokenization replicas behind an LB; live kill-one-replica-under-load demo; dual-DC design discussion (§10.4) |
| 12 | Gatling load tests against peak profiles | Open-model (arrival-rate) Gatling suite with Zipfian token access, calibrated via Toxiproxy (§11) |
| 13 | Regulated change management | `cert` profile gating + Jenkinsfile stages (build → cert suite → manual approval) (§10.5) |
| 14–15 | Issuer onboarding + cert-environment replay harness | `cert-harness` module: YAML-defined certification suites replayed end-to-end, HTML report (§10.5) |
| 16 | On-call / latency RCA | Runbook doc + the latency-budget methodology in §8.2 *is* the RCA framework |

**Explicitly out of scope (design-discussion only):** real EMV ARQC cryptography and payment-HSM (payShield-class) command sets, cross-region Oracle replication, real wallet SDK integration. §15 lists every simplification and what the production-grade equivalent is — knowing your simplifications is part of surviving scrutiny.

---

## 3. System Architecture

```
                                   ┌───────────────────────────────────────────────┐
                                   │                DEMO TRAFFIC SOURCES           │
                                   │  curl / Postman        Gatling (load)         │
                                   └───────┬───────────────────────┬───────────────┘
                                           │ REST (mTLS)           │ ISO 8583 (TCP) + REST
                                           ▼                       ▼
        ┌───────────────────────────┐            ┌────────────────────────────────┐
        │ token-provisioning-service│            │     auth-switch-simulator      │
        │  - provision + ID&V       │            │  (jPOS)  0100 in → 0110 out    │
        │  - OTP step-up sessions   │            │  DE2 token → detokenize →      │
        │  - lifecycle: suspend/    │            │  forward FPAN to issuer-sim    │
        │    resume/delete          │            └───────────────┬────────────────┘
        │  - card reissue updates   │                            │ REST (LB: nginx)
        └──────┬──────────┬─────────┘                            ▼
               │          │                    ┌──────────────────────────────────┐
               │          │ write-through      │   detokenization-service ×2      │
               │          ▼                    │  ┌────────────────────────────┐  │
               │   ┌────────────────┐  client  │  │  Hazelcast NEAR-CACHE      │  │
               │   │ Hazelcast      │◄─────────┤  │  (in-process, TTL 60s)     │  │
               │   │ cluster ×2     │  IMap    │  └────────────────────────────┘  │
               │   │ vault-records  │  reads   │   cryptogram check → PKCS#11     │
               │   │ token-atc      │          │   (SoftHSM2, in-process)         │
               │   └───────┬────────┘          └───────────────┬──────────────────┘
               │           │ read-through MapLoader            │ cache miss / DIRECT mode
               │           ▼                                   ▼
               │   ┌─────────────────────── Toxiproxy (+6ms RTT toxic) ───────────┐
               │   │                                                              │
               ▼   ▼                                                              │
        ┌────────────────┐    ┌──────────────────────┐    ┌──────────────────┐    │
        │ Oracle Free 23 │    │ token-controls-svc   │◄───┤ (baseline-only   │◄───┘
        │ TOKEN_VAULT    │    │ (the "legacy hop"    │    │  synchronous     │
        │ range-part. by │    │  removed in v2)      │    │  round trip)     │
        │ TOKEN_BIN      │    └──────────────────────┘    └──────────────────┘
        └───────┬────────┘
                │ outbox poller (idempotent producer)
                ▼
        ┌────────────────┐     ┌──────────────────────────┐    ┌────────────────┐
        │ Kafka (KRaft)  ├────►│ issuer-notification-sim  │    │ issuer-simulator│
        │ token.lifecycle│     │ (consumer, dedupe by id) │    │ ID&V + auth     │
        └────────────────┘     └──────────────────────────┘    └────────────────┘

        Observability: every service → Micrometer → Prometheus → Grafana
        (dashboards: detok latency percentiles, cache hit ratio, GC pauses, Kafka lag)
```

### 3.1 Component responsibilities

**token-provisioning-service** — Owns the token state machine and all writes. Provisioning runs ID&V (§5.2), allocates a token PAN from a token-BIN range, encrypts the funding PAN (envelope encryption, §7.2), persists to Oracle, writes an outbox event, and **write-throughs the vault record into the Hazelcast `vault-records` IMap** so the authorization path sees lifecycle changes within milliseconds.

**detokenization-service** (×2 replicas) — The latency-critical read path. Given `(tokenPan, cryptogram, atc, un, amount, requestorId, domain)`, it must: resolve token → funding PAN, verify status + domain restrictions, validate the cryptogram against the HSM-resident key, enforce ATC monotonicity, and return the funding PAN — inside a p99 budget of ~22 ms. Two read strategies behind a flag: `DIRECT` (JDBC to Oracle through Toxiproxy — the "before" world) and `NEAR_CACHE` (Hazelcast client with near-cache — the "after" world).

**token-controls-service** — Deliberately exists to *be removed*. In the baseline flow, detokenization makes a synchronous REST call here for status/domain checks (this models the pre-optimization architecture where controls lived in a separate service). The optimization denormalizes controls into the vault record so the check is served from the same cached entry — this is the "eliminated a synchronous round trip" from the résumé, reproduced live by flipping `detok.controls.inline`.

**auth-switch-simulator** — jPOS server accepting ISO 8583 `0100` authorization requests over TCP. Extracts the token from DE 2 and cryptogram data from the private-use field, calls detokenization, swaps DE 2 to the funding PAN, forwards to the issuer-simulator, relays the `0110` response. Demonstrates field-level ISO 8583 handling and issuer backward compatibility (§6.2).

**issuer-simulator** — Two roles: (a) ID&V risk decision endpoint returning APPROVE / STEP_UP / DECLINE from configurable rules; (b) authorization decisioning on the detokenized PAN (balance rules, expired card, etc.).

**Hazelcast cluster (2 members)** — Hosts `vault-records` (read-through `MapLoader` from Oracle; TTL 300 s) and `token-atc` (ATC check-and-set via entry processors; write-behind to Oracle). Detokenization services connect as **clients with near-cache enabled** — reads for hot tokens are served from process-local memory with cluster-wide invalidation on writes.

**Toxiproxy** — Sits on the JDBC path and the controls-service path, injecting ~6–8 ms RTT so a laptop reproduces realistic cross-rack/cross-zone costs. Without it, local Oracle answers in <1 ms and the optimization would be invisible; with it, the before/after percentile curves take production shape. Being explicit about this calibration is a credibility feature, not a weakness (§11.3).

---

## 4. Data Model (Oracle)

### 4.1 Core vault table — range-partitioned by token BIN

```sql
CREATE TABLE token_vault (
    token_pan        VARCHAR2(19)  NOT NULL,     -- the network token (DPAN), Luhn-valid
    token_ref        VARCHAR2(36)  NOT NULL,     -- opaque UUID used in APIs/events (never the PAN)
    token_bin        NUMBER(8)     NOT NULL,     -- leading 8 digits, partitioning key
    funding_pan_enc  RAW(80)       NOT NULL,     -- IV(12) || AES-256-GCM ciphertext || tag(16)
    funding_pan_h    RAW(32)       NOT NULL,     -- HMAC-SHA-256 fingerprint (keyed; see §7.3)
    funding_last4    CHAR(4)       NOT NULL,
    funding_expiry   CHAR(4)       NOT NULL,     -- YYMM
    token_expiry     CHAR(4)       NOT NULL,
    status           VARCHAR2(12)  NOT NULL,     -- PENDING_IDV | ACTIVE | SUSPENDED | DELETED
    requestor_id     VARCHAR2(11)  NOT NULL,     -- token requestor (TRID-style)
    domain_type      VARCHAR2(12)  NOT NULL,     -- CONTACTLESS | ECOM
    issuer_id        VARCHAR2(8)   NOT NULL,
    device_id        VARCHAR2(64),
    last_atc         NUMBER(5)     DEFAULT 0 NOT NULL,
    key_version      NUMBER(3)     NOT NULL,     -- DEK version used for funding_pan_enc
    created_at       TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at       TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_token_vault PRIMARY KEY (token_pan)
)
PARTITION BY RANGE (token_bin) (
    PARTITION p_bin_49996000 VALUES LESS THAN (49996100),   -- demo issuer A range
    PARTITION p_bin_49996100 VALUES LESS THAN (49996200),   -- demo issuer B range
    PARTITION p_bin_49996200 VALUES LESS THAN (49996300),
    PARTITION p_max          VALUES LESS THAN (MAXVALUE)
);

-- Local index: detok lookup is always by token_pan, whose leading digits ARE the
-- partition key → single-partition access, index probe stays inside one partition.
-- (PK index is created local-prefixed by including token_bin implicitly via pruning
--  on the predicate; explain-plan check is part of the demo script.)

-- Reissue lookups ("find all tokens for this funding card") cross partitions
-- → deliberate GLOBAL index; low write rate makes maintenance cost acceptable.
CREATE INDEX gx_vault_funding_h ON token_vault (funding_pan_h) /* GLOBAL */;
```

**Why partition by token BIN range (interview answer, condensed):** (1) *Pruning* — every detokenization query carries the token PAN, whose leading digits identify exactly one partition, so lookups touch one partition's local index segment → the < 5 ms p99 storage claim. (2) *Operational isolation* — an issuer's token range can be maintained (moved, compressed, purged) without touching others. (3) *Predictable growth* — new issuers get new BIN blocks → new partitions, no reshuffling. Trade-off acknowledged: the funding-PAN fingerprint index must be GLOBAL because reissue queries span partitions; acceptable because reissue is low-frequency write-side traffic.

### 4.2 Supporting tables

```sql
CREATE TABLE token_outbox (          -- transactional outbox for Kafka (§10.2)
    event_id     VARCHAR2(36) PRIMARY KEY,
    token_ref    VARCHAR2(36) NOT NULL,   -- Kafka key → per-token ordering
    event_type   VARCHAR2(20) NOT NULL,   -- PROVISIONED|ACTIVATED|SUSPENDED|RESUMED|DELETED|CARD_UPDATED
    payload      CLOB         NOT NULL,
    created_at   TIMESTAMP    DEFAULT SYSTIMESTAMP,
    published_at TIMESTAMP                 -- NULL = pending
);

CREATE TABLE idv_sessions (          -- OTP step-up state
    session_id   VARCHAR2(36) PRIMARY KEY,
    token_ref    VARCHAR2(36) NOT NULL,
    otp_hash     RAW(32)      NOT NULL,
    attempts     NUMBER(1)    DEFAULT 0,
    expires_at   TIMESTAMP    NOT NULL
);

CREATE TABLE issuer_bin_map (        -- token BIN → issuer + capabilities
    token_bin_start NUMBER(8) PRIMARY KEY,
    token_bin_end   NUMBER(8) NOT NULL,
    issuer_id       VARCHAR2(8) NOT NULL,
    token_aware     CHAR(1)   DEFAULT 'N'   -- drives ISO 8583 backward-compat behavior (§6.2)
);

CREATE TABLE key_registry (          -- envelope-encryption DEKs, wrapped by HSM KEK (§7.2)
    key_version  NUMBER(3) PRIMARY KEY,
    wrapped_dek  RAW(64)   NOT NULL,
    state        VARCHAR2(10) NOT NULL,     -- ACTIVE | DECRYPT_ONLY | RETIRED
    created_at   TIMESTAMP DEFAULT SYSTIMESTAMP
);

CREATE TABLE idempotency_keys (      -- provisioning retry safety (§10.1)
    idem_key     VARCHAR2(64) PRIMARY KEY,
    request_hash RAW(32)     NOT NULL,
    response     CLOB,
    created_at   TIMESTAMP DEFAULT SYSTIMESTAMP
);
```

### 4.3 Token state machine

```
                 ID&V=STEP_UP                OTP ok
  (provision) ──► PENDING_IDV ─────────────► ACTIVE ◄──────────┐
        │                                      │  ▲            │ resume
        │ ID&V=APPROVE                 suspend │  │            │
        └────────────────────────────► ACTIVE  ▼  │        SUSPENDED
                                            SUSPENDED ─────────┘
   ID&V=DECLINE → (no row persisted           │ delete            delete
                   beyond audit)              ▼                     ▼
                                           DELETED (terminal; tombstone kept for audit)
```

Rules enforced in one place (`TokenStateMachine`): illegal transitions → HTTP 409; every legal transition = one Oracle transaction that (a) updates `token_vault`, (b) inserts the outbox event, (c) write-throughs the Hazelcast entry — so cache, DB, and event stream cannot silently diverge (§8.4 covers the failure modes).

<!--PART2-->

---

## 5. API & Flow Specifications (provisioning-service)

All APIs are REST/JSON over mTLS. Tokens are never echoed in plaintext in responses/logs; APIs use `tokenRef` (opaque UUID), and only `last4` is ever displayed.

### 5.1 Provision a token

```
POST /v1/tokens
Idempotency-Key: <client-supplied UUID>          # see §10.1
Content-Type: application/json

{
  "fundingPan": "4999 6xxx xxxx xxxx",            # demo PANs only; test BINs
  "expiry": "2812",
  "cardholderName": "A XIONG",
  "requestorId": "40010030001",                    # wallet / merchant token requestor
  "domainType": "ECOM",
  "deviceId": "demo-device-01",                     # present ⇒ DPAN semantics
  "idvChannel": "SMS"                               # channel for step-up if required
}
```

Processing pipeline (single Oracle transaction unless step-up is triggered):
1. **Idempotency check** — if `Idempotency-Key` seen with matching request hash, replay stored response (§10.1).
2. **Input validation** — Luhn on funding PAN, expiry not past, requestor known, domain valid.
3. **ID&V decision** — call issuer-simulator risk endpoint → `APPROVE | STEP_UP | DECLINE` (§5.2).
4. **On DECLINE** → `201`-not-created; return `{ "decision": "DECLINE", "reason": ... }`, audit only.
5. **On STEP_UP** → create `idv_sessions` row, send OTP (simulated), return `202` with `idvSessionId`; token sits in `PENDING_IDV`. Client completes via §5.3.
6. **On APPROVE (or after OTP)** → allocate token PAN from the requestor's token-BIN range (Luhn-complete the check digit), envelope-encrypt the funding PAN (§7.2), compute keyed fingerprint, `INSERT` into `token_vault` with `status=ACTIVE`, `INSERT` outbox `PROVISIONED`+`ACTIVATED`, write-through Hazelcast.

```
201 Created
{
  "tokenRef": "6f1c...e2",
  "tokenLast4": "4821",
  "status": "ACTIVE",
  "tokenExpiry": "2912",
  "decision": "APPROVE"
}
```

### 5.2 ID&V decisioning engine

Rule-based, deterministic, so the demo is reproducible. The engine composes issuer risk signal + local rules:

| Signal (from issuer-sim, driven by funding PAN pattern) | Local rule | Decision |
|---|---|---|
| `riskScore < 30` | — | APPROVE |
| `30 ≤ riskScore < 70` | requestor is trusted merchant | APPROVE |
| `30 ≤ riskScore < 70` | wallet provisioning | STEP_UP (OTP) |
| `riskScore ≥ 70` | — | DECLINE |
| any | funding BIN on demo blocklist | DECLINE |

This mirrors the real ID&V "green/yellow/red path" model (approve / step-up / decline) without pretending to be a real risk engine. Interview point: emphasize you are modeling the *decision contract and the state consequences*, not building a fraud model.

### 5.3 Complete OTP step-up

```
POST /v1/tokens/{tokenRef}/idv/verify
{ "idvSessionId": "...", "otp": "482913" }
```
Verifies `otp_hash`, enforces attempt limit (3) and expiry (5 min); on success promotes `PENDING_IDV → ACTIVE` (one transaction: vault update + outbox `ACTIVATED` + Hazelcast write-through). On exhaustion → session invalidated, token stays `PENDING_IDV` (cleaned by a scheduled job).

### 5.4 Lifecycle operations

```
POST /v1/tokens/{tokenRef}/suspend     # ACTIVE → SUSPENDED
POST /v1/tokens/{tokenRef}/resume      # SUSPENDED → ACTIVE
DELETE /v1/tokens/{tokenRef}           # * → DELETED (terminal)
```
Each is one transaction (vault + outbox + Hazelcast write-through). Illegal transition → `409 Conflict` from the state machine. **Note on DELETE:** this is a domain "delete token" (mark DELETED + tombstone for audit), not a hard row delete — deliberately distinct from destructive data deletion. The row is retained for audit; only a separate, out-of-band retention job purges tombstones.

### 5.5 Card reissue / expiry update — the "keep tokens valid" flow

This is the demo's most compelling lifecycle story. When an issuer reissues a card (new PAN and/or expiry after loss/expiry), the *network token must survive* so the wallet/merchant keeps working — this is what eliminates a class of avoidable declines.

```
POST /v1/cards/update
{
  "oldFundingPan": "4999 6xxx xxxx 1111",
  "newFundingPan": "4999 6xxx xxxx 9999",
  "newExpiry": "3012"
}
```
1. Compute keyed fingerprint of `oldFundingPan`; **global index** lookup finds all `token_vault` rows for that card (may span partitions — hence the global index in §4.1).
2. For each affected token: re-encrypt with the new funding PAN under the current DEK, update `funding_expiry`, `funding_last4`, keep the **same token PAN**.
3. One transaction per token: vault update + outbox `CARD_UPDATED` + Hazelcast write-through (so the auth path immediately maps the token to the new PAN).

**Live demo beat:** authorize with token T → issuer-sim approves. Reissue the underlying card. Authorize with the *same token T* again → the auth-switch now detokenizes to the *new* PAN, issuer-sim approves. The merchant never changed anything. This is a one-screen, high-impact demonstration.

---

## 6. Detokenization & ISO 8583 (the authorization path)

### 6.1 Detokenization API (called by the auth switch)

```
POST /v1/detokenize          # internal, mTLS, latency-critical
{
  "tokenPan": "4999 6xxx xxxx 4821",
  "cryptogram": "9F26...",       # TAVV-style value (demo HMAC construction, §7.4)
  "atc": 41,                     # application transaction counter
  "unpredictableNumber": "A1B2C3D4",
  "amountMinor": 4999,
  "requestorId": "40010030001",
  "domainType": "ECOM"
}
```

Server-side pipeline (this ordering is deliberate — cheapest rejects first):
1. **Resolve** vault record for `tokenPan` — Hazelcast near-cache hit (hot) or read-through from Oracle (cold). *(The single biggest latency lever; §8.)*
2. **Status gate** — must be `ACTIVE`, else `TOKEN_NOT_ACTIVE`.
3. **Domain restriction** — `requestorId` and `domainType` must match the binding, else `DOMAIN_MISMATCH`. *(In baseline mode this is a remote call to token-controls-service; in optimized mode it's read from the same cached record — the removed round trip.)*
4. **ATC monotonicity** — `atc > last_atc`, else `REPLAY_SUSPECTED`; on success, check-and-set `last_atc` via a Hazelcast entry processor (atomic, write-behind to Oracle).
5. **Cryptogram validation** — recompute expected cryptogram via PKCS#11 (§7.4) over `(tokenPan, atc, un, amountMinor)`; constant-time compare, else `CRYPTOGRAM_INVALID`.
6. **Return funding PAN** (decrypted, §7.2) to the auth switch — held in memory only for the swap, never logged.

```
200 OK  { "fundingPan": "...", "fundingExpiry": "3012", "decision": "PROCEED" }
4xx     { "decision": "REJECT", "reason": "CRYPTOGRAM_INVALID" }
```

### 6.2 ISO 8583 field-level handling & issuer backward compatibility

The `auth-switch-simulator` uses **jPOS** with a demo `packager` (subset of ISO 8583:1987 data elements):

| DE | Field | Role in token flow |
|---|---|---|
| DE 2 | PAN | Carries the **token** on the way in; **swapped to funding PAN** on the way out to the issuer |
| DE 3 | Processing code | Purchase / auth |
| DE 4 | Amount | Bound into cryptogram validation |
| DE 11 | STAN | Trace |
| DE 39 | Response code | `00` approve / `05` decline relayed from issuer-sim |
| DE 55 | ICC / token cryptogram data (TLV) | **Cryptogram + ATC + UN** parsed here (TAVV-style) |
| DE 48 | Private use | Requestor ID / domain markers for token-aware issuers |

**Backward-compatibility logic (the résumé's "preserving backward compatibility across issuer processors"):** the switch consults `issuer_bin_map.token_aware`:
- **Token-unaware issuer** → switch fully detokenizes: replaces DE 2 with funding PAN, *strips* the token-specific DE 55 cryptogram TLV and DE 48 markers before forwarding, so the issuer sees a clean legacy `0100`. Response `0110` relayed unchanged.
- **Token-aware issuer** → switch may forward the token in DE 2 *plus* the cryptogram in DE 55 for the issuer to validate, per capability flags.

This flag-driven split is the concrete, demonstrable meaning of "field-level handling preserving backward compatibility." You can toggle an issuer's `token_aware` flag and show the two different outbound message shapes in the jPOS logs.


---

## 7. Cryptography & HSM (PKCS#11 / SoftHSM2)

### 7.1 Why an HSM at all

In a real TSP, two secrets never exist in application memory in the clear: the **key encryption key (KEK)** that protects data keys, and the **cryptogram/UMD keys** used to compute/verify transaction cryptograms. A **Hardware Security Module** holds them; the application calls the HSM to *use* keys without extracting them. The demo uses **SoftHSM2** (a software PKCS#11 token) accessed via Java's **SunPKCS11** provider — same JCA/PKCS#11 API surface as a real HSM, so the code and key-handling story are honest even though the "hardware" is emulated.

### 7.2 Envelope encryption for the funding PAN (data at rest)

```
                    ┌──────────────── SoftHSM2 (PKCS#11 token) ────────────────┐
                    │  KEK (AES-256)  — never leaves the HSM                    │
                    │    C_WrapKey / C_UnwrapKey                                │
                    └───────────────────────────────┬──────────────────────────┘
                                                     │ wrap/unwrap
   plaintext DEK (AES-256, generated per key_version)│
        │  used in-app for AES-256-GCM of funding PAN│
        ▼                                            ▼
   funding_pan_enc = IV || GCM(DEK, funding_pan)  wrapped_dek stored in key_registry
```

- Each `key_version` has a **DEK** (data encryption key). The DEK is generated once, immediately **wrapped by the HSM-resident KEK**, and only the wrapped form is stored (`key_registry.wrapped_dek`). At startup the service unwraps the active DEK into an in-memory `SecretKey` (or, in the stricter demo mode, performs all GCM inside the token).
- Funding PANs are encrypted with **AES-256-GCM** — authenticated encryption; the tag detects tampering. IV is random-96-bit per record, prepended to the ciphertext.
- `funding_pan_enc` layout: `IV(12) || ciphertext(16, PAN is 16 digits→packed) || tag(16)`.

### 7.3 Keyed fingerprint (searchable, non-reversible)

To find tokens by funding card (reissue) without storing a reversible PAN, `funding_pan_h = HMAC-SHA-256(fingerprint_key, funding_pan)`. HMAC (keyed) not bare SHA-256 — a bare hash of a 16-digit PAN is brute-forceable in seconds (only ~10^15 candidates, minus BIN/Luhn constraints ⇒ far fewer). The fingerprint key lives in the HSM/config, never with the data. This is a genuinely good interview detail: it shows you understand why "hash the PAN" is naive.

### 7.4 Transaction cryptogram (TAVV-style) — demo construction

Real EMV cryptograms (ARQC/TAVV) use issuer master keys, session-key derivation, and specific EMV algorithms. The demo uses a **documented, simplified stand-in** and *says so*:

```
cryptogram = HMAC-SHA-256( cryptogram_key_in_HSM,
                           tokenPan || ATC || UN || amountMinor )   [truncated to 8 bytes]
```
- The `cryptogram_key` is HSM-resident; validation recomputes and does a **constant-time compare**.
- **ATC** provides replay protection: monotonic per token, enforced in §6.1 step 4.
- **UN** (unpredictable number) binds freshness.
- Amount binding limits cryptogram reuse across amounts.

Interview framing: "I'm reproducing the *properties* — key isolation in the HSM, per-transaction freshness via ATC+UN, amount binding, replay rejection — not the exact EMVCo cryptographic construction, which is proprietary and issuer-key-dependent." That sentence is exactly the kind of scoping that survives scrutiny.

### 7.5 Key rotation

`key_registry.state` drives rotation: introduce a new `ACTIVE` DEK version; new writes use it; old versions move to `DECRYPT_ONLY` (still able to decrypt historical records via `key_version` on each row) and later `RETIRED` after a re-encrypt sweep. The KEK rotation is an HSM operation (re-wrap all DEKs) with no row re-encryption needed. Demo includes a `rotate-key` admin endpoint + a script that shows old records still decrypt via their stored `key_version`.

---

## 8. The Latency Story (the interview centerpiece)

This section is the heart of "p99 detokenization 38 ms → 22 ms." Treat every number below as something the demo *produces*, not asserts.

### 8.1 Decomposing the p99 budget

Baseline (`DIRECT` reads, `controls.inline=false`) — where the ~38 ms comes from, per request:

| Stage | Baseline cost (through Toxiproxy) | Note |
|---|---|---|
| Oracle vault read (JDBC round trip) | ~7–9 ms | 1 network RTT + query |
| token-controls-service call (status/domain) | ~7–9 ms | **synchronous second round trip** |
| Cryptogram validation (PKCS#11) | ~1–2 ms | in-process |
| ATC check-and-set (DB) | ~5–7 ms | another DB round trip in baseline |
| Serialization / framework overhead | ~2–3 ms | Jackson, Spring MVC |
| **Tail effects (GC pauses, connection-pool waits)** | adds to p99/p99.9 | §9 |

Two synchronous network round trips dominate the tail. That's the target.

### 8.2 The two independent optimizations (each behind a flag)

**Optimization A — Hazelcast near-cache eliminates the vault-read RTT for hot tokens.**
- `detok.cache.mode=NEAR_CACHE`: the detok service is a Hazelcast client with **near-cache** on `vault-records`. Hot tokens resolve from process-local memory (~sub-ms) instead of a JDBC round trip.
- Token access in payments is **highly skewed** (a small set of cards drives most volume), so a near-cache with modest capacity gets a high hit ratio — the demo's Gatling profile uses a Zipfian distribution to make this realistic (§11.2).
- Cache correctness: writes go **write-through** from the provisioning path (§5), and Hazelcast **near-cache invalidation** events purge stale local copies cluster-wide on any update. TTL 300 s bounds staleness for anything missed. This is why lifecycle changes still reflect in the auth path within milliseconds — the demo proves it in §8.4.

**Optimization B — inline the controls check, deleting the second round trip.**
- `detok.controls.inline=true`: status + domain restrictions are denormalized onto the vault record, so step 2–3 of §6.1 read the *same cached entry* instead of calling token-controls-service. One network hop disappears entirely.
- The ATC check-and-set also moves to a Hazelcast **entry processor** (atomic, in-cluster) with **write-behind** to Oracle, removing a third synchronous DB round trip from the hot path.

Result with both on (`NEAR_CACHE` + `inline`): the two-plus synchronous round trips collapse to at-most-one (only on cold miss), and the steady-state hot path is dominated by in-memory work + PKCS#11 → p99 lands near ~22 ms *including* cold-miss tail. The demo shows all four combinations so you can attribute the gain to each lever independently — that attribution is what a sharp interviewer will push on.

### 8.3 Why not just "cache everything and skip Oracle"?

Anticipating the pushback. (1) Oracle remains **source of truth** — cache is a read accelerator, not the record of funds mapping; a cache-only design loses durability and audit. (2) **Bounded staleness matters differently per field:** a token that was just *suspended for fraud* must stop authorizing fast — hence write-through + invalidation, not lazy TTL alone. (3) **Cold start / failover:** near-cache is empty after a deploy; read-through keeps correctness while it warms. The demo's kill-a-replica test (§10.4) shows the survivor serving correctly from a cold near-cache, then latency improving as it warms.

### 8.4 Consistency under lifecycle change — the demo that proves cache safety

Scripted sequence, run live:
1. Authorize with token T under sustained load → PROCEED, p99 ~22 ms.
2. `POST /v1/tokens/{T}/suspend`.
3. Next authorization with T → **REJECT / TOKEN_NOT_ACTIVE within milliseconds** (write-through + near-cache invalidation, not waiting for TTL).
4. `resume` → authorizations PROCEED again.

This directly rebuts the obvious objection "doesn't caching risk authorizing a suspended token?" — answer: no, because writes invalidate, and here's the running proof.

---

## 9. JVM / G1GC Tuning (p99.9 pause outliers −40%)

The detokenization JVMs are latency-critical; GC pauses show up directly in p99.9. The demo ships two flag sets and a load-driven comparison.

### 9.1 Baseline (naive) vs tuned

```
# Baseline: default-ish, generous but unfocused
-Xms2g -Xmx2g -XX:+UseG1GC

# Tuned for low pause on an allocation-heavy, mostly-short-lived-object workload
-Xms4g -Xmx4g                          # fixed heap = no resize pauses; headroom cuts GC frequency
-XX:+UseG1GC
-XX:MaxGCPauseMillis=15                 # pause-time goal aligned to the latency budget
-XX:G1HeapRegionSize=8m                 # right-sized regions for the object mix
-XX:InitiatingHeapOccupancyPercent=35   # start concurrent marking earlier → avoid mixed-GC spikes
-XX:G1ReservePercent=15                 # guard against to-space exhaustion (evacuation failure = big pause)
-XX:+ParallelRefProcEnabled             # reference processing off the critical pause
-XX:+AlwaysPreTouch                     # touch heap pages at startup → no first-hit page-fault jitter
-Xlog:gc*,safepoint:file=/var/log/gc-%p.log:t,uptime,level,tags
```

### 9.2 The reasoning (what an interviewer will probe)

- **The workload shape:** detokenization allocates lots of short-lived objects (request DTOs, Jackson buffers, byte arrays) with a small long-lived set (caches). That's the classic G1 sweet spot — most garbage dies young in the eden regions.
- **`MaxGCPauseMillis=15`:** you don't set the *actual* pause, you set a *goal* G1 sizes young-gen to meet. Aligning it with the ~15 ms sub-budget keeps individual pauses from eating the tail. Set it too low and G1 shrinks young gen → more frequent GCs → throughput loss; the demo shows that failure mode too.
- **`IHOP=35` + `G1ReservePercent=15`:** the worst G1 pauses are **evacuation failures** (to-space exhaustion) and late mixed collections. Starting concurrent marking earlier and reserving space prevents the "everything was fine then a 200 ms pause" p99.9 spike. This is *precisely* the p99.9 outlier the résumé claims to have cut.
- **`AlwaysPreTouch` + fixed `-Xms=-Xmx`:** removes two jitter sources — lazy page faults on first touch, and heap-resize pauses.

### 9.3 Measurement

Run the same Gatling profile against both flag sets; parse the GC logs (a small script summarizes pause count/max/p99.9) and overlay with the Grafana "GC pause" panel and the request-latency p99.9 panel. The claim is validated when tuned p99.9 pause-attributable latency drops ~40% vs baseline under identical load. Honest caveat to state aloud: exact numbers depend on the host; the *methodology and direction* are the transferable, defensible part.


---

## 10. Reliability, Messaging & Operations

### 10.1 Idempotency (provisioning)

Provisioning is a mutating, retriable operation — a client timeout must not create two tokens for one card. Pattern (mirrors Stripe/Visa public-API idempotency):
- Client sends `Idempotency-Key` header (UUID).
- Server stores `(idem_key, request_hash, response)` in `idempotency_keys`.
- On replay with the **same key + same request hash** → return the stored response, do nothing else.
- Same key + **different** request hash → `422` (client bug: key reuse with different body).
- Keys expire after 24 h (scheduled purge).

### 10.2 Transactional outbox → idempotent Kafka producer

**Problem:** if the service wrote to Oracle then published to Kafka as two separate steps, a crash between them loses or duplicates events (dual-write problem). **Solution:** the state-change transaction also inserts a row into `token_outbox` **atomically**. A poller reads unpublished rows and produces to Kafka with:
```
enable.idempotence=true      # broker dedupes producer retries (no dup on retry)
acks=all
max.in.flight.requests.per.connection=5   # safe with idempotence
key = token_ref              # per-token ordering (same partition)
```
On successful ack, `published_at` is stamped. **Consumer side** (`issuer-notification-sim`) additionally dedupes by `event_id` (idempotent consumer) so even at-least-once delivery yields exactly-once *effect*. This is the concrete meaning of "idempotent producers to prevent duplicate notifications." The demo can inject a producer retry and show no duplicate consumer-side notification.

### 10.3 Event schema

```json
{
  "eventId": "uuid",
  "eventType": "SUSPENDED",
  "tokenRef": "uuid",
  "tokenLast4": "4821",
  "requestorId": "40010030001",
  "occurredAt": "2026-01-15T10:32:00Z",
  "schemaVersion": 1
}
```
No PAN, no full token — events are safe for downstream risk/reporting/issuer-notification consumers. `schemaVersion` supports forward-compatible evolution.

### 10.4 Active-active & failover (demo + design)

**Demo (single host):** two `detokenization-service` replicas behind nginx; two Hazelcast members forming a cluster. Live test: drive load with Gatling, `docker kill` one detok replica → nginx sheds it, throughput continues, error rate returns to zero within seconds. `docker kill` one Hazelcast member → the IMap survives on the surviving member (backup count 1), reads continue. This is a runnable "failover runbook" beat.

**Production design (discussion):** true active-active across two datacenters means both DCs serve authorization simultaneously. Key considerations to raise: (1) the vault must be readable in both DCs → Oracle Data Guard / GoldenGate replication with a clear RPO; (2) ATC monotonicity across DCs needs a partition-affinity or per-DC ATC-window strategy to avoid cross-DC contention; (3) provisioning writes need a primary-region or conflict-resolution model; (4) quarterly DR drills validate the runbooks. State clearly that the demo shows *replica-level* HA and the *dual-DC* story is design-level — don't overclaim.

### 10.5 Regulated change management + cert harness (issuer onboarding)

- **Environment gating:** Spring profiles `dev | cert | prod`. `cert` mirrors prod config but points at simulators; a change must pass the cert suite before a `prod` profile build is allowed.
- **`cert-harness` module:** replays issuer certification suites defined in YAML (a sequence of provisioning + authorization scenarios with expected outcomes) end-to-end against the running stack, producing an HTML pass/fail report. This is the "automated cert-environment test harness that replayed issuer certification suites" and the mechanism behind "shortened onboarding six weeks → four": onboarding a new issuer becomes *fill in a YAML capability profile + run the harness* instead of manual round-trips.
- **Jenkinsfile stages:** `build → unit → integration → cert-suite → [manual approval gate] → package`. The manual approval + staged sign-off models Visa's dual-approval, scheduled-window release process.

---

## 11. Performance Testing (Gatling)

### 11.1 Why Gatling and why an open model

Gatling's Scala/Java DSL supports an **open workload model** (specify *arrival rate*, not number of looping users). Authorization traffic is open by nature — requests arrive at a rate independent of how fast the system responds. A closed model (fixed virtual users) hides latency problems because slow responses throttle the offered load (coordinated omission). Using `constantUsersPerSec` / `rampUsersPerSec` / `stressPeakUsers` gives honest tail latencies. Saying this in an interview signals you understand load-testing methodology, not just tooling.

### 11.2 Realistic access pattern

```java
// Zipfian token selection: a few "hot" tokens dominate, matching real card-usage skew.
// This is what makes the near-cache hit ratio realistic; a uniform feeder would
// understate the cache benefit and misrepresent the optimization.
Iterator<Map<String,Object>> feeder = zipfianTokenFeeder(tokenPool, /*exponent*/ 1.1);

ScenarioBuilder detok = scenario("detokenize-peak")
    .feed(feeder)
    .exec(http("detokenize")
        .post("/v1/detokenize")
        .body(StringBody(session -> buildDetokJson(session)))
        .check(status().is(200)));

setUp(
  detok.injectOpen(
     rampUsersPerSec(50).to(2000).during(Duration.ofMinutes(2)),  // ramp
     constantUsersPerSec(2000).during(Duration.ofMinutes(5)),      // sustained peak
     stressPeakUsers(6000).during(Duration.ofSeconds(30))          // holiday spike
  )
).protocols(httpProtocol)
 .assertions(
     global().responseTime().percentile4().lt(25),   // p99 < 25ms gate
     global().failedRequests().percent().lt(0.1)
 );
```

### 11.3 The Toxiproxy calibration (state this openly)

On a laptop, local Oracle answers in <1 ms, so the "before/after" gap would be invisible and the numbers meaningless. Toxiproxy injects a fixed ~6–8 ms latency toxic on the JDBC path and the controls-service path to represent realistic cross-rack/cross-zone RTT. **This calibration is disclosed as a demo assumption**, not hidden — the *shape* of the improvement (removing N synchronous round trips of ~7 ms each) is what transfers to production; the absolute milliseconds are host-dependent. A candidate who volunteers this is far more credible than one who presents laptop numbers as production truth.

### 11.4 What the demo reports

Four Gatling runs (the 2×2 of `cache.mode` × `controls.inline`) → four HTML reports + a summary table + Grafana screenshots showing p50/p95/p99/p99.9 for each. The narrative: each optimization removes ~one round trip; together they move p99 from ~38 ms into the low-20s; the near-cache hit ratio panel explains *why*; the GC panel explains the p99.9 behavior.

---

## 12. Configuration & Environments (Spring Cloud)

- **`config-server`** (Spring Cloud Config, native/file backend in the demo) serves per-profile config: DB URLs, Hazelcast members, Kafka brokers, feature flags, cert-vs-prod switches. This is "shared configuration and service-discovery modules on Spring Cloud, keeping settings consistent across dev, cert, and production zones."
- **Feature flags as config** (`detok.cache.mode`, `detok.controls.inline`, JVM flag-set selection via compose profiles) make every optimization toggleable at runtime for the A/B demo — which is *also* how you'd ship such a change safely in production (progressive rollout behind a flag).
- **Profiles:** `dev` (all local, no Toxiproxy), `cert` (Toxiproxy on, simulators, cert harness enabled), `prod-like` (Toxiproxy on, tuned JVM, two replicas, load-test target).

---

## 13. Observability

Every service exposes Micrometer metrics scraped by Prometheus; Grafana dashboards:

| Dashboard | Panels | Ties to claim |
|---|---|---|
| **Detokenization latency** | p50/p95/p99/p99.9 timers, RPS, error rate by reason | the 38→22 story |
| **Cache** | near-cache hit ratio, IMap size, invalidation rate, read-through miss rate | explains *why* latency dropped |
| **JVM/GC** | pause count, max pause, p99.9 pause, heap occupancy, allocation rate | the G1 −40% story |
| **Kafka** | producer send rate, consumer lag, outbox backlog | idempotent-events story |
| **Provisioning** | provision success %, ID&V decision mix, OTP completion rate | the 99.95% provisioning-success story |

Structured JSON logging with a **trace ID** propagated from the auth switch through detok → HSM → DB, so a single authorization can be followed end-to-end. **PII discipline:** a logging filter guarantees no full PAN/token ever reaches logs — only `tokenRef` and `last4`. Micrometer timers wrap each detok stage (`resolve`, `status`, `crypto`, `atc`) so the latency budget in §8.1 is *observable*, which is exactly how you'd do latency-regression RCA on-call.

---

## 14. Repository Layout & How to Run

```
payment-token-service/
├── docker-compose.yml            # oracle-free, kafka(kraft), hazelcast×2, softhsm2,
│                                 # toxiproxy, prometheus, grafana, all services
├── docker-compose.tuned.yml      # overlay: tuned JVM flags on detok services
├── config-server/
├── token-provisioning-service/   # §5, §7 (writes, ID&V, lifecycle, key mgmt)
├── detokenization-service/       # §6, §8 (the hot path; both cache modes)
├── token-controls-service/       # the "legacy hop" that gets inlined
├── auth-switch-simulator/        # §6.2 jPOS ISO 8583
├── issuer-simulator/             # ID&V + auth decisions
├── issuer-notification-sim/      # §10.2 idempotent consumer
├── cert-harness/                 # §10.5 issuer certification replay
├── loadtest/                     # §11 Gatling simulations + zipfian feeder
├── db/                           # §4 DDL, partitions, seed data, explain-plan script
├── ops/
│   ├── grafana-dashboards/       # §13 JSON dashboards
│   ├── gc-log-summarize.py       # §9 GC log parser
│   └── runbooks/                 # failover + latency-RCA runbooks
└── docs/
    └── DEMO_SCRIPT.md            # the exact click-through for the interview
```

**Golden-path demo (≈8 minutes), sequenced for an interview:**
1. `docker compose up` → wait for health checks; open Grafana.
2. Provision a token (ID&V APPROVE) → show `ACTIVE`, show Kafka `PROVISIONED` event.
3. Provision a risky card → ID&V STEP_UP → complete OTP → `ACTIVE`.
4. Send an ISO 8583 `0100` through the auth switch with a valid cryptogram → PROCEED; show DE 2 swap in jPOS logs.
5. Replay the same ATC → REPLAY_SUSPECTED. Tamper the cryptogram → CRYPTOGRAM_INVALID.
6. **Latency A/B:** run Gatling `DIRECT`+non-inline, then `NEAR_CACHE`+inline; show the two Grafana p99 curves side by side (~38 ms → ~22 ms).
7. **Cache safety:** under load, suspend the token → next auth REJECTs within ms → resume → PROCEEDs.
8. **Card reissue:** authorize token T; reissue the underlying card; authorize the *same* T → still approved against the new PAN.
9. **Failover:** `docker kill` a detok replica under load → throughput continues.
10. **GC:** re-run load with `docker-compose.tuned.yml` → show p99.9 pause panel improve.


---

## 15. Simplifications & Honest Limitations (read this before the interview)

Knowing exactly where the demo diverges from a real TSP — and what the production-grade equivalent is — is what turns "a project" into "an engineer who understands the domain." Volunteer these; don't wait to be caught.

| Area | Demo simplification | Real-world equivalent |
|---|---|---|
| Cryptogram | HMAC-SHA-256 stand-in (§7.4) | EMVCo TAVV/ARQC with issuer master keys, session-key derivation, EMV algorithms in a payShield-class HSM |
| HSM | SoftHSM2 via SunPKCS11 | Physical payment HSM (Thales/Futurex), key ceremonies, dual control, tamper response |
| Detokenization "swap" | App decrypts funding PAN and returns it | In-network, in-HSM operations; PAN never in general app memory; strict HSM command boundaries |
| Cross-DC | Two local replicas + design discussion | Oracle Data Guard/GoldenGate, RPO/RTO targets, cross-DC ATC strategy |
| Network latency | Toxiproxy fixed toxic (§11.3) | Real cross-rack/AZ RTT, TCP/TLS costs, connection pooling at scale |
| ID&V | Rule table + issuer-sim (§5.2) | Issuer risk platforms, device attestation, wallet SDK attest, 3-D Secure interplay |
| PCI scope | PII redaction + envelope encryption shown | Full PCI DSS: segmentation, CDE controls, QSA audit, key-management policy, access reviews |
| ISO 8583 | jPOS subset of DEs (§6.2) | Full network message spec, network-specific dialects, cert against real endpoints |
| Compliance/change mgmt | Profile gating + Jenkins stages | Regulated CAB, segregation of duties, audited approvals, change freeze windows |

**One-line summary to say aloud:** *"This is a faithful reference implementation of the concepts on publicly documented standards; every real cryptographic and infrastructure component is replaced by a clearly labeled stand-in, and I can walk you through exactly what would change to make each piece production-grade."*

---

## 16. Interview Q&A — anticipated deep-dive questions

Rehearse these; they are the questions a sharp payments/backend interviewer will actually ask.

**Q: Why not Redis instead of Hazelcast for the near-cache?**
Redis is a *remote* cache — every hit is still a network round trip (~the thing we're trying to remove). Hazelcast's **near-cache keeps hot entries in-process**, so hits are sub-millisecond with no hop, and it provides **cluster-wide invalidation** to keep those local copies coherent on writes. For a hot-path read where the whole point is deleting round trips, in-process caching is the right tool. (If we wanted a shared remote cache tier as well, Redis could sit *behind* the near-cache — but that's an addition, not a replacement.)

**Q: How do you guarantee a suspended/stolen token stops authorizing immediately, despite caching?**
Writes are **write-through** and trigger **near-cache invalidation** cluster-wide, so the next authorization re-reads the fresh record — demonstrated live in §8.4. TTL (300 s) is only a backstop for anything missed. We never rely on TTL alone for security-relevant state changes.

**Q: What happens on a cache miss or after a deploy (cold cache)?**
Read-through `MapLoader` fetches from Oracle (source of truth) and populates the cache; correctness is never sacrificed, only latency during warm-up. The failover demo shows a survivor serving correctly from a cold near-cache, latency improving as it warms.

**Q: The ATC check-and-set is now in the cache with write-behind — isn't that a durability risk (lost ATC on crash)?**
Trade-off acknowledged and bounded. The replay window is exactly the write-behind lag. Mitigations: short write-behind interval, ATC also validated against the DB value on cold read, and — crucially — the cryptogram itself binds ATC+UN+amount, so a replay must reuse a full cryptogram that also fails other checks. For a demo I favor the latency win; for production you'd tune write-behind aggressiveness or keep ATC synchronous with a dedicated fast store, and I can speak to that trade.

**Q: Why partition by token BIN and not, say, hash-partition by token PAN?**
Hash partitioning spreads writes evenly but destroys **partition pruning on range operations** and, more importantly, couples partition identity to a hash rather than to an *issuer/BIN*, which is the natural unit of operational isolation and lifecycle (an issuer offboards → drop its partitions). Since every detok query already carries the token PAN whose prefix is the BIN, range-by-BIN gives single-partition pruning *and* operational alignment. The cost is the global fingerprint index for cross-partition reissue lookups — an acceptable low-write-rate exception.

**Q: How is idempotency actually enforced end-to-end, not just at the API?**
Two layers. API layer: `Idempotency-Key` + stored response (§10.1) makes provisioning retry-safe. Event layer: transactional outbox + `enable.idempotence=true` producer + consumer dedupe by `eventId` (§10.2) makes notifications exactly-once in effect. The dual-write problem is solved by the outbox being in the *same transaction* as the state change.

**Q: Walk me through what an interviewer can't see — how do you know the p99 number is real and not cherry-picked?**
The demo runs all four flag combinations under an identical open-model Gatling profile with a Zipfian feeder, and every stage is independently timed via Micrometer (§8.1, §13). You can attribute each millisecond to a stage and each improvement to a specific removed round trip. The Toxiproxy calibration is disclosed. That's falsifiable, not cherry-picked.

**Q: What's the single biggest risk in this design if it were real?**
Cache/DB divergence on the security-relevant status field — a bug that lets a suspended token keep authorizing. That's why status changes are write-through + invalidate (not lazy), why the demo explicitly tests the suspend-under-load case, and why in production I'd add a periodic reconciliation sweep comparing cache vs DB status and alert on drift.

---

## 17. Mapping every résumé bullet to this document (checklist)

- Token provisioning & lifecycle APIs → §5.1, §5.4, §6.1 state machine
- ID&V approve/step-up/decline + OTP → §5.2, §5.3
- Card-reissue/expiry keeping tokens valid → §5.5 (with live demo beat)
- ISO 8583 field-level + backward compatibility → §6.2
- HSM-backed keys, vault encryption, rotation (PCI/key-rotation) → §7
- p99 38→22 ms via near-cache + removed round trip → §8, §11, §14 demo step 6
- G1 tuning, p99.9 −40% → §9
- Oracle vault partitioned by BIN, <5 ms p99 → §4.1
- Kafka lifecycle events, idempotent producers, no duplicates → §10.2
- Spring Cloud shared config/service discovery → §12
- Active-active dual-DC + failover runbooks → §10.4
- Gatling peak-profile load tests → §11
- Regulated change management → §10.5, Jenkinsfile
- Cert harness + issuer onboarding 6→4 weeks → §10.5
- On-call latency-regression RCA → §8.1 budget method + §13 per-stage timers + ops/runbooks

---

*End of technical design. This document is the specification to build the demo from; §14's `DEMO_SCRIPT.md` and §16's Q&A are what you rehearse for the interview itself.*
