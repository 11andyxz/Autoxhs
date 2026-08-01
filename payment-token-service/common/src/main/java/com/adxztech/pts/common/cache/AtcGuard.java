package com.adxztech.pts.common.cache;

/**
 * Application Transaction Counter monotonicity -- the replay guard (S6.1 step 4).
 *
 * <p>The contract is a compare-and-set, not a read followed by a write: two authorizations presenting
 * the same ATC concurrently must not both succeed. Both implementations honour that atomically, one in
 * the database and one in the cluster.
 */
public interface AtcGuard {

    /**
     * @param tokenPan the token being authorized
     * @param atc      the presented counter
     * @return true when the counter advanced (accept the transaction), false when it did not
     *         (reject as {@code REPLAY_SUSPECTED})
     */
    boolean checkAndAdvance(String tokenPan, int atc);

    String describe();
}
