package com.adxztech.pts.common.crypto;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.Provider;
import java.security.Security;

/**
 * PKCS#11 key service, backed by SoftHSM2 in the demo and by a payment HSM in production (S7.1).
 *
 * <p>The point of this class is <b>key custody</b>: the KEK and the cryptogram key are generated
 * inside the token and are marked non-extractable, so wrap/unwrap and MAC happen on the other side
 * of the PKCS#11 boundary. The application only ever holds handles.
 *
 * <p>Enable with:
 * <pre>
 *   pts.hsm.mode: PKCS11
 *   pts.hsm.pkcs11.config-path: /etc/pts/softhsm-pkcs11.cfg
 *   pts.hsm.pkcs11.pin: 1234
 * </pre>
 * See {@code ops/softhsm/init-softhsm.sh} for token and key creation.
 *
 * <p><b>Verification status:</b> this path is exercised only where a PKCS#11 token is present. The
 * default build and CI run {@link JceKeyService}; see docs/SIMPLIFICATIONS.md.
 */
public class Pkcs11KeyService implements KeyService {

    private static final String AES = "AES";
    private static final String HMAC = "HmacSHA256";
    private static final String KEY_WRAP = "AESWrap";

    private final Provider provider;
    private final SecretKey kek;
    private final SecretKey cryptogramKey;
    private final SecretKey fingerprintKey;
    private final String description;

    public Pkcs11KeyService(String configPath, char[] pin, String kekAlias,
                            String cryptogramAlias, String fingerprintAlias) {
        try {
            Provider sunPkcs11 = Security.getProvider("SunPKCS11");
            if (sunPkcs11 == null) {
                throw new KeyServiceException("SunPKCS11 provider is unavailable in this JVM");
            }
            this.provider = sunPkcs11.configure(configPath);
            Security.addProvider(this.provider);

            KeyStore ks = KeyStore.getInstance("PKCS11", this.provider);
            ks.load(null, pin);

            this.kek = requireKey(ks, kekAlias, pin);
            this.cryptogramKey = requireKey(ks, cryptogramAlias, pin);
            this.fingerprintKey = requireKey(ks, fingerprintAlias, pin);
            this.description = "PKCS11:" + this.provider.getName() + " (config=" + configPath + ")";
        } catch (KeyServiceException e) {
            throw e;
        } catch (Exception e) {
            throw new KeyServiceException("cannot initialise PKCS#11 key service from " + configPath, e);
        }
    }

    private static SecretKey requireKey(KeyStore ks, String alias, char[] pin) throws GeneralSecurityException {
        java.security.Key key;
        try {
            key = ks.getKey(alias, pin);
        } catch (Exception e) {
            throw new KeyServiceException("cannot read PKCS#11 key alias '" + alias + "'", e);
        }
        if (!(key instanceof SecretKey secret)) {
            throw new KeyServiceException("PKCS#11 alias '" + alias + "' is not a secret key");
        }
        return secret;
    }

    /**
     * Generates the DEK inside the token where possible. Note the DEK <em>must</em> be extractable
     * in wrapped form (that is the whole point of envelope encryption), so unlike the KEK it is a
     * session key we allow out under wrap.
     */
    @Override
    public SecretKey generateDek() {
        try {
            javax.crypto.KeyGenerator kg = javax.crypto.KeyGenerator.getInstance(AES, provider);
            kg.init(256);
            return kg.generateKey();
        } catch (GeneralSecurityException e) {
            // Some tokens refuse in-token AES keygen for extractable keys; fall back to the JVM RNG.
            try {
                javax.crypto.KeyGenerator kg = javax.crypto.KeyGenerator.getInstance(AES);
                kg.init(256);
                return kg.generateKey();
            } catch (GeneralSecurityException inner) {
                throw new KeyServiceException("cannot generate DEK", inner);
            }
        }
    }

    @Override
    public byte[] wrapDek(SecretKey dek) {
        try {
            Cipher c = Cipher.getInstance(KEY_WRAP, provider);
            c.init(Cipher.WRAP_MODE, kek);
            return c.wrap(dek);
        } catch (GeneralSecurityException e) {
            throw new KeyServiceException("HSM wrap failed", e);
        }
    }

    @Override
    public SecretKey unwrapDek(byte[] wrapped) {
        try {
            Cipher c = Cipher.getInstance(KEY_WRAP, provider);
            c.init(Cipher.UNWRAP_MODE, kek);
            return (SecretKey) c.unwrap(wrapped, AES, Cipher.SECRET_KEY);
        } catch (GeneralSecurityException e) {
            throw new KeyServiceException("HSM unwrap failed", e);
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
            Mac mac = Mac.getInstance(HMAC, provider);
            mac.init(key);
            return mac.doFinal(input);
        } catch (GeneralSecurityException e) {
            throw new KeyServiceException("HSM MAC failed", e);
        }
    }

    @Override
    public String describe() {
        return description;
    }
}
