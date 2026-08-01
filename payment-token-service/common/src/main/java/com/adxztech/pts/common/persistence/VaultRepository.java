package com.adxztech.pts.common.persistence;

import com.adxztech.pts.common.sim.LatencyInjector;
import com.adxztech.pts.common.token.DomainType;
import com.adxztech.pts.common.token.TokenStatus;
import com.adxztech.pts.common.vault.VaultRecord;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * All {@code token_vault} SQL, in one class (S4.1).
 *
 * <p>Two things are deliberate here.
 *
 * <p><b>Portable SQL.</b> No {@code SYSTIMESTAMP}, no {@code dual}, no {@code MERGE}, no vendor
 * paging syntax. The same statements run against Oracle (production, partitioned) and H2 (tests,
 * un-partitioned). That keeps the tested code path and the production code path the same code path,
 * which is the only way an H2-backed test suite is worth anything.
 *
 * <p><b>Every read goes through {@link LatencyInjector}.</b> Each call here is one network round trip
 * in production. Attributing that cost explicitly is what makes the latency budget in S8.1
 * reproducible on a laptop, and it is disclosed rather than hidden (S11.3).
 *
 * <p>Lookups by {@code token_pan} prune to a single Oracle partition because the leading digits of
 * the token PAN <em>are</em> the {@code token_bin} partition key. {@code findByFundingFingerprint}
 * is the deliberate exception: reissue spans partitions, so it rides the global index.
 */
public class VaultRepository {

    private static final String COLUMNS = """
            token_pan, token_ref, token_bin, funding_pan_enc, funding_pan_h, funding_last4,
            funding_expiry, token_expiry, status, requestor_id, domain_type, issuer_id, device_id,
            last_atc, key_version, created_at, updated_at
            """;

    private final JdbcTemplate jdbc;
    private final LatencyInjector latency;

    public VaultRepository(JdbcTemplate jdbc, LatencyInjector latency) {
        this.jdbc = jdbc;
        this.latency = latency;
    }

    private static final RowMapper<VaultRecord> MAPPER = (ResultSet rs, int n) -> new VaultRecord(
            rs.getString("token_pan"),
            rs.getString("token_ref"),
            rs.getLong("token_bin"),
            rs.getBytes("funding_pan_enc"),
            rs.getBytes("funding_pan_h"),
            rs.getString("funding_last4"),
            rs.getString("funding_expiry"),
            rs.getString("token_expiry"),
            TokenStatus.valueOf(rs.getString("status")),
            rs.getString("requestor_id"),
            DomainType.valueOf(rs.getString("domain_type")),
            rs.getString("issuer_id"),
            rs.getString("device_id"),
            rs.getInt("last_atc"),
            rs.getInt("key_version"),
            toInstant(rs.getTimestamp("created_at")),
            toInstant(rs.getTimestamp("updated_at")));

