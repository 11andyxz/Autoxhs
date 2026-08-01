package com.adxztech.pts.common.api;

import com.adxztech.pts.common.iso8583.IsoFields;

/**
 * The closed set of detokenization rejection reasons (S6.1).
 *
 * <p>Each maps to an ISO 8583 response code so the switch's decline is meaningful to the acquirer,
 * and each is a metric dimension so a spike in one reason is visible in Grafana without log diving
 * (S13).
 */
public enum RejectReason {

    /** No vault record for the presented token. */
    TOKEN_NOT_FOUND(IsoFields.RC_INVALID_CARD),

    /** Token exists but is PENDING_IDV, SUSPENDED or DELETED (S6.1 step 2). */
    TOKEN_NOT_ACTIVE(IsoFields.RC_DO_NOT_HONOR),

    /** Requestor or usage domain does not match the binding (S6.1 step 3). */
    DOMAIN_MISMATCH(IsoFields.RC_DO_NOT_HONOR),

    /** ATC did not advance -- a captured cryptogram is being resubmitted (S6.1 step 4). */
    REPLAY_SUSPECTED(IsoFields.RC_SUSPECTED_FRAUD),

    /** Cryptogram failed verification against the HSM-resident key (S6.1 step 5). */
    CRYPTOGRAM_INVALID(IsoFields.RC_SUSPECTED_FRAUD),

    /** The token itself is past its expiry. */
    TOKEN_EXPIRED(IsoFields.RC_EXPIRED_CARD),

    /** Malformed request that survived bean validation. */
    MALFORMED_REQUEST(IsoFields.RC_SYSTEM_ERROR),

    /** Vault ciphertext failed authenticated decryption, or the key version is unavailable. */
    VAULT_ERROR(IsoFields.RC_SYSTEM_ERROR);

    private final String isoResponseCode;

    RejectReason(String isoResponseCode) {
        this.isoResponseCode = isoResponseCode;
    }

    /** @return the DE 39 value the switch should return for this rejection. */
    public String isoResponseCode() {
        return isoResponseCode;
    }
}
