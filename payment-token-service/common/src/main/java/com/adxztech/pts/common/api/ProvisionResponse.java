package com.adxztech.pts.common.api;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Provisioning result (S5.1).
 *
 * <p>Note what is <em>absent</em>: the token PAN. APIs speak {@code tokenRef} (an opaque UUID) and
 * {@code tokenLast4}; the token itself only ever travels on the authorization rails. That is a PCI
 * scope decision, not a stylistic one.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ProvisionResponse(String tokenRef,
                                String tokenLast4,
                                String status,
                                String tokenExpiry,
                                String decision,
                                String idvSessionId,
                                String idvChannel,
                                String reason) {

    public static ProvisionResponse approved(String tokenRef, String tokenLast4, String tokenExpiry) {
        return new ProvisionResponse(tokenRef, tokenLast4, "ACTIVE", tokenExpiry,
                IdvDecision.APPROVE.name(), null, null, null);
    }

    public static ProvisionResponse stepUp(String tokenRef, String tokenLast4, String tokenExpiry,
                                           String idvSessionId, String idvChannel) {
        return new ProvisionResponse(tokenRef, tokenLast4, "PENDING_IDV", tokenExpiry,
                IdvDecision.STEP_UP.name(), idvSessionId, idvChannel, null);
    }

    public static ProvisionResponse declined(String reason) {
        return new ProvisionResponse(null, null, null, null,
                IdvDecision.DECLINE.name(), null, null, reason);
    }
}
