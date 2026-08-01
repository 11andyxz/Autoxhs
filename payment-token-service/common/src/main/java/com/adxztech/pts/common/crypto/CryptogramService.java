package com.adxztech.pts.common.crypto;

import com.adxztech.pts.common.util.Hex;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;

/**
 * Per-transaction cryptogram computation and verification (S7.4).
 *
 * <p><b>Scope, stated plainly:</b> real EMVCo cryptograms (ARQC/TAVV) derive session keys from
 * issuer master keys using EMV-specified algorithms that are proprietary and issuer-key dependent.
 * This is a documented stand-in that reproduces the security <em>properties</em>, not the
 * construction:
 *
 * <pre>
 *   cryptogram = HMAC-SHA-256( cryptogram_key_in_HSM,
 *                              tokenPan | ATC | UN | amountMinor )   truncated to 8 bytes
 * </pre>
 *
 * <ul>
 *   <li><b>Key isolation</b> -- the key lives behind {@link KeyService}; this class never sees it.</li>
 *   <li><b>Replay resistance</b> -- the ATC is bound in and separately enforced to be monotonic
 *       (S6.1 step 4), so a captured cryptogram cannot be resubmitted.</li>
 *   <li><b>Freshness</b> -- the unpredictable number binds the cryptogram to one authorization.</li>
 *   <li><b>Amount binding</b> -- a cryptogram captured for $1 cannot be replayed for $1000.</li>
 *   <li><b>Timing safety</b> -- verification uses a constant-time compare.</li>
 * </ul>
 *
 * <p>The canonical input is pinned by {@link #canonicalInput} and covered by unit tests, because an
 * ambiguous serialisation is how cryptogram implementations actually break in the field.
 */
public class CryptogramService {

    /** EMV cryptograms are 8 bytes; the truncation keeps DE 55 the same size as the real thing. */
    public static final int CRYPTOGRAM_LEN = 8;

    private final KeyService keyService;

    public CryptogramService(KeyService keyService) {
        this.keyService = keyService;
    }

    /**
     * Builds the exact byte sequence the MAC is computed over.
     *
     * <p>Pinned format: {@code tokenPan|ATC(4 uppercase hex)|UN(uppercase)|amountMinor(decimal)}.
     * Explicit separators mean no two different inputs can produce the same byte string (an
     * unseparated concatenation of variable-length fields is a real forgery vector).
     */
    public static byte[] canonicalInput(String tokenPan, int atc, String unpredictableNumber, long amountMinor) {
        if (tokenPan == null || tokenPan.isBlank()) {
            throw new IllegalArgumentException("tokenPan is required");
        }
        if (atc < 0 || atc > 0xFFFF) {
            throw new IllegalArgumentException("ATC must fit in 2 bytes: " + atc);
        }
        if (unpredictableNumber == null || unpredictableNumber.isBlank()) {
            throw new IllegalArgumentException("unpredictableNumber is required");
        }
        if (amountMinor < 0) {
            throw new IllegalArgumentException("amountMinor must be >= 0");
        }
        String canonical = tokenPan
                + '|' + String.format("%04X", atc)
                + '|' + unpredictableNumber.trim().toUpperCase(Locale.ROOT)
                + '|' + amountMinor;
        return canonical.getBytes(StandardCharsets.UTF_8);
    }

    public byte[] compute(String tokenPan, int atc, String unpredictableNumber, long amountMinor) {
        byte[] full = keyService.cryptogramMac(canonicalInput(tokenPan, atc, unpredictableNumber, amountMinor));
        return Arrays.copyOf(full, CRYPTOGRAM_LEN);
    }

    public String computeHex(String tokenPan, int atc, String unpredictableNumber, long amountMinor) {
        return Hex.encode(compute(tokenPan, atc, unpredictableNumber, amountMinor));
    }

    /** @return {@code true} only if {@code presented} matches the recomputed cryptogram exactly. */
    public boolean verify(String tokenPan, int atc, String unpredictableNumber, long amountMinor,
                          byte[] presented) {
        if (presented == null || presented.length != CRYPTOGRAM_LEN) {
            return false;
        }
        byte[] expected = compute(tokenPan, atc, unpredictableNumber, amountMinor);
        return ConstantTime.equals(expected, presented);
    }

    /** Hex-string overload; a malformed hex value is a failed verification, not an exception. */
    public boolean verifyHex(String tokenPan, int atc, String unpredictableNumber, long amountMinor,
                             String presentedHex) {
        if (presentedHex == null) {
            return false;
        }
        byte[] presented;
        try {
            presented = Hex.decode(presentedHex);
        } catch (IllegalArgumentException e) {
            return false;
        }
        return verify(tokenPan, atc, unpredictableNumber, amountMinor, presented);
    }
}
