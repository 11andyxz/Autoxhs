-- =====================================================================================
-- H2 rendering of the Oracle vault schema (see db/oracle/01_schema.sql for the real one).
--
-- Divergences from the Oracle DDL, all deliberate and documented in
-- docs/SIMPLIFICATIONS.md:
--   * no RANGE PARTITION BY (token_bin) -- H2 has no equivalent; the Oracle DDL keeps it
--     and db/oracle/03_explain_plan.sql proves partition pruning.
--   * VARCHAR2/RAW/NUMBER -> VARCHAR/VARBINARY/BIGINT|INTEGER.
--   * SYSTIMESTAMP -> CURRENT_TIMESTAMP.
-- Every statement is IF NOT EXISTS so several Spring contexts can share one in-memory
-- database during integration tests.
-- =====================================================================================

CREATE TABLE IF NOT EXISTS token_vault (
    token_pan        VARCHAR(19)    NOT NULL,
    token_ref        VARCHAR(36)    NOT NULL,
    token_bin        BIGINT         NOT NULL,
    funding_pan_enc  VARBINARY(120) NOT NULL,   -- IV(12) || AES-256-GCM ciphertext || tag(16)
    funding_pan_h    VARBINARY(32)  NOT NULL,   -- HMAC-SHA-256 keyed fingerprint
    funding_last4    CHAR(4)        NOT NULL,
    funding_expiry   CHAR(4)        NOT NULL,   -- YYMM
    token_expiry     CHAR(4)        NOT NULL,   -- YYMM
    status           VARCHAR(12)    NOT NULL,   -- PENDING_IDV | ACTIVE | SUSPENDED | DELETED
    requestor_id     VARCHAR(11)    NOT NULL,
    domain_type      VARCHAR(12)    NOT NULL,   -- CONTACTLESS | ECOM
    issuer_id        VARCHAR(8)     NOT NULL,
    device_id        VARCHAR(64),
    last_atc         INTEGER        DEFAULT 0 NOT NULL,
    key_version      INTEGER        NOT NULL,
    created_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_token_vault PRIMARY KEY (token_pan)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_vault_token_ref   ON token_vault (token_ref);
CREATE INDEX        IF NOT EXISTS gx_vault_funding_h   ON token_vault (funding_pan_h);

CREATE TABLE IF NOT EXISTS token_outbox (
    event_id     VARCHAR(36)  NOT NULL,
    token_ref    VARCHAR(36)  NOT NULL,
    event_type   VARCHAR(20)  NOT NULL,
    payload      CLOB         NOT NULL,
    created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP NOT NULL,
    published_at TIMESTAMP,
    CONSTRAINT pk_token_outbox PRIMARY KEY (event_id)
);

CREATE INDEX IF NOT EXISTS ix_outbox_pending ON token_outbox (published_at, created_at);

CREATE TABLE IF NOT EXISTS idv_sessions (
    session_id   VARCHAR(36)   NOT NULL,
    token_ref    VARCHAR(36)   NOT NULL,
    otp_hash     VARBINARY(32) NOT NULL,
    attempts     INTEGER       DEFAULT 0 NOT NULL,
    expires_at   TIMESTAMP     NOT NULL,
    CONSTRAINT pk_idv_sessions PRIMARY KEY (session_id)
);

CREATE TABLE IF NOT EXISTS issuer_bin_map (
    token_bin_start BIGINT      NOT NULL,
    token_bin_end   BIGINT      NOT NULL,
    issuer_id       VARCHAR(8)  NOT NULL,
    token_aware     CHAR(1)     DEFAULT 'N' NOT NULL,
    CONSTRAINT pk_issuer_bin_map PRIMARY KEY (token_bin_start)
);

CREATE TABLE IF NOT EXISTS funding_bin_map (
    funding_bin_start BIGINT     NOT NULL,
    funding_bin_end   BIGINT     NOT NULL,
    issuer_id         VARCHAR(8) NOT NULL,
    blocked           CHAR(1)    DEFAULT 'N' NOT NULL,
    CONSTRAINT pk_funding_bin_map PRIMARY KEY (funding_bin_start)
);

CREATE TABLE IF NOT EXISTS key_registry (
    key_version  INTEGER       NOT NULL,
    wrapped_dek  VARBINARY(64) NOT NULL,
    state        VARCHAR(12)   NOT NULL,   -- ACTIVE | DECRYPT_ONLY | RETIRED
    created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_key_registry PRIMARY KEY (key_version)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    idem_key     VARCHAR(64)   NOT NULL,
    request_hash VARBINARY(32) NOT NULL,
    response     CLOB,
    created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_idempotency_keys PRIMARY KEY (idem_key)
);

-- Consumer-side dedupe store: makes at-least-once delivery exactly-once in effect (SS10.2).
CREATE TABLE IF NOT EXISTS notification_dedupe (
    event_id    VARCHAR(36) NOT NULL,
    event_type  VARCHAR(20) NOT NULL,
    token_ref   VARCHAR(36) NOT NULL,
    received_at TIMESTAMP   DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_notification_dedupe PRIMARY KEY (event_id)
);
