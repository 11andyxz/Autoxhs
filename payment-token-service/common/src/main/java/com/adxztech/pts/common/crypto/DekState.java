package com.adxztech.pts.common.crypto;

/**
 * Lifecycle of a data encryption key version (S7.5).
 *
 * <p>Rotation never requires re-encrypting rows synchronously: each vault row stores the
 * {@code key_version} it was sealed under, so old versions stay usable for decryption while all new
 * writes move to the new {@link #ACTIVE} key.
 */
public enum DekState {

    /** Used for new writes. Exactly one version is ACTIVE at a time. */
    ACTIVE,

    /** Still needed to read historical rows; never used for new writes. */
    DECRYPT_ONLY,

    /** No rows reference it any more (a re-encrypt sweep has completed); kept for audit. */
    RETIRED
}
