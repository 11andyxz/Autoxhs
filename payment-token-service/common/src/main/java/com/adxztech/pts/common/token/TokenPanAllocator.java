package com.adxztech.pts.common.token;

import com.adxztech.pts.common.pan.Luhn;

import java.security.SecureRandom;
import java.util.Random;

/**
 * Allocates a 16-digit network token PAN from an issuer's token BIN range (S5.1 step 6).
 *
 * <p>Layout: {@code BIN(8) || random(7) || Luhn check(1)}. The BIN is drawn from
 * {@code [binStart, binEnd)} so tokens spread across the issuer's Oracle partitions rather than
 * piling into one, while every token still prunes to exactly one partition on lookup (S4.1).
 *
 * <p>Uniqueness is <em>not</em> guaranteed here -- it is enforced by the {@code token_vault} primary
 * key. Callers retry allocation on a duplicate-key violation; with 10^7 suffixes per BIN and a
 * 100-BIN range the collision probability is negligible, and relying on the PK keeps the vault the
 * single arbiter of uniqueness.
 */
public final class TokenPanAllocator {

    private static final int SUFFIX_DIGITS = 7;
    private static final int SUFFIX_BOUND = 10_000_000; // 10^7

    private final Random random;

    public TokenPanAllocator() {
        this(new SecureRandom());
    }

    /** Injectable randomness so tests can pin the generated token. */
    public TokenPanAllocator(Random random) {
        this.random = random;
    }

    /** @return a Luhn-valid 16-digit token PAN whose leading 8 digits fall inside {@code range}. */
    public String allocate(TokenBinRange range) {
        long bin = range.binStart() + (long) (random.nextDouble() * range.width());
        if (bin >= range.binEnd()) { // guard against the 1.0 edge of nextDouble()
            bin = range.binEnd() - 1;
        }
        String suffix = String.format("%0" + SUFFIX_DIGITS + "d", random.nextInt(SUFFIX_BOUND));
        return Luhn.complete(bin + suffix);
    }

    /**
     * Derives the token expiry from the funding expiry: tokens outlive the plastic so a reissue does
     * not break the wallet (S5.5). Demo rule: funding expiry + 3 years, capped at YY=99.
     *
     * @param fundingExpiryYymm 4-digit YYMM
     */
    public static String deriveTokenExpiry(String fundingExpiryYymm) {
        if (fundingExpiryYymm == null || fundingExpiryYymm.length() != 4) {
            throw new IllegalArgumentException("expiry must be YYMM");
        }
        int yy = Integer.parseInt(fundingExpiryYymm.substring(0, 2));
        String mm = fundingExpiryYymm.substring(2, 4);
        int tokenYy = Math.min(99, yy + 3);
        return String.format("%02d%s", tokenYy, mm);
    }
}
