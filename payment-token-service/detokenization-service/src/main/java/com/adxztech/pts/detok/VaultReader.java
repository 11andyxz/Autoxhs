package com.adxztech.pts.detok;

import com.adxztech.pts.common.cache.VaultCache;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.vault.VaultRecord;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;

import java.util.Optional;

/**
 * The single biggest latency lever: how a token resolves to its vault record (S8).
 *
 * <p>Two strategies behind {@code detok.cache.mode}. They are observationally identical -- the
 * integration suite asserts every rejection and acceptance is the same under both -- and differ only in
 * how many network round trips they cost.
 */
public interface VaultReader {

    Optional<VaultRecord> read(String tokenPan);

    String describe();

    /**
     * {@code DIRECT}: a JDBC round trip per authorization.
     *
     * <p>This is the baseline, and it is a real supported mode rather than a straw man -- it is also
     * what the service degrades to if the cache tier is unreachable, so it has to be correct.
     */
    class DirectJdbc implements VaultReader {

        private final VaultRepository vaultRepository;
        private final Counter reads;

        public DirectJdbc(VaultRepository vaultRepository, MeterRegistry meterRegistry) {
            this.vaultRepository = vaultRepository;
            this.reads = Counter.builder("pts.detok.vault_read")
                    .tag("source", "DATABASE")
                    .description("vault resolutions served by a database round trip")
                    .register(meterRegistry);
        }

        @Override
        public Optional<VaultRecord> read(String tokenPan) {
            reads.increment();
            return vaultRepository.findByTokenPan(tokenPan);
        }

        @Override
        public String describe() {
            return "DIRECT (JDBC round trip per authorization)";
        }
    }

    /**
     * {@code NEAR_CACHE}: resolved from the Hazelcast client's in-process near-cache when hot, from the
     * cluster when not, and from the vault via the member's read-through {@code MapLoader} when the
     * cluster does not have it either.
     *
     * <p>Nothing here needs a fallback to the database: the read-through loader <em>is</em> the fallback,
     * and it runs on the member where the partition lives. A client-side fallback would double-read on
     * every genuine miss.
     */
    class NearCache implements VaultReader {

        private final VaultCache vaultCache;
        private final Counter reads;

        public NearCache(VaultCache vaultCache, MeterRegistry meterRegistry) {
            this.vaultCache = vaultCache;
            this.reads = Counter.builder("pts.detok.vault_read")
                    .tag("source", "CLUSTER")
                    .description("vault resolutions served by the cache tier (near-cache or member)")
                    .register(meterRegistry);
        }

        @Override
        public Optional<VaultRecord> read(String tokenPan) {
            reads.increment();
            return vaultCache.get(tokenPan);
        }

        @Override
        public String describe() {
            return "NEAR_CACHE (" + vaultCache.describe() + ", read-through MapLoader on miss)";
        }
    }
}
