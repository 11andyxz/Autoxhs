package com.adxztech.pts.common.persistence;

import com.adxztech.pts.common.crypto.DekState;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.util.List;
import java.util.Optional;

/**
 * {@code key_registry}: wrapped data encryption keys and their rotation state (S7.2, S7.5).
 *
 * <p>Only the <em>wrapped</em> DEK is ever stored. Unwrapping requires the HSM-resident KEK, so this
 * table is useless on its own -- which is the entire point of envelope encryption.
 */
public class KeyRegistryRepository {

    public record KeyRow(int version, byte[] wrappedDek, DekState state) {
    }

    private static final RowMapper<KeyRow> MAPPER = (rs, n) -> new KeyRow(
            rs.getInt("key_version"),
            rs.getBytes("wrapped_dek"),
            DekState.valueOf(rs.getString("state")));

    private final JdbcTemplate jdbc;

    public KeyRegistryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(int version, byte[] wrappedDek, DekState state) {
        jdbc.update("INSERT INTO key_registry (key_version, wrapped_dek, state) VALUES (?,?,?)",
                version, wrappedDek, state.name());
    }

    public Optional<KeyRow> findActive() {
        List<KeyRow> rows = jdbc.query("""
                SELECT key_version, wrapped_dek, state FROM key_registry
                 WHERE state = 'ACTIVE' ORDER BY key_version DESC
                """, MAPPER);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public Optional<KeyRow> findByVersion(int version) {
        List<KeyRow> rows = jdbc.query("""
                SELECT key_version, wrapped_dek, state FROM key_registry WHERE key_version = ?
                """, MAPPER, version);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public List<KeyRow> findAll() {
        return jdbc.query(
                "SELECT key_version, wrapped_dek, state FROM key_registry ORDER BY key_version", MAPPER);
    }

    public int maxVersion() {
        Integer v = jdbc.queryForObject(
                "SELECT COALESCE(MAX(key_version), 0) FROM key_registry", Integer.class);
        return v == null ? 0 : v;
    }

    public int updateState(int version, DekState state) {
        return jdbc.update("UPDATE key_registry SET state = ? WHERE key_version = ?",
                state.name(), version);
    }

    /** Demotes every currently-ACTIVE version; used at the start of a rotation (S7.5). */
    public int demoteActiveToDecryptOnly() {
        return jdbc.update(
                "UPDATE key_registry SET state = 'DECRYPT_ONLY' WHERE state = 'ACTIVE'");
    }
}
