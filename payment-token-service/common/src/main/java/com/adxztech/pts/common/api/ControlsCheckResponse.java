package com.adxztech.pts.common.api;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Controls verdict. {@code reason} is a {@link RejectReason} name when {@code allowed} is false, so
 * the inline and remote implementations are observationally identical -- which is what lets the
 * integration suite assert the same behaviour across all four flag combinations.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ControlsCheckResponse(boolean allowed, String status, String reason) {

    public static ControlsCheckResponse allow(String status) {
        return new ControlsCheckResponse(true, status, null);
    }

    public static ControlsCheckResponse deny(String status, RejectReason reason) {
        return new ControlsCheckResponse(false, status, reason.name());
    }
}
