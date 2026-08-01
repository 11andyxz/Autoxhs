package com.adxztech.pts.common.api;

/**
 * Risk signal request sent to the issuer during ID&amp;V (S5.2).
 *
 * <p>Note the funding PAN is <b>not</b> sent: only the BIN and last 4. A real ID&amp;V exchange does
 * carry more card data, but the demo keeps PANs off inter-service hops that do not strictly need
 * them, which is the habit that keeps PCI scope small.
 */
public record IdvRiskRequest(String fundingBin,
                             String fundingLast4,
                             String requestorId,
                             String deviceId,
                             String domainType,
                             boolean deviceBound) {
}
