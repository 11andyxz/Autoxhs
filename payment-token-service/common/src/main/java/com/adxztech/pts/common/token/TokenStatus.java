package com.adxztech.pts.common.token;

/**
 * Token lifecycle states (S4.1, S4.3).
 *
 * <p>{@link #DELETED} is terminal and is a <em>domain</em> delete: the row survives as a tombstone
 * for audit. Physical purging is a separate, out-of-band retention job (S5.4).
 */
public enum TokenStatus {

    /** ID&amp;V returned STEP_UP; the token exists but cannot authorize until OTP completes. */
    PENDING_IDV,

    /** The only state in which detokenization may return a funding PAN. */
    ACTIVE,

    /** Suspended by issuer or wallet; reversible via RESUME. */
    SUSPENDED,

    /** Terminal tombstone. */
    DELETED;

    /** @return whether a token in this state is allowed to authorize (S6.1 step 2). */
    public boolean canAuthorize() {
        return this == ACTIVE;
    }
}
