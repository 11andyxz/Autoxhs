-- =====================================================================================
-- Proof that the partitioning actually prunes (S4.1, claim 8).
--
-- "Partitioned by token BIN so lookups touch one partition" is an assertion until the
-- optimiser agrees. Run this against the Oracle stack and read the PSTART/PSTOP columns:
--
--   * hot-path lookup by token_pan  -> PSTART = PSTOP = a single partition number
--   * reissue lookup by fingerprint -> PSTART = 1, PSTOP = N (all partitions)
--
-- The second result is not a defect. It is the documented, deliberate trade: reissue spans
-- partitions and therefore rides a GLOBAL index, paid for by it being low-rate write-side
-- traffic rather than authorization traffic.
--
--   docker compose exec oracle sqlplus pts/pts@FREEPDB1 @/db/oracle/03_explain_plan.sql
-- =====================================================================================

SET LINESIZE 200
SET PAGESIZE 100

PROMPT
PROMPT ============================================================================
PROMPT 1. THE HOT PATH: detokenization looks up a token by its PAN.
PROMPT    Expect single-partition access -- PSTART equal to PSTOP.
PROMPT ============================================================================

EXPLAIN PLAN SET STATEMENT_ID = 'detok_hot_path' FOR
SELECT token_pan, token_ref, funding_pan_enc, status, requestor_id, domain_type, key_version
  FROM token_vault
 WHERE token_pan = '4999600000004822';

SELECT operation, options, object_name, partition_start AS pstart, partition_stop AS pstop
  FROM plan_table
 WHERE statement_id = 'detok_hot_path'
 ORDER BY id;

PROMPT
PROMPT ============================================================================
PROMPT 2. Same lookup with the partition key stated explicitly.
PROMPT    This is what the pruning above is equivalent to.
PROMPT ============================================================================

EXPLAIN PLAN SET STATEMENT_ID = 'detok_explicit_bin' FOR
SELECT token_pan, status
  FROM token_vault
 WHERE token_bin = 49996000
   AND token_pan = '4999600000004822';

SELECT operation, options, object_name, partition_start AS pstart, partition_stop AS pstop
  FROM plan_table
 WHERE statement_id = 'detok_explicit_bin'
 ORDER BY id;

PROMPT
PROMPT ============================================================================
PROMPT 3. THE REISSUE PATH: find every token for one funding card.
PROMPT    Expect ALL partitions and the GLOBAL index -- the documented exception.
PROMPT ============================================================================

EXPLAIN PLAN SET STATEMENT_ID = 'reissue_lookup' FOR
SELECT token_pan, token_ref
  FROM token_vault
 WHERE funding_pan_h = HEXTORAW('00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF')
   AND status <> 'DELETED';

SELECT operation, options, object_name, partition_start AS pstart, partition_stop AS pstop
  FROM plan_table
 WHERE statement_id = 'reissue_lookup'
 ORDER BY id;

PROMPT
PROMPT ============================================================================
PROMPT 4. Row distribution across partitions, so pruning is visibly worth something.
PROMPT    A single populated partition would make the whole scheme decorative.
PROMPT ============================================================================

SELECT partition_name, num_rows
  FROM user_tab_partitions
 WHERE table_name = 'TOKEN_VAULT'
 ORDER BY partition_position;

PROMPT
PROMPT If num_rows is empty, gather statistics first:
PROMPT   EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'TOKEN_VAULT');
PROMPT
PROMPT And note the catch-all: rows in P_MAX mean a token was issued outside every configured
PROMPT issuer BIN block, which is a provisioning bug worth alerting on rather than absorbing.

SELECT COUNT(*) AS rows_in_catch_all_partition
  FROM token_vault PARTITION (p_max);
