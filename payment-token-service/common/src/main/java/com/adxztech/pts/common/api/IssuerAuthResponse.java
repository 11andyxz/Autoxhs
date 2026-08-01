package com.adxztech.pts.common.api;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Issuer authorization decision.
 *
 * @param responseCode the DE 39 value the switch relays unchanged ({@code 00} = approved)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record IssuerAuthResponse(String responseCode, String authCode, String reason) {

    public boolean approved() {
        return "00".equals(responseCode);
    }
}
