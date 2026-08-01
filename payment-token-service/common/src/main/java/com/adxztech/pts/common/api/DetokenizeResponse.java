package com.adxztech.pts.common.api;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Detokenization result (S6.1).
 *
 * <p>{@code PROCEED} carries the funding PAN, which the switch holds in memory only long enough to
 * swap DE 2. On {@code REJECT} the funding PAN is absent and {@code reason} names the gate that
 * failed -- reasons are a closed set ({@link RejectReason}) so they can be a Grafana dimension
 * rather than free text.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DetokenizeResponse(String decision,
                                 String fundingPan,
                                 String fundingExpiry,
                                 String tokenRef,
                                 String issuerId,
                                 String reason) {

    public static final String PROCEED = "PROCEED";
    public static final String REJECT = "REJECT";

    public static DetokenizeResponse proceed(String fundingPan, String fundingExpiry,
                                             String tokenRef, String issuerId) {
        return new DetokenizeResponse(PROCEED, fundingPan, fundingExpiry, tokenRef, issuerId, null);
    }

    public static DetokenizeResponse reject(RejectReason reason) {
        return new DetokenizeResponse(REJECT, null, null, null, null, reason.name());
    }

    public boolean isProceed() {
        return PROCEED.equals(decision);
    }
}
