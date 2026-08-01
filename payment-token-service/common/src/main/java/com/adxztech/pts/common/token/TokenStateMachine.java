package com.adxztech.pts.common.token;

import java.util.EnumMap;
import java.util.Map;
import java.util.Set;

/**
 * The single place token state transitions are decided (S4.3).
 *
 * <p>Keeping the transition table in one class is what lets every caller -- provisioning, OTP
 * completion, issuer-initiated lifecycle, the retention job -- agree on legality, and it is what
 * makes "illegal transition => 409" a property of the system rather than of each controller.
 *
 * <pre>
 *   PENDING_IDV --ACTIVATE--&gt; ACTIVE
 *   ACTIVE      --SUSPEND --&gt; SUSPENDED
 *   SUSPENDED   --RESUME  --&gt; ACTIVE
 *   *           --DELETE  --&gt; DELETED        (except from DELETED, which is terminal)
 * </pre>
 */
public final class TokenStateMachine {

    private static final Map<TokenStatus, Map<LifecycleOp, TokenStatus>> TRANSITIONS;

    static {
        Map<TokenStatus, Map<LifecycleOp, TokenStatus>> t = new EnumMap<>(TokenStatus.class);

        Map<LifecycleOp, TokenStatus> pending = new EnumMap<>(LifecycleOp.class);
        pending.put(LifecycleOp.ACTIVATE, TokenStatus.ACTIVE);
        pending.put(LifecycleOp.DELETE, TokenStatus.DELETED);
        t.put(TokenStatus.PENDING_IDV, pending);

        Map<LifecycleOp, TokenStatus> active = new EnumMap<>(LifecycleOp.class);
        active.put(LifecycleOp.SUSPEND, TokenStatus.SUSPENDED);
        active.put(LifecycleOp.DELETE, TokenStatus.DELETED);
        t.put(TokenStatus.ACTIVE, active);

        Map<LifecycleOp, TokenStatus> suspended = new EnumMap<>(LifecycleOp.class);
        suspended.put(LifecycleOp.RESUME, TokenStatus.ACTIVE);
        suspended.put(LifecycleOp.DELETE, TokenStatus.DELETED);
        t.put(TokenStatus.SUSPENDED, suspended);

        // DELETED is terminal: no operation is legal, not even DELETE (idempotent re-delete would
        // hide a client bug and emit a duplicate lifecycle event).
        t.put(TokenStatus.DELETED, Map.of());

        TRANSITIONS = Map.copyOf(t);
    }

    private TokenStateMachine() {
    }

    /** @return the resulting state, or throws {@link IllegalTransitionException}. */
    public static TokenStatus next(TokenStatus from, LifecycleOp op) {
        TokenStatus to = TRANSITIONS.getOrDefault(from, Map.of()).get(op);
        if (to == null) {
            throw new IllegalTransitionException(from, op);
        }
        return to;
    }

    public static boolean allows(TokenStatus from, LifecycleOp op) {
        return TRANSITIONS.getOrDefault(from, Map.of()).containsKey(op);
    }

    /** @return the operations legal from {@code from} -- handy for HATEOAS-ish responses and tests. */
    public static Set<LifecycleOp> legalOps(TokenStatus from) {
        return TRANSITIONS.getOrDefault(from, Map.of()).keySet();
    }
}
