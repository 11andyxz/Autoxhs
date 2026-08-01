package com.adxztech.pts.common.api;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Read model for {@code GET /v1/tokens/{tokenRef}}.
 *
 * <p>Carries {@code last4} values only -- never the token PAN, never the funding PAN.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TokenView(String tokenRef,
                        String tokenLast4,
                        String tokenExpiry,
                        String status,
                        String requestorId,
                        String domainType,
                        String issuerId,
                        String deviceId,
                        String fundingLast4,
                        String fundingExpiry,
                        int lastAtc,
                        int keyVersion,
                        String updatedAt) {
}
