package com.adxztech.pts.common.token;

/**
 * A block of token BINs allocated to one issuer -- the {@code issuer_bin_map} row (S4.2).
 *
 * <p>The range is half-open: {@code [binStart, binEnd)}, matching the Oracle
 * {@code PARTITION BY RANGE ... VALUES LESS THAN} boundaries in S4.1 so a range maps 1:1 onto a
 * partition.
 *
 * @param binStart    inclusive 8-digit lower bound
 * @param binEnd      exclusive 8-digit upper bound
 * @param issuerId    the owning issuer
 * @param tokenAware  whether this issuer can validate token cryptograms itself; drives the
 *                    ISO 8583 backward-compatibility split in S6.2
 */
public record TokenBinRange(long binStart, long binEnd, String issuerId, boolean tokenAware) {

    public TokenBinRange {
        if (binStart < 10_000_000L || binStart > 99_999_999L) {
            throw new IllegalArgumentException("token BIN start must be 8 digits: " + binStart);
        }
        if (binEnd <= binStart || binEnd > 100_000_000L) {
            throw new IllegalArgumentException("token BIN end must be > start and 8 digits: " + binEnd);
        }
        if (issuerId == null || issuerId.isBlank()) {
            throw new IllegalArgumentException("issuerId is required");
        }
    }

    public boolean contains(long tokenBin) {
        return tokenBin >= binStart && tokenBin < binEnd;
    }

    /** @return how many distinct 8-digit BINs this range covers. */
    public long width() {
        return binEnd - binStart;
    }
}
