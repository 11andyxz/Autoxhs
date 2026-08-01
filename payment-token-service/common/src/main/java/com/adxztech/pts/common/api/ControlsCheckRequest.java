package com.adxztech.pts.common.api;

import jakarta.validation.constraints.NotBlank;

/**
 * {@code POST /internal/controls/check} body.
 *
 * <p>This request only exists in the <em>baseline</em> architecture. It models the pre-optimization
 * world where token status and domain restrictions lived in their own service, so detokenization had
 * to make a second synchronous round trip to evaluate them (S8.1). Turning on
 * {@code detok.controls.inline} deletes this hop entirely.
 */
public record ControlsCheckRequest(

        @NotBlank(message = "tokenPan is required")
        String tokenPan,

        @NotBlank(message = "requestorId is required")
        String requestorId,

        @NotBlank(message = "domainType is required")
        String domainType) {
}
