package com.adxztech.pts.it;

import com.adxztech.pts.common.pan.Luhn;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Generates funding cards for the integration suite, on demand and without repeats.
 *
 * <p><b>Why generated rather than a fixed list.</b> The detokenization matrix alone provisions a token per
 * test per flag combination, so the suite needs well over a hundred distinct cards and that number grows
 * with every new test. A hand-maintained list runs out, and the failure mode is a confusing
 * "pool exhausted" error in whichever test happens to run last.
 *
 * <p><b>Why cards must not be shared.</b> The certification suites assert exact counts -- "this reissue
 * re-pointed exactly 1 token". A second token provisioned against the same card by an unrelated test would
 * change that count and fail the suite for a reason unconnected to the code under test. Cards used by the
 * shipped suites are therefore reserved and never handed out here.
 *
 * <p>Every generated card is Luhn-valid, sits inside a seeded funding BIN block, and has last-two-digits
 * chosen so the issuer simulator's deterministic score ({@code last4 mod 100}) puts it on the intended
 * ID&amp;V path: {@code ..25} green, {@code ..45} yellow (S5.2).
 */
final class ItCards {

    private static final long ISSA_FUNDING_BIN = 41111000L;
    private static final long ISSB_FUNDING_BIN = 42222000L;
    private static final int GREEN_LAST_TWO = 25;   // risk 25 -> APPROVE
    private static final int YELLOW_LAST_TWO = 45;  // risk 45 -> STEP_UP for a wallet

    /** Cards the shipped certification suites own. Never handed out to a test. */
    private static final Set<String> RESERVED = Set.of(
            "4111100000000725",  // DemoCards.ISSA_APPROVE
            "4111100000001525",  // DemoCards.ISSA_APPROVE_2
            "4111100000002325",  // DemoCards.ISSA_REISSUED
            "4111100000000345",  // DemoCards.ISSA_STEP_UP
            "4111100000000485",  // DemoCards.ISSA_DECLINE
            "4222200000000125",  // DemoCards.ISSB_APPROVE
            "4222200000000745",  // DemoCards.ISSB_STEP_UP
            "4222200000000885",  // ISSB decline
            "4333300000000525"); // DemoCards.BLOCKED_BIN_CARD

    private static final CardSequence ISSA_GREEN = new CardSequence(ISSA_FUNDING_BIN, GREEN_LAST_TWO);
    private static final CardSequence ISSA_YELLOW = new CardSequence(ISSA_FUNDING_BIN, YELLOW_LAST_TWO);
    private static final CardSequence ISSB_GREEN = new CardSequence(ISSB_FUNDING_BIN, GREEN_LAST_TWO);
    private static final CardSequence ISSB_YELLOW = new CardSequence(ISSB_FUNDING_BIN, YELLOW_LAST_TWO);

    /** ISSA, green path. Tokens land in token BIN block 49996000-49996100. */
    static String nextIssaApprove() {
        return ISSA_GREEN.next();
    }

    /** ISSA, yellow path: a wallet must complete OTP step-up. */
    static String nextIssaStepUp() {
        return ISSA_YELLOW.next();
    }

    /** ISSB, green path. Tokens land in block 49996100-49996200, which ships {@code token_aware=true}. */
    static String nextIssbApprove() {
        return ISSB_GREEN.next();
    }

    /** ISSB, yellow path. */
    static String nextIssbStepUp() {
        return ISSB_YELLOW.next();
    }

    /**
     * Walks the suffix space once, keeping its position, so handing out N cards is linear overall rather
     * than rescanning from zero each time.
     */
    private static final class CardSequence {

        private final long bin8;
        private final int lastTwo;
        private final Set<String> issued = new LinkedHashSet<>();
        private int cursor;

        CardSequence(long bin8, int lastTwo) {
            this.bin8 = bin8;
            this.lastTwo = lastTwo;
        }

        synchronized String next() {
            while (cursor < 10_000_000) {
                String candidate = Luhn.complete(bin8 + String.format("%07d", cursor++));
                if (Integer.parseInt(candidate.substring(candidate.length() - 2)) != lastTwo) {
                    continue;
                }
                if (RESERVED.contains(candidate) || !issued.add(candidate)) {
                    continue;
                }
                return candidate;
            }
            throw new IllegalStateException("exhausted the suffix space for BIN " + bin8
                    + " with last-two-digits " + lastTwo);
        }
    }

    private ItCards() {
    }
}
