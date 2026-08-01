-- =====================================================================================
-- Reference data for the Oracle stack (S4.2).
--
-- The services also seed these tables from configuration at start-up (BinProperties), which
-- is what makes issuer onboarding a config change rather than a migration. This script exists
-- so the Oracle container comes up already populated, and so the intended contents are
-- reviewable in SQL next to the DDL.
--
-- Idempotent: MERGE, so re-running it is harmless.
-- =====================================================================================

-- Token BIN blocks. Each range maps 1:1 onto a partition in 01_schema.sql, and token_aware
-- decides the outbound ISO 8583 message shape (S6.2).
MERGE INTO issuer_bin_map t
USING (SELECT 49996000 AS s, 49996100 AS e, 'ISSA' AS i, 'N' AS a FROM dual
       UNION ALL SELECT 49996100, 49996200, 'ISSB', 'Y' FROM dual   -- token-aware issuer
       UNION ALL SELECT 49996200, 49996300, 'ISSC', 'N' FROM dual) s
ON (t.token_bin_start = s.s)
WHEN MATCHED THEN UPDATE SET t.token_bin_end = s.e, t.issuer_id = s.i, t.token_aware = s.a
WHEN NOT MATCHED THEN
    INSERT (token_bin_start, token_bin_end, issuer_id, token_aware) VALUES (s.s, s.e, s.i, s.a);

-- Funding card BIN blocks, used to resolve the issuer of a card being provisioned.
MERGE INTO funding_bin_map t
USING (SELECT 41111000 AS s, 41112000 AS e, 'ISSA' AS i, 'N' AS b FROM dual
       UNION ALL SELECT 42222000, 42223000, 'ISSB', 'N' FROM dual
       UNION ALL SELECT 43333000, 43334000, 'ISSX', 'Y' FROM dual) s  -- demo blocklist
ON (t.funding_bin_start = s.s)
WHEN MATCHED THEN UPDATE SET t.funding_bin_end = s.e, t.issuer_id = s.i, t.blocked = s.b
WHEN NOT MATCHED THEN
    INSERT (funding_bin_start, funding_bin_end, issuer_id, blocked) VALUES (s.s, s.e, s.i, s.b);

COMMIT;

-- NOTE: key_registry is deliberately NOT seeded here.
--
-- A DEK must be generated and wrapped by the HSM, so only the provisioning service can create
-- one (JdbcDekRegistry.bootstrap() at start-up). Seeding a key from SQL would mean the key
-- material existed outside the HSM at some point, which is exactly the property envelope
-- encryption exists to prevent.

PROMPT Seeded issuer_bin_map and funding_bin_map.
PROMPT key_registry is populated by the provisioning service at start-up, via the HSM.
