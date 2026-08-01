package com.adxztech.pts.common.token;

/**
 * Maps a funding-card BIN block to its issuer, and flags demo blocklist ranges (S5.2).
 *
 * <p>Half-open: {@code [binStart, binEnd)}.
 */
public record FundingBinRange(long binStart, long binEnd, String issuerId, boolean blocked) {

    public FundingBinRange {
        if (binEnd <= binStart) {
            throw new IllegalArgumentException("funding BIN end must be > start");
        }
        if (issuerId == null || issuerId.isBlank()) {
            throw new IllegalArgumentException("issuerId is required");
        }
    }

    public boolean contains(long fundingBin) {
        return fundingBin >= binStart && fundingBin < binEnd;
    }
}
