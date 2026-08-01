package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.cache.VaultCache;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.vault.VaultRecord;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * Detects and repairs cache/database status drift (S16, "the biggest risk in this design").
 *
 * <p>Write-through plus cluster-wide invalidation makes the cache correct in every ordinary path. The
 * residual risk is narrow but real: a crash in the window between the database commit and the cache
 * push leaves a stale entry until its TTL expires. If the stale field is {@code status}, that means a
 * token that was suspended for fraud could keep authorizing for up to the TTL.
 *
 * <p>This sweep closes that gap: it compares cached status against the vault, repairs any mismatch, and
 * increments a counter that is worth alerting on. A non-zero drift rate is a bug signal, not noise --
 * which is precisely why it is measured rather than assumed to be zero.
 *
 * <p>The demo sweeps the whole vault because it is small. At production scale this becomes a sampled or
 * partition-ranged sweep on the same principle.
 */
@Component
public class CacheReconciliationJob {

    private static final Logger log = LoggerFactory.getLogger(CacheReconciliationJob.class);

    private final VaultRepository vaultRepository;
    private final VaultCache vaultCache;
    private final ProvisioningProperties properties;
    private final Counter driftRepaired;
    private final Counter checked;

    public CacheReconciliationJob(VaultRepository vaultRepository,
                                  VaultCache vaultCache,
                                  ProvisioningProperties properties,
                                  MeterRegistry meterRegistry) {
        this.vaultRepository = vaultRepository;
        this.vaultCache = vaultCache;
        this.properties = properties;
        this.driftRepaired = Counter.builder("pts.cache.drift_repaired")
                .description("cache entries whose status disagreed with the vault and were corrected")
                .register(meterRegistry);
        this.checked = Counter.builder("pts.cache.reconciliation_checked")
                .description("vault rows compared against the cache").register(meterRegistry);
    }

    @Scheduled(fixedDelayString = "${provisioning.reconciliation.interval-ms:60000}",
            initialDelayString = "${provisioning.reconciliation.interval-ms:60000}")
    public void scheduledSweep() {
        if (!properties.getReconciliation().isEnabled()) {
            return;
        }
        int repaired = sweep();
        if (repaired > 0) {
            log.warn("cache reconciliation repaired {} diverged entr{}", repaired,
                    repaired == 1 ? "y" : "ies");
        }
    }

    /** @return the number of entries repaired */
    public int sweep() {
        int repaired = 0;
        for (VaultRecord authoritative : vaultRepository.findAll()) {
            checked.increment();
            Optional<VaultRecord> cached = vaultCache.get(authoritative.tokenPan());
            if (cached.isEmpty()) {
                // Absent is not drift: a miss reads through to the vault and is always correct.
                continue;
            }
            if (cached.get().status() != authoritative.status()) {
                log.warn("cache drift on tokenRef={}: cache={} vault={} -- repairing",
                        authoritative.tokenRef(), cached.get().status(), authoritative.status());
                vaultCache.put(authoritative);
                driftRepaired.increment();
                repaired++;
            }
        }
        return repaired;
    }
}
