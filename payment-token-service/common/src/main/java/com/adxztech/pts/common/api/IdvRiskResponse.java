package com.adxztech.pts.common.api;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Issuer risk signal (S5.2).
 *
 * @param riskScore 0-99; the provisioning service combines it with local rules to reach a decision
 * @param blocked   hard block from the issuer, overriding the score
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record IdvRiskResponse(int riskScore, boolean blocked, String reason) {
}
