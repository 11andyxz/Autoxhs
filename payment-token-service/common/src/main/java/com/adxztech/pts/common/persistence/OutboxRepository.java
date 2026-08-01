package com.adxztech.pts.common.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;

/**
 * The transactional outbox (S10.2).
 *
 * <p><b>The problem this solves.</b> Writing to the database and then publishing to Kafka as two
 * separate steps is the dual-write problem: a crash between them either loses the event (state
 * changed, nobody was told) or duplicates it (retry after an unacknowledged send). No amount of
 * retry logic fixes it, because the two systems have no shared transaction.
 *
 * <p><b>The fix.</b> The state-change transaction also inserts the event here, atomically. A poller
 * then publishes unpublished rows and stamps {@code published_at}. Crash anywhere and the event is
 * either not yet visible or still pending -- never lost. Duplicates are still possible (crash between
 * broker ack and the stamp), which is exactly why the producer is idempotent and the consumer dedupes
 * by {@code eventId}.
 */
public class OutboxRepository {

    /** One outbox row. {@code publishedAt == null} means still pending. */
    public record OutboxRow(String eventId, String tokenRef, String eventType, String payload,
                            Instant createdAt, Instant publishedAt) {
        public boolean pending() {
            return publishedAt == null;
        }
    }

    private static final RowMapper<OutboxRow> MAPPER = (rs, n) -> new OutboxRow(
            rs.getString("event_id"),
            rs.getString("token_ref"),
            rs.getString("event_type"),
            rs.getString("payload"),
            rs.getTimestamp("created_at") == null ? null : rs.getTimestamp("created_at").toInstant(),
            rs.getTimestamp("published_at") == null ? null : rs.getTimestamp("published_at").toInstant());

    private final JdbcTemplate jdbc;

    public OutboxRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Must be called inside the same transaction as the state change it describes. */
    public void insert(String eventId, String tokenRef, String eventType, String payload) {
        jdbc.update("""
                INSERT INTO token_outbox (event_id, token_ref, event_type, payload, created_at)
                VALUES (?,?,?,?,?)
                """, eventId, tokenRef, eventType, payload, Timestamp.from(Instant.now()));
    }

    /**
     * @param limit batch size; inlined rather than bound because {@code FETCH FIRST ?} support varies
     *              across the two databases this must run on
     */
    public List<OutboxRow> fetchPending(int limit) {
        int safeLimit = Math.max(1, Math.min(limit, 1000));
        return jdbc.query("""
                SELECT event_id, token_ref, event_type, payload, created_at, published_at
                  FROM token_outbox
                 WHERE published_at IS NULL
                 ORDER BY created_at, event_id
                 FETCH FIRST %d ROWS ONLY
                """.formatted(safeLimit), MAPPER);
    }

    public int markPublished(String eventId) {
        return jdbc.update("UPDATE token_outbox SET published_at = ? WHERE event_id = ?",
                Timestamp.from(Instant.now()), eventId);
    }

    public long countPending() {
        Long n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM token_outbox WHERE published_at IS NULL", Long.class);
        return n == null ? 0 : n;
    }

    public List<OutboxRow> findByTokenRef(String tokenRef) {
        return jdbc.query("""
                SELECT event_id, token_ref, event_type, payload, created_at, published_at
                  FROM token_outbox WHERE token_ref = ? ORDER BY created_at, event_id
                """, MAPPER, tokenRef);
    }
}
