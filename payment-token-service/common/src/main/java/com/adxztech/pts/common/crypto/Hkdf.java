package com.adxztech.pts.common.crypto;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;

/**
 * HKDF-SHA-256 (RFC 5869).
 *
 * <p>Used by {@link JceKeyService} to derive the three demo "HSM-resident" keys (KEK, cryptogram
 * key, fingerprint key) from one configured seed, so every service in the stack agrees on keys
 * without a shared keystore file. This is a <em>dev/test stand-in</em>; the PKCS#11 path
 * ({@link Pkcs11KeyService}) is the one that models the real key custody story (S7).
 */
public final class Hkdf {

    private static final String HMAC = "HmacSHA256";
    private static final int HASH_LEN = 32;

    private Hkdf() {
    }

    /** RFC 5869 step 1: extract a pseudo-random key from the input keying material. */
    public static byte[] extract(byte[] salt, byte[] ikm) {
        try {
            byte[] effectiveSalt = (salt == null || salt.length == 0) ? new byte[HASH_LEN] : salt;
            Mac mac = Mac.getInstance(HMAC);
            mac.init(new SecretKeySpec(effectiveSalt, HMAC));
            return mac.doFinal(ikm);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HKDF extract failed", e);
        }
    }

    /** RFC 5869 step 2: expand the pseudo-random key into {@code length} output bytes. */
    public static byte[] expand(byte[] prk, String info, int length) {
        if (length < 1 || length > 255 * HASH_LEN) {
            throw new IllegalArgumentException("invalid HKDF output length: " + length);
        }
        try {
            Mac mac = Mac.getInstance(HMAC);
            mac.init(new SecretKeySpec(prk, HMAC));
            byte[] infoBytes = info == null ? new byte[0] : info.getBytes(StandardCharsets.UTF_8);
            byte[] out = new byte[length];
            byte[] block = new byte[0];
            int written = 0;
            for (int counter = 1; written < length; counter++) {
                mac.reset();
                mac.update(block);
                mac.update(infoBytes);
                mac.update((byte) counter);
                block = mac.doFinal();
                int n = Math.min(block.length, length - written);
                System.arraycopy(block, 0, out, written, n);
                written += n;
            }
            Arrays.fill(block, (byte) 0);
            return out;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HKDF expand failed", e);
        }
    }

    /** Convenience: extract-then-expand in one call. */
    public static byte[] derive(byte[] salt, byte[] ikm, String info, int length) {
        return expand(extract(salt, ikm), info, length);
    }
}
