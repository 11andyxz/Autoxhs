package com.adxztech.pts.common.crypto;

import javax.crypto.SecretKey;

/**
 * The boundary between the application and the key store that holds secrets it must never see (S7).
 *
 * <p>Two secrets are supposed to be unextractable in a real TSP: the <b>KEK</b> that wraps data
 * encryption keys, and the <b>cryptogram key</b> used to verify per-transaction cryptograms. This
 * interface exposes only <em>use</em> of those keys -- wrap/unwrap and MAC -- never export. That
 * shape is what makes the PKCS#11 implementation a drop-in for the JCE one.
 *
 * @see Pkcs11KeyService the SoftHSM2 / real-HSM path
 * @see JceKeyService the seed-derived dev stand-in
 */
public interface KeyService {

    /** Generates a fresh AES-256 data encryption key (DEK) for a new {@code key_version}. */
    SecretKey generateDek();

    /** Wraps a DEK under the KEK. Only the wrapped form is ever persisted ({@code key_registry}). */
    byte[] wrapDek(SecretKey dek);

    /** Unwraps a stored DEK under the KEK. */
    SecretKey unwrapDek(byte[] wrapped);

    /** HMAC-SHA-256 under the cryptogram key -- never leaves this interface (S7.4). */
    byte[] cryptogramMac(byte[] input);

    /** HMAC-SHA-256 under the fingerprint key -- keyed, so a PAN cannot be brute-forced (S7.3). */
    byte[] fingerprintMac(byte[] input);

    /** Human-readable provenance for logs, /actuator/info and the demo script. */
    String describe();
}
