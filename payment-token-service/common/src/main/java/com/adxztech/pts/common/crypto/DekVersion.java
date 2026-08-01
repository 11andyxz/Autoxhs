package com.adxztech.pts.common.crypto;

import javax.crypto.SecretKey;

/**
 * An unwrapped data encryption key together with its registry metadata.
 *
 * <p>Held in memory only; the persisted form is always {@code key_registry.wrapped_dek} (S7.2).
 */
public record DekVersion(int version, SecretKey key, DekState state) {

    public DekVersion {
        if (version < 1) {
            throw new IllegalArgumentException("key_version must be >= 1");
        }
        if (key == null) {
            throw new IllegalArgumentException("key is required");
        }
        if (state == null) {
            throw new IllegalArgumentException("state is required");
        }
    }

    public boolean usableForWrites() {
        return state == DekState.ACTIVE;
    }

    @Override
    public String toString() {
        // Never render key material.
        return "DekVersion[v=" + version + ", state=" + state + "]";
    }
}
