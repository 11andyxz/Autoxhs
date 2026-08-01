package com.adxztech.pts.detok;

import com.adxztech.pts.common.cache.AtcGuard;
import com.adxztech.pts.common.cluster.AtcAdvanceProcessor;
import com.adxztech.pts.common.cluster.VaultClusterConfig;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.hazelcast.core.HazelcastInstance;
import com.hazelcast.map.IMap;

/** The two ATC compare-and-advance implementations (S6.1 step 4, S8.2). */
public final class AtcGuards {

    private AtcGuards() {
    }

    /**
     * Baseline: a conditional {@code UPDATE ... WHERE last_atc < ?} in the database.
     *
     * <p>Durable and atomic, at the cost of a third synchronous round trip on the hot path. The
     * predicate is what makes it safe under concurrency -- a read-then-write would race.
     */
    public static class Jdbc implements AtcGuard {

        private final VaultRepository vaultRepository;

        public Jdbc(VaultRepository vaultRepository) {
            this.vaultRepository = vaultRepository;
        }

        @Override
        public boolean checkAndAdvance(String tokenPan, int atc) {
            return vaultRepository.compareAndAdvanceAtc(tokenPan, atc);
        }

        @Override
        public String describe() {
            return "DB (conditional UPDATE, durable, one synchronous round trip)";
        }
    }

    /**
     * Optimized: an entry processor on the partition owner, with write-behind to the database.
     *
     * <p>Removes the third synchronous round trip. The trade-off is explicit and bounded: the replay
     * window equals the write-behind lag, and the mitigations are documented on
     * {@link com.adxztech.pts.common.cluster.AtcMapStore}. It is the one place in this design where a
     * durability guarantee is genuinely traded for latency, so it is worth being able to state the
     * bound rather than hand-waving it.
     */
    public static class Cluster implements AtcGuard {

        private final IMap<String, Integer> atcMap;

        public Cluster(HazelcastInstance hazelcast) {
            this.atcMap = hazelcast.getMap(VaultClusterConfig.MAP_ATC);
        }

        @Override
        public boolean checkAndAdvance(String tokenPan, int atc) {
            Boolean advanced = atcMap.executeOnKey(tokenPan, new AtcAdvanceProcessor(atc));
            return Boolean.TRUE.equals(advanced);
        }

        @Override
        public String describe() {
            return "CLUSTER (entry processor on the partition owner, write-behind to the vault)";
        }
    }
}
