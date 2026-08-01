package com.adxztech.pts.common.persistence;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * {@code idempotency_keys}: stored request hash and response for provisioning retries (S10.1).
 *
 * <p>Provisioning is mutating and retriable, so a client timeout must not create two tokens for one
 * card. Storing the response -- not just the key -- means the retry gets the <em>same</em> answer,
 * including the same {@code tokenRef}, which is what makes the operation genuinely idempotent rather
 * than merely deduplicated.
 */
public class IdempotencyRepository {

    public record IdemRow(String key, byte[] requestHash, String response, Instant createdAt) {
    }

    private static final RowMapper<IdemRow> MAPPER = (rs, n) -> new IdemRow(
            rs.getString("idem_key"),
            rs.getBytes("request_hash"),
            rs.getString("response"),
            rs.getTimestamp("created_at") == null ? null : rs.getTimestamp("created_at").toInstant());

    private final JdbcTemplate jdbc;

    public IdempotencyRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<IdemRow> find(String key) {
        List<IdemRow> rows = jdbc.query("""
                SELECT idem_key, request_hash, response, created_at
                  FROM idempotency_keys WHERE idem_key = ?
                """, MAPPER, key);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /**
     * Claims a key before doing the work, so two concurrent retries cannot both provision.
     *
     * @return false when the key was already claimed by another in-flight request
     */
    public boolean tryClaim(String key, byte[] requestHash) {
        try {
            jdbc.update("""
                    INSERT INTO idempotency_keys (idem_key, request_hash, response, created_at)
                    VALUES (?,?,NULL,?)
                    """, key, requestHash, Timestamp.from(Instant.now()));
            return true;
        } catch (DuplicateKeyException e) {
            return false;
        }
    }

    public int storeResponse(String key, String response) {
        return jdbc.update("UPDATE idempotency_keys SET response = ? WHERE idem_key = ?",
                response, key);
    }

    /** Releases a claim when the request failed, so a genuine retry is not blocked forever. */
    public int release(String key) {
        return jdbc.update("DELETE FROM idempotency_keys WHERE idem_key = ? AND response IS NULL", key);
    }

    /** Keys expire after 24h (S10.1). */
    public int deleteOlderThan(Instant cutoff) {
        return jdbc.update("DELETE FROM idempotency_keys WHERE created_at < ?", Timestamp.from(cutoff));
    }
}
