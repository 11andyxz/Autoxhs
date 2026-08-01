package com.adxztech.pts.common.demo;

/**
 * The canonical demo data set, in code rather than scattered across scripts and docs.
 *
 * <p>Every card here is Luhn-valid and sits in a BIN block the seeded {@code funding_bin_map} knows
 * about. The issuer simulator derives its risk score deterministically as
 * {@code last4 mod 100} (S5.2), so the last two digits of a card <em>are</em> its ID&amp;V outcome:
 *
 * <table border="1">
 *   <caption>Demo cards</caption>
 *   <tr><th>Card</th><th>risk</th><th>ID&amp;V outcome</th></tr>
 *   <tr><td>{@link #ISSA_APPROVE}</td><td>25</td><td>APPROVE (green path)</td></tr>
 *   <tr><td>{@link #ISSA_STEP_UP}</td><td>45</td><td>STEP_UP for a wallet, APPROVE for a trusted merchant</td></tr>
 *   <tr><td>{@link #ISSA_DECLINE}</td><td>85</td><td>DECLINE (red path)</td></tr>
 *   <tr><td>{@link #BLOCKED_BIN_CARD}</td><td>25</td><td>DECLINE -- BIN is on the demo blocklist</td></tr>
 * </table>
 *
 * <p>These are fabricated test numbers in test BIN ranges. Nothing here corresponds to a real card.
 */
public final class DemoCards {

    // ---- funding cards, issuer ISSA (funding BIN block 41111000-41111999) -------------------

    /** Green path: provisions immediately. */
    public static final String ISSA_APPROVE = "4111100000000725";

    /** A second clean card, for multi-token and card-reissue scenarios. */
    public static final String ISSA_APPROVE_2 = "4111100000001525";

    /** The card an ISSA cardholder is reissued after loss (S5.5). */
    public static final String ISSA_REISSUED = "4111100000002325";

    /** Yellow path: OTP step-up when a wallet provisions it. */
    public static final String ISSA_STEP_UP = "4111100000000345";

    /** Red path: issuer declines provisioning outright. */
    public static final String ISSA_DECLINE = "4111100000000485";

    // ---- funding cards, issuer ISSB (funding BIN block 42222000-42222999) -------------------

    public static final String ISSB_APPROVE = "4222200000000125";
    public static final String ISSB_STEP_UP = "4222200000000745";

    // ---- blocklisted BIN block (43333000-43333999) -----------------------------------------

    /** Clean risk score, but the BIN block is blocked -- proves the local rule overrides the signal. */
    public static final String BLOCKED_BIN_CARD = "4333300000000525";

    // ---- token requestors -------------------------------------------------------------------

    /** A wallet provider. Yellow-path provisioning requires OTP step-up. */
    public static final String WALLET_REQUESTOR = "40010030001";

    /** A trusted card-on-file merchant. Yellow-path provisioning is approved without step-up. */
    public static final String TRUSTED_MERCHANT_REQUESTOR = "50020040002";

    /** An untrusted requestor, used to prove domain restriction rejects a mismatched presenter. */
    public static final String OTHER_REQUESTOR = "60030050003";

    // ---- expiries ---------------------------------------------------------------------------

    public static final String FUNDING_EXPIRY = "2812";
    public static final String REISSUED_EXPIRY = "3012";

    private DemoCards() {
    }
}
