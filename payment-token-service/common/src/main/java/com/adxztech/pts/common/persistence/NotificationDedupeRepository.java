package com.adxztech.pts.common.persistence;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Consumer-side dedupe store (S10.2).
 *
 * <p>The producer is idempotent, which stops the broker from duplicating <em>retries</em>. It cannot
 * stop a duplicate that originates upstream -- a crash between the broker ack and the outbox stamp
 * means the poller republishes on restart. Deduping on {@code eventId} at the consumer is what turns
 * at-least-once delivery into exactly-once <em>effect</em>, and it is durable rather than in-memory so
 * a consumer restart does not re-notify.
 */
public class NotificationDedupeRepository {

    private final JdbcTemplate jdbc;

    public NotificationDedupeRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Records an event as seen.
     *
     * @return true if this is the first time the event has been seen (so the caller should act on
     *         it), false if it is a duplicate (so the caller must not)
     */
    public boolean markSeen(String eventId, String eventType, String tokenRef) {
        try {
            jdbc.update("""
                    INSERT INTO notification_dedupe (event_id, event_type, token_ref)
                    VALUES (?,?,?)
                    """, eventId, eventType, tokenRef);
            return true;
        } catch (DuplicateKeyException e) {
            return false;
        }
    }

    public boolean seen(String eventId) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM notification_dedupe WHERE event_id = ?", Integer.class, eventId);
        return n != null && n > 0;
    }

    public long count() {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM notification_dedupe", Long.class);
        return n == null ? 0 : n;
    }
}
