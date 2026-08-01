package com.adxztech.pts.common.persistence;

import com.adxztech.pts.common.token.FundingBinRange;
import com.adxztech.pts.common.token.TokenBinRange;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.util.List;
import java.util.Optional;

/**
 * {@code issuer_bin_map} and {@code funding_bin_map} (S4.2).
 *
 * <p>{@code issuer_bin_map.token_aware} is the flag that drives the ISO 8583
 * backward-compatibility split in S6.2 -- flip it and the switch produces a different outbound
 * message shape for the same inbound authorization.
 */
public class BinMapRepository {

    private static final RowMapper<TokenBinRange> TOKEN_MAPPER = (rs, n) -> new TokenBinRange(
            rs.getLong("token_bin_start"),
            rs.getLong("token_bin_end"),
            rs.getString("issuer_id"),
            "Y".equalsIgnoreCase(rs.getString("token_aware")));

    private static final RowMapper<FundingBinRange> FUNDING_MAPPER = (rs, n) -> new FundingBinRange(
            rs.getLong("funding_bin_start"),
            rs.getLong("funding_bin_end"),
            rs.getString("issuer_id"),
            "Y".equalsIgnoreCase(rs.getString("blocked")));

    private final JdbcTemplate jdbc;

    public BinMapRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ---------------------------------------------------------------- token BINs

    /** Resolves the issuer (and its token capability) that owns a token BIN. */
    public Optional<TokenBinRange> findTokenRange(long tokenBin) {
        List<TokenBinRange> rows = jdbc.query("""
                SELECT token_bin_start, token_bin_end, issuer_id, token_aware
                  FROM issuer_bin_map
                 WHERE ? >= token_bin_start AND ? < token_bin_end
                """, TOKEN_MAPPER, tokenBin, tokenBin);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public Optional<TokenBinRange> findTokenRangeByIssuer(String issuerId) {
        List<TokenBinRange> rows = jdbc.query("""
                SELECT token_bin_start, token_bin_end, issuer_id, token_aware
                  FROM issuer_bin_map WHERE issuer_id = ? ORDER BY token_bin_start
                """, TOKEN_MAPPER, issuerId);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public List<TokenBinRange> findAllTokenRanges() {
        return jdbc.query("""
                SELECT token_bin_start, token_bin_end, issuer_id, token_aware
                  FROM issuer_bin_map ORDER BY token_bin_start
                """, TOKEN_MAPPER);
    }

    /** Idempotent seed used at startup; update-then-insert keeps the SQL portable (no MERGE). */
    public void upsertTokenRange(TokenBinRange r) {
        int updated = jdbc.update("""
                UPDATE issuer_bin_map
                   SET token_bin_end = ?, issuer_id = ?, token_aware = ?
                 WHERE token_bin_start = ?
                """, r.binEnd(), r.issuerId(), r.tokenAware() ? "Y" : "N", r.binStart());
        if (updated == 0) {
            jdbc.update("""
                    INSERT INTO issuer_bin_map (token_bin_start, token_bin_end, issuer_id, token_aware)
                    VALUES (?,?,?,?)
                    """, r.binStart(), r.binEnd(), r.issuerId(), r.tokenAware() ? "Y" : "N");
        }
    }

    /** Demo control for the S6.2 backward-compatibility beat. */
    public int setTokenAware(String issuerId, boolean tokenAware) {
        return jdbc.update("UPDATE issuer_bin_map SET token_aware = ? WHERE issuer_id = ?",
                tokenAware ? "Y" : "N", issuerId);
    }

    // -------------------------------------------------------------- funding BINs

    public Optional<FundingBinRange> findFundingRange(long fundingBin) {
        List<FundingBinRange> rows = jdbc.query("""
                SELECT funding_bin_start, funding_bin_end, issuer_id, blocked
                  FROM funding_bin_map
                 WHERE ? >= funding_bin_start AND ? < funding_bin_end
                """, FUNDING_MAPPER, fundingBin, fundingBin);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public List<FundingBinRange> findAllFundingRanges() {
        return jdbc.query("""
                SELECT funding_bin_start, funding_bin_end, issuer_id, blocked
                  FROM funding_bin_map ORDER BY funding_bin_start
                """, FUNDING_MAPPER);
    }

    public void upsertFundingRange(FundingBinRange r) {
        int updated = jdbc.update("""
                UPDATE funding_bin_map
                   SET funding_bin_end = ?, issuer_id = ?, blocked = ?
                 WHERE funding_bin_start = ?
                """, r.binEnd(), r.issuerId(), r.blocked() ? "Y" : "N", r.binStart());
        if (updated == 0) {
            jdbc.update("""
                    INSERT INTO funding_bin_map (funding_bin_start, funding_bin_end, issuer_id, blocked)
                    VALUES (?,?,?,?)
                    """, r.binStart(), r.binEnd(), r.issuerId(), r.blocked() ? "Y" : "N");
        }
    }
}
