-- =====================================================================================
-- The real vault schema (S4.1): Oracle, range-partitioned by token BIN.
--
-- WHY PARTITION BY TOKEN BIN RANGE
--
-- 1. Pruning. Every detokenization query carries the token PAN, and the leading 8 digits
--    of a token PAN ARE the token_bin partition key. So the hot-path lookup touches
--    exactly one partition's index segment rather than a global structure. That is what
--    the "storage lookups under 5 ms p99" claim rests on, and 03_explain_plan.sql proves
--    the pruning actually happens rather than assuming it.
--
-- 2. Operational isolation. A token BIN block belongs to one issuer, so an issuer's data
--    can be compressed, moved or purged without touching anyone else's. An issuer
--    offboarding becomes DROP PARTITION.
--
-- 3. Predictable growth. A new issuer gets a new BIN block and therefore a new partition.
--    No reshuffling of existing data, which is not true of hash partitioning.
--
-- THE TRADE-OFF, STATED
-- The funding-PAN fingerprint index must be GLOBAL, because "find every token for this
-- card" spans partitions: one cardholder can hold tokens in several issuers' blocks. A
-- global index costs more to maintain on write. That is acceptable here precisely because
-- reissue is low-frequency write-side traffic, while the partition-local path serves the
-- high-volume authorization reads. Choosing per-index rather than globally is the point.
--
-- H2 equivalent (no partitioning): common/src/main/resources/db/h2/schema.sql
-- =====================================================================================

CREATE TABLE token_vault (
    token_pan        VARCHAR2(19)  NOT NULL,     -- the network token (DPAN), Luhn-valid
    token_ref        VARCHAR2(36)  NOT NULL,     -- opaque UUID used in APIs and events, never the PAN
    token_bin        NUMBER(8)     NOT NULL,     -- leading 8 digits: the partitioning key
    funding_pan_enc  RAW(120)      NOT NULL,     -- IV(12) || AES-256-GCM ciphertext || tag(16)
    funding_pan_h    RAW(32)       NOT NULL,     -- HMAC-SHA-256 keyed fingerprint (S7.3)
    funding_last4    CHAR(4)       NOT NULL,
    funding_expiry   CHAR(4)       NOT NULL,     -- YYMM
    token_expiry     CHAR(4)       NOT NULL,     -- YYMM; outlives the funding card (S5.5)
    status           VARCHAR2(12)  NOT NULL,     -- PENDING_IDV | ACTIVE | SUSPENDED | DELETED
    requestor_id     VARCHAR2(11)  NOT NULL,     -- token requestor (TRID-style)
    domain_type      VARCHAR2(12)  NOT NULL,     -- CONTACTLESS | ECOM
    issuer_id        VARCHAR2(8)   NOT NULL,
    device_id        VARCHAR2(64),               -- present => DPAN semantics
    last_atc         NUMBER(5)     DEFAULT 0 NOT NULL,
    key_version      NUMBER(3)     NOT NULL,     -- DEK version used for funding_pan_enc (S7.5)
    created_at       TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at       TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_token_vault PRIMARY KEY (token_pan),
    CONSTRAINT ck_vault_status CHECK (status IN ('PENDING_IDV','ACTIVE','SUSPENDED','DELETED')),
    CONSTRAINT ck_vault_domain CHECK (domain_type IN ('CONTACTLESS','ECOM'))
)
PARTITION BY RANGE (token_bin) (
    PARTITION p_bin_49996000 VALUES LESS THAN (49996100),   -- issuer ISSA
    PARTITION p_bin_49996100 VALUES LESS THAN (49996200),   -- issuer ISSB (token-aware)
    PARTITION p_bin_49996200 VALUES LESS THAN (49996300),   -- issuer ISSC
    PARTITION p_max          VALUES LESS THAN (MAXVALUE)    -- catch-all; alerts if it ever fills
);

-- The token_ref uniqueness index is LOCAL: lifecycle operations address a single token, and the
-- partition is derivable, so there is no reason to pay for a global structure.
CREATE UNIQUE INDEX ux_vault_token_ref ON token_vault (token_ref, token_bin) LOCAL;

-- The reissue lookup spans partitions, so this one has to be GLOBAL. See the header note: this is a
-- deliberate, bounded exception justified by reissue being low-rate write-side traffic.
CREATE INDEX gx_vault_funding_h ON token_vault (funding_pan_h) GLOBAL;

