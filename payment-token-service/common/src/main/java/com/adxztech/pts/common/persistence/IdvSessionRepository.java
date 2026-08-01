package com.adxztech.pts.common.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** OTP step-up session state for ID&amp;V (S4.2, S5.3). */
public class IdvSessionRepository {

    public record IdvSession(String sessionId, String tokenRef, byte[] otpHash, int attempts,
                             Instant expiresAt) {

        public boolean expired(Instant now) {
            return now.isAfter(expiresAt);
        }
    }

    private static final RowMapper<IdvSession> MAPPER = (rs, n) -> new IdvSession(
            rs.getString("session_id"),
            rs.getString("token_ref"),
            rs.getBytes("otp_hash"),
            rs.getInt("attempts"),
            rs.getTimestamp("expires_at").toInstant());

    private final JdbcTemplate jdbc;

    public IdvSessionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(IdvSession s) {
        jdbc.update("""
                INSERT INTO idv_sessions (session_id, token_ref, otp_hash, attempts, expires_at)
                VALUES (?,?,?,?,?)
                """, s.sessionId(), s.tokenRef(), s.otpHash(), s.attempts(), Timestamp.from(s.expiresAt()));
    }

    public Optional<IdvSession> find(String sessionId) {
        List<IdvSession> rows = jdbc.query("""
                SELECT session_id, token_ref, otp_hash, attempts, expires_at
                  FROM idv_sessions WHERE session_id = ?
                """, MAPPER, sessionId);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public int incrementAttempts(String sessionId) {
        return jdbc.update("UPDATE idv_sessions SET attempts = attempts + 1 WHERE session_id = ?",
                sessionId);
    }

    public int delete(String sessionId) {
        return jdbc.update("DELETE FROM idv_sessions WHERE session_id = ?", sessionId);
    }

    /** Scheduled cleanup of abandoned step-ups (S5.3). */
    public int deleteExpired(Instant now) {
        return jdbc.update("DELETE FROM idv_sessions WHERE expires_at < ?", Timestamp.from(now));
    }
}
