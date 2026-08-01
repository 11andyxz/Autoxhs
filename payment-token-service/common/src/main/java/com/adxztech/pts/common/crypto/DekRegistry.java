package com.adxztech.pts.common.crypto;

/**
 * Supplies DEKs by version, unwrapping them through the {@link KeyService} on first use (S7.2).
 *
 * <p>Both the write path (needs {@link #active()}) and the read path (needs
 * {@link #byVersion(int)} for whatever version a row was sealed under) depend on this.
 */
public interface DekRegistry {

    /** @return the single version new writes must use. */
    DekVersion active();

    /**
     * @param version the {@code key_version} stored on the row being decrypted
     * @throws KeyServiceException if the version is unknown or RETIRED
     */
    DekVersion byVersion(int version);
}
