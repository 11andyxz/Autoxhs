package com.adxztech.pts.common.cache;

import com.adxztech.pts.common.vault.VaultRecord;

import java.util.Optional;

/**
 * The {@code DIRECT} strategy: no cache at all, every read is a JDBC round trip.
 *
 * <p>This is the "before" world of the latency story (S8.1). It is a real, supported mode rather than
 * a straw man -- it is also what the service falls back to if the cache tier is unavailable, so it has
 * to be correct.
 */
public class NoopVaultCache implements VaultCache {

    @Override
    public Optional<VaultRecord> get(String tokenPan) {
        return Optional.empty();
    }

    @Override
    public void put(VaultRecord record) {
        // nothing to keep coherent
    }

    @Override
    public void invalidate(String tokenPan) {
        // nothing to invalidate
    }

    @Override
    public String describe() {
        return "DIRECT (no cache; every read is a database round trip)";
    }
}
