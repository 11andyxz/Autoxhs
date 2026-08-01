package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.api.TokenView;
import com.adxztech.pts.common.vault.VaultRecord;

/**
 * Maps a vault record to its API view.
 *
 * <p>The mapping is where PCI scope is enforced in practice: it copies {@code tokenLast4} and
 * {@code fundingLast4} and has no path by which the token PAN or the funding ciphertext can reach a
 * response body. Keeping that in one function makes it reviewable.
 */
final class TokenViews {

    private TokenViews() {
    }

    static TokenView of(VaultRecord record) {
        return new TokenView(
                record.tokenRef(),
                record.tokenLast4(),
                record.tokenExpiry(),
                record.status().name(),
                record.requestorId(),
                record.domainType().name(),
                record.issuerId(),
                record.deviceId(),
                record.fundingLast4(),
                record.fundingExpiry(),
                record.lastAtc(),
                record.keyVersion(),
                record.updatedAt() == null ? null : record.updatedAt().toString());
    }
}
