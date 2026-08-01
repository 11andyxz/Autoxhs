package com.adxztech.pts.common.iso8583;

/**
 * The ISO 8583 data elements this demo touches (S6.2).
 *
 * <p>Deliberately a subset. Naming them as constants keeps the field-level token handling readable,
 * which is the whole point of the claim being evidenced here.
 */
public final class IsoFields {

    /** PAN. Carries the <b>token</b> inbound; swapped to the funding PAN outbound to the issuer. */
    public static final int DE_PAN = 2;

    /** Processing code. */
    public static final int DE_PROCESSING_CODE = 3;

    /** Transaction amount, minor units. Bound into cryptogram validation. */
    public static final int DE_AMOUNT = 4;

    /** Transmission date and time, MMDDhhmmss. */
    public static final int DE_TRANSMISSION_DATETIME = 7;

    /** System trace audit number. */
    public static final int DE_STAN = 11;

    /** Local transaction time, hhmmss. */
    public static final int DE_LOCAL_TIME = 12;

    /** Local transaction date, MMDD. */
    public static final int DE_LOCAL_DATE = 13;

    /** Card expiry, YYMM. Swapped alongside DE 2 when the funding card has a different expiry. */
    public static final int DE_EXPIRY = 14;

    /** Acquiring institution id. */
    public static final int DE_ACQUIRER_ID = 32;

    /** Retrieval reference number. */
    public static final int DE_RRN = 37;

    /** Response code: {@code 00} approved, anything else declined. */
    public static final int DE_RESPONSE_CODE = 39;

    /** Card acceptor terminal id. */
    public static final int DE_TERMINAL_ID = 41;

    /** Private use: token requestor id and domain markers for token-aware issuers. */
    public static final int DE_PRIVATE_USE = 48;

    /** Currency code. */
    public static final int DE_CURRENCY = 49;

    /** ICC / token cryptogram data as BER-TLV: cryptogram + ATC + UN. */
    public static final int DE_ICC_DATA = 55;

    public static final String MTI_AUTH_REQUEST = "0100";
    public static final String MTI_AUTH_RESPONSE = "0110";

    public static final String RC_APPROVED = "00";
    public static final String RC_DO_NOT_HONOR = "05";
    public static final String RC_INVALID_CARD = "14";
    public static final String RC_INSUFFICIENT_FUNDS = "51";
    public static final String RC_EXPIRED_CARD = "54";
    public static final String RC_SUSPECTED_FRAUD = "59";
    public static final String RC_SYSTEM_ERROR = "96";

    private IsoFields() {
    }
}
