package com.adxztech.pts.common.token;

/**
 * Raised when a lifecycle operation is not legal from the token's current state. Surfaces as
 * HTTP 409 Conflict (S4.3, S5.4).
 */
public class IllegalTransitionException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final TokenStatus from;
    private final LifecycleOp op;

    public IllegalTransitionException(TokenStatus from, LifecycleOp op) {
        super("illegal transition: " + from + " --" + op + "-->");
        this.from = from;
        this.op = op;
    }

    public TokenStatus from() {
        return from;
    }

    public LifecycleOp op() {
        return op;
    }
}
