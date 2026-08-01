package com.adxztech.pts.common.iso8583;

import org.jpos.iso.ISOException;
import org.jpos.iso.ISOMsg;

import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;

/**
 * Builders for the two messages this demo exchanges: the {@code 0100} authorization request and its
 * {@code 0110} response.
 *
 * <p>Kept out of the switch itself so the load driver, the cert harness and the tests all construct
 * byte-identical messages -- if the harness and the switch disagreed about field layout, a green
 * certification run would prove nothing.
 */
public final class AuthMessages {

    private static final DateTimeFormatter TRANSMISSION = DateTimeFormatter.ofPattern("MMddHHmmss");
    private static final DateTimeFormatter LOCAL_TIME = DateTimeFormatter.ofPattern("HHmmss");
    private static final DateTimeFormatter LOCAL_DATE = DateTimeFormatter.ofPattern("MMdd");

    private AuthMessages() {
    }

    /** Everything the acquirer side needs to present a tokenized authorization. */
    public record AuthRequest(String tokenPan,
                              String tokenExpiry,
                              long amountMinor,
                              String stan,
                              String currencyCode,
                              String terminalId,
                              String acquirerId,
                              String processingCode,
                              TokenCryptogramTlv cryptogramData,
                              De48Markers markers) {
    }

    public static ISOMsg newAuthRequest(AuthRequest r) throws ISOException {
        ZonedDateTime now = ZonedDateTime.now(ZoneOffset.UTC);
        ISOMsg m = new ISOMsg();
        m.setMTI(IsoFields.MTI_AUTH_REQUEST);
        m.set(IsoFields.DE_PAN, r.tokenPan());
        m.set(IsoFields.DE_PROCESSING_CODE, r.processingCode() == null ? "000000" : r.processingCode());
        m.set(IsoFields.DE_AMOUNT, String.format("%012d", r.amountMinor()));
        m.set(IsoFields.DE_TRANSMISSION_DATETIME, TRANSMISSION.format(now));
        m.set(IsoFields.DE_STAN, String.format("%06d", Long.parseLong(r.stan()) % 1_000_000));
        m.set(IsoFields.DE_LOCAL_TIME, LOCAL_TIME.format(now));
        m.set(IsoFields.DE_LOCAL_DATE, LOCAL_DATE.format(now));
        if (r.tokenExpiry() != null) {
            m.set(IsoFields.DE_EXPIRY, r.tokenExpiry());
        }
        if (r.acquirerId() != null) {
            m.set(IsoFields.DE_ACQUIRER_ID, r.acquirerId());
        }
        m.set(IsoFields.DE_TERMINAL_ID, r.terminalId() == null ? "TERM0001" : r.terminalId());
        if (r.currencyCode() != null) {
            m.set(IsoFields.DE_CURRENCY, r.currencyCode());
        }
        if (r.markers() != null) {
            String encoded = r.markers().encode();
            if (!encoded.isEmpty()) {
                m.set(IsoFields.DE_PRIVATE_USE, encoded);
            }
        }
        if (r.cryptogramData() != null) {
            m.set(IsoFields.DE_ICC_DATA, r.cryptogramData().encodeHex());
        }
        return m;
    }

    /**
     * Builds the {@code 0110} response from the request, preserving the trace fields an acquirer
     * matches on (DE 11 / DE 37 / DE 4).
     */
    public static ISOMsg newAuthResponse(ISOMsg request, String responseCode, String authCode)
            throws ISOException {
        ISOMsg m = new ISOMsg();
        m.setMTI(IsoFields.MTI_AUTH_RESPONSE);
        copyIfPresent(request, m, IsoFields.DE_PAN);
        copyIfPresent(request, m, IsoFields.DE_PROCESSING_CODE);
        copyIfPresent(request, m, IsoFields.DE_AMOUNT);
        copyIfPresent(request, m, IsoFields.DE_TRANSMISSION_DATETIME);
        copyIfPresent(request, m, IsoFields.DE_STAN);
        copyIfPresent(request, m, IsoFields.DE_LOCAL_TIME);
        copyIfPresent(request, m, IsoFields.DE_LOCAL_DATE);
        copyIfPresent(request, m, IsoFields.DE_RRN);
        copyIfPresent(request, m, IsoFields.DE_TERMINAL_ID);
        copyIfPresent(request, m, IsoFields.DE_CURRENCY);
        m.set(IsoFields.DE_RESPONSE_CODE, responseCode);
        if (authCode != null && !authCode.isBlank()) {
            m.set(38, authCode);
        }
        return m;
    }

    public static String responseCode(ISOMsg m) {
        return m == null ? null : m.getString(IsoFields.DE_RESPONSE_CODE);
    }

    private static void copyIfPresent(ISOMsg from, ISOMsg to, int field) throws ISOException {
        if (from.hasField(field)) {
            to.set(field, from.getString(field));
        }
    }
}
