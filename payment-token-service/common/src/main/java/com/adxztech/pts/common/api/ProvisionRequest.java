package com.adxztech.pts.common.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

/**
 * {@code POST /v1/tokens} body (S5.1).
 *
 * <p>{@code deviceId} present implies DPAN semantics (a token bound to one device) rather than a
 * card-on-file token.
 */
public record ProvisionRequest(

        @NotBlank(message = "fundingPan is required")
        String fundingPan,

        @NotBlank(message = "expiry is required")
        @Pattern(regexp = "\\d{4}", message = "expiry must be YYMM")
        String expiry,

        String cardholderName,

        @NotBlank(message = "requestorId is required")
        @Pattern(regexp = "\\d{11}", message = "requestorId must be 11 digits")
        String requestorId,

        @NotBlank(message = "domainType is required")
        @Pattern(regexp = "CONTACTLESS|ECOM", message = "domainType must be CONTACTLESS or ECOM")
        String domainType,

        String deviceId,

        String idvChannel) {

    /** @return true when the request provisions a device-bound token (DPAN). */
    public boolean isDeviceBound() {
        return deviceId != null && !deviceId.isBlank();
    }
}
