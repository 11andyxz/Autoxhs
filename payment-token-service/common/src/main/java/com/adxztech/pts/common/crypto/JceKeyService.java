package com.adxztech.pts.common.crypto;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;

/**
 * Dev/test key service: the three "HSM-resident" keys are HKDF-derived from one configured seed.
 *
 * <p><b>This is a labelled stand-in, not a security control.</b> It exists so the whole stack can
 * run on a laptop and in CI without SoftHSM2 installed, while keeping the calling code identical to
 * the PKCS#11 path. Two properties make it useful:
 *
 * <ul>
 *   <li>All services derive the <em>same</em> keys from the same seed, so the provisioning service
 *       can encrypt a funding PAN and the detokenization service can decrypt it without a shared
 *       keystore file -- exactly the role the HSM plays in production.</li>
 *   <li>It is deterministic, so tests can assert on cryptogram values.</li>
 * </ul>
 *
 * In production this class is replaced by {@link Pkcs11KeyService}; see docs/SIMPLIFICATIONS.md.
 */
public class JceKeyService implements KeyService {

    private static final byte[] SALT = "pts/demo-hsm/v1".getBytes(StandardCharsets.UTF_8);
    private static final String INFO_KEK = "kek/aes-256";
    private static final String INFO_CRYPTOGRAM = "cryptogram-key/hmac-sha256";
    private static final String INFO_FINGERPRINT = "fingerprint-key/hmac-sha256";
    private static final String HMAC = "HmacSHA256";
    private static final String AES = "AES";
    private static final String KEY_WRAP = "AESWrap";

    private final SecretKey kek;
    private final SecretKey cryptogramKey;
    private final SecretKey fingerprintKey;
    private final SecureRandom random = new SecureRandom();

    /**
     * @param seed arbitrary-length secret shared by every service in the deployment
     *             ({@code pts.hsm.dev-seed})
     */
    public JceKeyService(String seed) {
        if (seed == null || seed.length() < 16) {
            throw new KeyServiceException("pts.hsm.dev-seed must be at least 16 characters");
        }
        byte[] ikm = seed.getBytes(StandardCharsets.UTF_8);
        byte[] prk = Hkdf.extract(SALT, ikm);
        this.kek = new SecretKeySpec(Hkdf.expand(prk, INFO_KEK, 32), AES);
        this.cryptogramKey = new SecretKeySpec(Hkdf.expand(prk, INFO_CRYPTOGRAM, 32), HMAC);
        this.fingerprintKey = new SecretKeySpec(Hkdf.expand(prk, INFO_FINGERPRINT, 32), HMAC);
    }

    @Override
    public SecretKey generateDek() {
        try {
            KeyGenerator kg = KeyGenerator.getInstance(AES);
            kg.init(256, random);
            return kg.generateKey();
        } catch (GeneralSecurityException e) {
            throw new KeyServiceException("cannot generate DEK", e);
        }
    }

    @Override
    public byte[] wrapDek(SecretKey dek) {
        try {
            Cipher c = Cipher.getInstance(KEY_WRAP);
            c.init(Cipher.WRAP_MODE, kek);
            return c.wrap(dek);
        } catch (GeneralSecurityException e) {
            throw new KeyServiceException("cannot wrap DEK", e);
        }
    }

    @Override
    public SecretKey unwrapDek(byte[] wrapped) {
        try {
            Cipher c = Cipher.getInstance(KEY_WRAP);
            c.init(Cipher.UNWRAP_MODE, kek);
            return (SecretKey) c.unwrap(wrapped, AES, Cipher.SECRET_KEY);
        } catch (GeneralSecurityException e) {
            throw new KeyServiceException("cannot unwrap DEK -- wrong KEK or corrupt key_registry row", e);
        }
    }

    @Override
    public byte[] cryptogramMac(byte[] input) {
        return mac(cryptogramKey, input);
    }

    @Override
    public byte[] fingerprintMac(byte[] input) {
        return mac(fingerprintKey, input);
    }

    private byte[] mac(SecretKey key, byte[] input) {
        try {
            Mac mac = Mac.getInstance(HMAC);
            mac.init(key);
            return mac.doFinal(input);
        } catch (GeneralSecurityException e) {
            throw new KeyServiceException("MAC computation failed", e);
        }
    }

    @Override
    public String describe() {
        return "JCE-DEV (HKDF-derived keys from pts.hsm.dev-seed -- NOT a security boundary)";
    }
}
