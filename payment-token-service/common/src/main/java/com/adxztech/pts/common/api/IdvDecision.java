package com.adxztech.pts.common.api;

/**
 * The ID&amp;V decision contract (S5.2) -- the industry's green / yellow / red path.
 *
 * <p>What is being modelled here is the <em>decision contract and its state consequences</em>, not a
 * fraud model: APPROVE provisions immediately, STEP_UP parks the token in {@code PENDING_IDV} behind
 * an OTP, DECLINE persists nothing but an audit record.
 */
public enum IdvDecision {
    APPROVE,
    STEP_UP,
    DECLINE
}
