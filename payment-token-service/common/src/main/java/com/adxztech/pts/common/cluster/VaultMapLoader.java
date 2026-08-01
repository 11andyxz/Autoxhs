package com.adxztech.pts.common.cluster;

import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.vault.VaultRecord;
import com.hazelcast.map.MapLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Collection;
import java.util.HashMap;
import java.util.Map;

/**
 * Read-through loader for {@code vault-records} (S3.1, S8.3).
 *
 * <p>This is the class that makes the cache safe to rely on: a miss -- cold start, post-deploy,
 * failover to a member that never held the entry -- transparently reads the source of truth instead of
 * failing the authorization. Latency degrades during warm-up; correctness does not.
 *
 * <p>{@link #loadAllKeys()} returns {@code null} on purpose: eagerly pulling the whole vault into
 * memory at start-up would turn a rolling restart into a database stampede, and the access pattern is
 * skewed enough (S11.2) that lazy loading reaches a high hit ratio within seconds.
 */
public class VaultMapLoader implements MapLoader<String, VaultRecord> {

    private static final Logger log = LoggerFactory.getLogger(VaultMapLoader.class);

    private final VaultRepository vaultRepository;

    public VaultMapLoader(VaultRepository vaultRepository) {
        this.vaultRepository = vaultRepository;
    }

    @Override
    public VaultRecord load(String tokenPan) {
        return vaultRepository.findByTokenPan(tokenPan).orElse(null);
    }

    @Override
    public Map<String, VaultRecord> loadAll(Collection<String> keys) {
        Map<String, VaultRecord> loaded = new HashMap<>(keys.size());
        for (String key : keys) {
            vaultRepository.findByTokenPan(key).ifPresent(r -> loaded.put(key, r));
        }
        return loaded;
    }

    /** {@code null} = do not pre-populate. See the class comment. */
    @Override
    public Iterable<String> loadAllKeys() {
        log.debug("vault-records: lazy load mode, no eager key preload");
        return null;
    }
}
