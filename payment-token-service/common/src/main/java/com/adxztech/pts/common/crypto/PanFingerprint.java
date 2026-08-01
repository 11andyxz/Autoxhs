package com.adxztech.pts.common.crypto;

import com.adxztech.pts.common.pan.Pan;

import java.nio.charset.StandardCharsets;

/**
 * Keyed, non-reversible fingerprint of a funding PAN (S7.3).
 *
 * <p>Stored in {@code token_vault.funding_pan_h} so "find every token for this card" (the reissue
 * flow, S5.5) is an index probe rather than a table scan of decryptions.
 *
 * <p><b>Why HMAC and not SHA-256.</b> A bare hash of a 16-digit PAN is brute-forceable: the search
 * space is only 10^15 before you subtract known BIN ranges and the Luhn constraint, which puts it
 * within reach of a GPU in minutes. HMAC under a key the data store never sees removes the offline
 * attack entirely -- an attacker with the whole table still cannot enumerate candidate PANs.
 */
public class PanFingerprint {

    private final KeyService keyService;

    public PanFingerprint(KeyService keyService) {
        this.keyService = keyService;
    }

    /** @param pan the funding PAN, digits only */
    public byte[] compute(String pan) {
        String normalized = Pan.normalize(pan);
        return keyService.fingerprintMac(normalized.getBytes(StandardCharsets.UTF_8));
    }

    public byte[] compute(Pan pan) {
        return keyService.fingerprintMac(pan.value().getBytes(StandardCharsets.UTF_8));
    }
}
