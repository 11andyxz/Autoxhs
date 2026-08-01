package com.adxztech.pts.common.cluster;

import com.hazelcast.map.EntryProcessor;

import java.io.Serializable;
import java.util.Map;

/**
 * Atomic ATC compare-and-advance, executed on the partition owner (S6.1 step 4, S8.2).
 *
 * <p>An entry processor rather than a get-then-put: Hazelcast runs it on the partition thread that
 * owns the key, so the read and the write are a single serialized operation. Two authorizations
 * presenting the same ATC concurrently therefore cannot both succeed -- one advances, the other is
 * told the counter did not move and is rejected as a replay.
 *
 * <p>Doing this client-side with {@code get} then {@code replace} would need a retry loop and would
 * cost two hops instead of one. Doing it with a plain {@code put} would lose the guard entirely.
 *
 * <p>This class travels to the member, which is why the members run the project's own jar rather than
 * a stock Hazelcast image (see {@link VaultClusterConfig}).
 */
public class AtcAdvanceProcessor implements EntryProcessor<String, Integer, Boolean>, Serializable {

    private static final long serialVersionUID = 1L;

    private final int presentedAtc;

    public AtcAdvanceProcessor(int presentedAtc) {
        this.presentedAtc = presentedAtc;
    }

    /**
     * @return {@code TRUE} when the counter advanced, {@code FALSE} when the presented ATC was not
     *         greater than the stored one
     */
    @Override
    public Boolean process(Map.Entry<String, Integer> entry) {
        Integer current = entry.getValue(); // triggers MapStore.load for a cold entry
        if (current != null && presentedAtc <= current) {
            return Boolean.FALSE;
        }
        entry.setValue(presentedAtc);
        return Boolean.TRUE;
    }
}