COMMENT ON TABLE token_vault IS
    'Network token to funding PAN mapping. Source of truth; the Hazelcast cache is only an accelerator.';
COMMENT ON COLUMN token_vault.funding_pan_enc IS
    'AES-256-GCM under the key_version DEK, with the token PAN as AAD so ciphertext is not portable between rows.';
COMMENT ON COLUMN token_vault.last_atc IS
    'Replay guard. Advanced either by a conditional UPDATE or by Hazelcast write-behind (S8.2).';

-- ------------------------------------------------------------------ supporting tables

CREATE TABLE token_outbox (
    event_id     VARCHAR2(36) NOT NULL,
    token_ref    VARCHAR2(36) NOT NULL,   -- also the Kafka key: gives per-token ordering
    event_type   VARCHAR2(20) NOT NULL,
    payload      CLOB         NOT NULL,
    created_at   TIMESTAMP    DEFAULT SYSTIMESTAMP NOT NULL,
    published_at TIMESTAMP,               -- NULL = pending
    CONSTRAINT pk_token_outbox PRIMARY KEY (event_id)
);

-- The poller only ever reads pending rows, so index for that access path specifically.
CREATE INDEX ix_outbox_pending ON token_outbox (published_at, created_at);

CREATE TABLE idv_sessions (
    session_id   VARCHAR2(36) NOT NULL,
    token_ref    VARCHAR2(36) NOT NULL,
    otp_hash     RAW(32)      NOT NULL,   -- SHA-256(sessionId || ':' || otp); never the code itself
    attempts     NUMBER(1)    DEFAULT 0 NOT NULL,
    expires_at   TIMESTAMP    NOT NULL,
    CONSTRAINT pk_idv_sessions PRIMARY KEY (session_id)
);

CREATE TABLE issuer_bin_map (
    token_bin_start NUMBER(8)   NOT NULL,
    token_bin_end   NUMBER(8)   NOT NULL,
    issuer_id       VARCHAR2(8) NOT NULL,
    token_aware     CHAR(1)     DEFAULT 'N' NOT NULL,  -- drives the S6.2 ISO 8583 split
    CONSTRAINT pk_issuer_bin_map PRIMARY KEY (token_bin_start),
    CONSTRAINT ck_issuer_token_aware CHECK (token_aware IN ('Y','N'))
);

CREATE TABLE funding_bin_map (
    funding_bin_start NUMBER(8)   NOT NULL,
    funding_bin_end   NUMBER(8)   NOT NULL,
    issuer_id         VARCHAR2(8) NOT NULL,
    blocked           CHAR(1)     DEFAULT 'N' NOT NULL,  -- ID&V local blocklist (S5.2)
    CONSTRAINT pk_funding_bin_map PRIMARY KEY (funding_bin_start),
    CONSTRAINT ck_funding_blocked CHECK (blocked IN ('Y','N'))
);

CREATE TABLE key_registry (
    key_version  NUMBER(3)    NOT NULL,
    wrapped_dek  RAW(64)      NOT NULL,   -- wrapped under the HSM-resident KEK; never the raw key
    state        VARCHAR2(12) NOT NULL,   -- ACTIVE | DECRYPT_ONLY | RETIRED
    created_at   TIMESTAMP    DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_key_registry PRIMARY KEY (key_version),
    CONSTRAINT ck_key_state CHECK (state IN ('ACTIVE','DECRYPT_ONLY','RETIRED'))
);

COMMENT ON TABLE key_registry IS
    'Wrapped DEKs only. Useless without the HSM-held KEK, which is the point of envelope encryption.';

CREATE TABLE idempotency_keys (
    idem_key     VARCHAR2(64) NOT NULL,
    request_hash RAW(32)      NOT NULL,   -- same key + different body => 422, not a second token
    response     CLOB,                    -- NULL while in flight; a retry then gets 409
    created_at   TIMESTAMP    DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_idempotency_keys PRIMARY KEY (idem_key)
);

CREATE TABLE notification_dedupe (
    event_id    VARCHAR2(36) NOT NULL,
    event_type  VARCHAR2(20) NOT NULL,
    token_ref   VARCHAR2(36) NOT NULL,
    received_at TIMESTAMP    DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT pk_notification_dedupe PRIMARY KEY (event_id)
);

COMMENT ON TABLE notification_dedupe IS
    'Consumer-side dedupe. Durable rather than in-memory, so a consumer restart cannot re-notify.';