    private static Instant toInstant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }

    /** The hot-path read: single-partition, primary-key probe (S4.1, S6.1 step 1). */
    public Optional<VaultRecord> findByTokenPan(String tokenPan) {
        latency.hop();
        List<VaultRecord> rows = jdbc.query(
                "SELECT " + COLUMNS + " FROM token_vault WHERE token_pan = ?", MAPPER, tokenPan);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public Optional<VaultRecord> findByTokenRef(String tokenRef) {
        latency.hop();
        List<VaultRecord> rows = jdbc.query(
                "SELECT " + COLUMNS + " FROM token_vault WHERE token_ref = ?", MAPPER, tokenRef);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /**
     * "Find every token for this funding card" -- the reissue lookup (S5.5).
     *
     * <p>This is the query that forces the fingerprint index to be GLOBAL: one funding card can have
     * tokens in several token-BIN partitions. Acceptable because reissue is low-frequency write-side
     * traffic, unlike the hot path above.
     */
    public List<VaultRecord> findByFundingFingerprint(byte[] fingerprint) {
        latency.hop();
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM token_vault WHERE funding_pan_h = ? AND status <> 'DELETED'",
                MAPPER, fingerprint);
    }

    public void insert(VaultRecord r) {
        jdbc.update("""
                        INSERT INTO token_vault (
                            token_pan, token_ref, token_bin, funding_pan_enc, funding_pan_h,
                            funding_last4, funding_expiry, token_expiry, status, requestor_id,
                            domain_type, issuer_id, device_id, last_atc, key_version,
                            created_at, updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                r.tokenPan(), r.tokenRef(), r.tokenBin(), r.fundingPanEnc(), r.fundingPanFingerprint(),
                r.fundingLast4(), r.fundingExpiry(), r.tokenExpiry(), r.status().name(), r.requestorId(),
                r.domainType().name(), r.issuerId(), r.deviceId(), r.lastAtc(), r.keyVersion(),
                Timestamp.from(r.createdAt()), Timestamp.from(r.updatedAt()));
    }

    /** @return rows updated; 0 means the token vanished under us (caller maps to 404). */
    public int updateStatus(String tokenRef, TokenStatus status, Instant now) {
        return jdbc.update(
                "UPDATE token_vault SET status = ?, updated_at = ? WHERE token_ref = ?",
                status.name(), Timestamp.from(now), tokenRef);
    }

    /** Re-points a token at a new funding card while keeping the token PAN (S5.5). */
    public int updateFunding(String tokenPan, byte[] fundingPanEnc, byte[] fingerprint,
                             String last4, String expiry, int keyVersion, Instant now) {
        return jdbc.update("""
                        UPDATE token_vault
                           SET funding_pan_enc = ?, funding_pan_h = ?, funding_last4 = ?,
                               funding_expiry = ?, key_version = ?, updated_at = ?
                         WHERE token_pan = ?
                        """,
                fundingPanEnc, fingerprint, last4, expiry, keyVersion, Timestamp.from(now), tokenPan);
    }

    /**
     * Atomic ATC advance in the database -- the baseline (non-cached) replay guard (S6.1 step 4).
     *
     * <p>The {@code AND last_atc < ?} predicate is what makes this safe under concurrency: two
     * simultaneous authorizations with the same ATC cannot both update, so exactly one wins and the
     * other is rejected as a replay. A read-then-write would race.
     *
     * @return true when the ATC advanced (accept), false when it did not (replay)
     */
    public boolean compareAndAdvanceAtc(String tokenPan, int newAtc) {
        latency.hop();
        int updated = jdbc.update(
                "UPDATE token_vault SET last_atc = ? WHERE token_pan = ? AND last_atc < ?",
                newAtc, tokenPan, newAtc);
        return updated == 1;
    }

    /** Unconditional write used by the Hazelcast write-behind MapStore (S8.2). */
    public int writeLastAtc(String tokenPan, int atc) {
        return jdbc.update(
                "UPDATE token_vault SET last_atc = ? WHERE token_pan = ? AND last_atc < ?",
                atc, tokenPan, atc);
    }

    public Optional<Integer> findLastAtc(String tokenPan) {
        latency.hop();
        List<Integer> rows = jdbc.queryForList(
                "SELECT last_atc FROM token_vault WHERE token_pan = ?", Integer.class, tokenPan);
        return rows.isEmpty() ? Optional.empty() : Optional.ofNullable(rows.get(0));
    }

    /** Used by the key-rotation re-encrypt sweep and the cache/DB reconciliation job. */
    public List<VaultRecord> findByKeyVersion(int keyVersion) {
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM token_vault WHERE key_version = ?", MAPPER, keyVersion);
    }

    public List<VaultRecord> findAll() {
        return jdbc.query("SELECT " + COLUMNS + " FROM token_vault", MAPPER);
    }

    public long count() {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM token_vault", Long.class);
        return n == null ? 0 : n;
    }
}
