package com.adxztech.pts.common.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

/**
 * {@code POST /v1/cards/update} body -- the card reissue / expiry refresh flow (S5.5).
 *
 * <p>This is the flow that eliminates a whole class of avoidable declines: the plastic changes, the
 * token does not, and every wallet and card-on-file merchant keeps working untouched.
 */
public record CardUpdateRequest(

        @NotBlank(message = "oldFundingPan is required")
        String oldFundingPan,

        @NotBlank(message = "newFundingPan is required")
        String newFundingPan,

        @NotBlank(message = "newExpiry is required")
        @Pattern(regexp = "\\d{4}", message = "newExpiry must be YYMM")
        String newExpiry) {
}
