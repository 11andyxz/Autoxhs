package com.adxztech.pts.common.cluster;

import com.adxztech.pts.common.persistence.VaultRepository;
import com.hazelcast.map.MapStore;

import java.util.Collection;
import java.util.HashMap;
import java.util.Map;

/**
 * Write-behind store for {@code token-atc} -> {@code token_vault.last_atc} (S8.2).
 *
 * <p>Moving the ATC advance into the cluster removes the third synchronous database round trip from
 * the hot path. The trade-off is explicit and bounded: <b>the replay window equals the write-behind
 * lag</b>. If a member dies with un-flushed counters, a token's stored ATC can regress by at most that
 * interval.
 *
 * <p>Why that is acceptable here, and what production would do instead:
 * <ul>
 *   <li>The write-behind delay is 1s by default, not 30s.</li>
 *   <li>{@code load} reads the database value, so a cold entry re-anchors on the durable counter
 *       rather than on 0 -- a restart cannot silently reset a token's replay protection.</li>
 *   <li>The counter is not the only defence: the cryptogram itself binds ATC, UN and amount, so
 *       replaying inside the window still has to present a cryptogram that passes verification for
 *       that exact tuple.</li>
 *   <li>{@code writeLastAtc} refuses to move the stored counter backwards, so an out-of-order flush
 *       cannot undo a later advance.</li>
 * </ul>
 * For production you tune the interval down, or keep ATC synchronous in a dedicated fast store and pay
 * one hop for it. This demo favours the latency win and says so.
 */
public class AtcMapStore implements MapStore<String, Integer> {

    private final VaultRepository vaultRepository;

    public AtcMapStore(VaultRepository vaultRepository) {
        this.vaultRepository = vaultRepository;
    }

    @Override
    public void store(String tokenPan, Integer atc) {
        if (atc != null) {
            vaultRepository.writeLastAtc(tokenPan, atc);
        }
    }

    @Override
    public void storeAll(Map<String, Integer> map) {
        map.forEach(this::store);
    }

    @Override
    public void delete(String tokenPan) {
        // The counter lives on the vault row; deleting a cache entry must not touch the row.
    }

    @Override
    public void deleteAll(Collection<String> keys) {
        // See delete(String).
    }

    /** Anchors a cold entry on the durable counter instead of on zero. */
    @Override
    public Integer load(String tokenPan) {
        return vaultRepository.findLastAtc(tokenPan).orElse(null);
    }

    @Override
    public Map<String, Integer> loadAll(Collection<String> keys) {
        Map<String, Integer> loaded = new HashMap<>(keys.size());
        for (String key : keys) {
            vaultRepository.findLastAtc(key).ifPresent(v -> loaded.put(key, v));
        }
        return loaded;
    }

    @Override
    public Iterable<String> loadAllKeys() {
        return null; // lazy: see VaultMapLoader
    }
}
