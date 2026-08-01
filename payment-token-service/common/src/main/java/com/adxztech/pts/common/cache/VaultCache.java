package com.adxztech.pts.common.cache;

import com.adxztech.pts.common.vault.VaultRecord;

import java.util.Optional;

/**
 * Read accelerator for vault records -- <b>not</b> the record of truth (S8.3).
 *
 * <p>Oracle remains authoritative. This cache exists to delete a network round trip from the
 * authorization path, and every implementation must preserve two properties:
 *
 * <ul>
 *   <li><b>A miss is never an error.</b> It falls through to the database (read-through), so
 *       correctness survives a cold start, a deploy or a failover -- only latency degrades.</li>
 *   <li><b>A lifecycle write is visible immediately.</b> Writes are pushed through
 *       ({@link #put}) and near-caches are invalidated cluster-wide, so a token suspended for fraud
 *       stops authorizing within milliseconds rather than at the end of a TTL (S8.4).</li>
 * </ul>
 */
public interface VaultCache {

    Optional<VaultRecord> get(String tokenPan);

    /** Write-through: makes a lifecycle change visible to the authorization path immediately. */
    void put(VaultRecord record);

    /** Drops an entry without touching the database. */
    void invalidate(String tokenPan);

    /** Describes the strategy for {@code /actuator/info} and the A/B demo. */
    String describe();
}
