package com.adxztech.pts.common.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

/** {@code POST /v1/tokens/{tokenRef}/idv/verify} body (S5.3). */
public record IdvVerifyRequest(

        @NotBlank(message = "idvSessionId is required")
        String idvSessionId,

        @NotBlank(message = "otp is required")
        @Pattern(regexp = "\\d{6}", message = "otp must be 6 digits")
        String otp) {
}
