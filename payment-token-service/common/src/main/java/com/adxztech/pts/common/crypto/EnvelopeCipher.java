package com.adxztech.pts.common.crypto;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;

/**
 * AES-256-GCM sealing of the funding PAN -- the inner half of envelope encryption (S7.2).
 *
 * <p>Blob layout, matching {@code token_vault.funding_pan_enc}:
 * <pre>
 *   IV(12) || ciphertext(n) || tag(16)
 * </pre>
 *
 * <p>Two deliberate choices worth defending in an interview:
 * <ul>
 *   <li><b>GCM, not CBC.</b> Authenticated encryption: a flipped bit in the vault is detected on
 *       decrypt ({@link AEADBadTagException}) instead of yielding a plausible wrong PAN.</li>
 *   <li><b>The token PAN is bound in as AAD.</b> Ciphertext is therefore not portable between rows:
 *       copying {@code funding_pan_enc} from token A onto token B fails authentication rather than
 *       silently re-pointing a token at another cardholder's funding account.</li>
 * </ul>
 */
public class EnvelopeCipher {

    private static final int IV_LEN = 12;
    private static final int TAG_BITS = 128;
    private static final String TRANSFORM = "AES/GCM/NoPadding";

    private final SecureRandom random;

    public EnvelopeCipher() {
        this(new SecureRandom());
    }

    public EnvelopeCipher(SecureRandom random) {
        this.random = random;
    }

    /**
     * @param aad additional authenticated data; callers pass the token PAN so ciphertext is bound to
     *            the row it belongs to
     */
    public byte[] seal(SecretKey dek, String plaintext, String aad) {
        try {
            byte[] iv = new byte[IV_LEN];
            random.nextBytes(iv);
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.ENCRYPT_MODE, dek, new GCMParameterSpec(TAG_BITS, iv));
            if (aad != null) {
                c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            }
            byte[] sealed = c.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[IV_LEN + sealed.length];
            System.arraycopy(iv, 0, out, 0, IV_LEN);
            System.arraycopy(sealed, 0, out, IV_LEN, sealed.length);
            return out;
        } catch (GeneralSecurityException e) {
            throw new KeyServiceException("envelope seal failed", e);
        }
    }

    /**
     * @throws TamperedCiphertextException when the GCM tag does not verify -- corruption, the wrong
     *                                     key version, or ciphertext lifted from another row
     */
    public String open(SecretKey dek, byte[] blob, String aad) {
        if (blob == null || blob.length <= IV_LEN + TAG_BITS / 8) {
            throw new TamperedCiphertextException("ciphertext too short to be a sealed PAN");
        }
        try {
            byte[] iv = Arrays.copyOfRange(blob, 0, IV_LEN);
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.DECRYPT_MODE, dek, new GCMParameterSpec(TAG_BITS, iv));
            if (aad != null) {
                c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            }
            byte[] plain = c.doFinal(blob, IV_LEN, blob.length - IV_LEN);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (AEADBadTagException e) {
            throw new TamperedCiphertextException("GCM tag mismatch: ciphertext, AAD or key version is wrong");
        } catch (GeneralSecurityException e) {
            throw new KeyServiceException("envelope open failed", e);
        }
    }

    /** Raised when authenticated decryption fails. Deliberately carries no plaintext detail. */
    public static class TamperedCiphertextException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public TamperedCiphertextException(String message) {
            super(message);
        }
    }
}
