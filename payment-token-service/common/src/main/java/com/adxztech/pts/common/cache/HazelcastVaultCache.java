package com.adxztech.pts.common.cache;

import com.adxztech.pts.common.cluster.VaultClusterConfig;
import com.adxztech.pts.common.vault.VaultRecord;
import com.hazelcast.core.HazelcastInstance;
import com.hazelcast.map.IMap;

import java.util.Optional;

/**
 * The {@code NEAR_CACHE} strategy: reads served from the Hazelcast {@code vault-records} IMap (S8.2).
 *
 * <p>When the instance behind this class is a Hazelcast <b>client with near-cache enabled</b>, a hit
 * on a hot token is resolved from process-local memory -- no hop at all. A miss is served by the
 * member, which itself falls through to Oracle via the read-through {@code MapLoader}. So the read
 * path degrades gracefully: local memory, then cluster memory, then the source of truth.
 *
 * <p>{@link #invalidate} uses {@code evict} rather than {@code delete}: {@code delete} would ask the
 * MapStore to remove the underlying row, which is emphatically not what cache invalidation means.
 * Getting that distinction wrong is a fast way to lose a vault row to a cache operation.
 */
public class HazelcastVaultCache implements VaultCache {

    private final IMap<String, VaultRecord> map;
    private final String description;

    public HazelcastVaultCache(HazelcastInstance hazelcast) {
        this(hazelcast, VaultClusterConfig.MAP_VAULT);
    }

    public HazelcastVaultCache(HazelcastInstance hazelcast, String mapName) {
        this.map = hazelcast.getMap(mapName);
        this.description = "NEAR_CACHE (hazelcast map '" + mapName + "' via "
                + hazelcast.getName() + ")";
    }

    @Override
    public Optional<VaultRecord> get(String tokenPan) {
        return Optional.ofNullable(map.get(tokenPan));
    }

    /** {@code set} rather than {@code put}: we never need the previous value, so do not ship it back. */
    @Override
    public void put(VaultRecord record) {
        map.set(record.tokenPan(), record);
    }

    @Override
    public void invalidate(String tokenPan) {
        map.evict(tokenPan);
    }

    @Override
    public String describe() {
        return description;
    }

    /** Exposed for the cache dashboard and the reconciliation sweep. */
    public int size() {
        return map.size();
    }
}
