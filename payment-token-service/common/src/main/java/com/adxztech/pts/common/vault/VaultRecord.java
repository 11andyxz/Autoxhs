package com.adxztech.pts.common.vault;

import com.adxztech.pts.common.token.DomainType;
import com.adxztech.pts.common.token.TokenStatus;

import java.io.Serializable;
import java.time.Instant;
import java.util.Objects;

/**
 * One {@code token_vault} row -- and the unit cached in the Hazelcast {@code vault-records} IMap
 * (S3.1, S4.1).
 *
 * <p><b>Why the funding PAN stays encrypted in here.</b> The cached record carries
 * {@code fundingPanEnc}, never plaintext. The latency win of the near-cache comes from removing the
 * <em>network round trip</em>, not from pre-decrypting: decryption is in-process, sub-millisecond
 * work. Keeping ciphertext in the cache means a heap dump or a cache-replication snoop yields nothing
 * usable without the HSM-held KEK. This is a deliberate improvement over a naive "cache the PAN"
 * design, and it costs nothing measurable.
 *
 * <p><b>Why the controls fields live here at all.</b> {@code status}, {@code requestorId} and
 * {@code domainType} are denormalized onto this record so the domain-restriction gate can be served
 * from the same cached entry instead of a call to token-controls-service. That denormalization
 * <em>is</em> the eliminated synchronous round trip in S8.2.
 *
 * <p>{@link Serializable} because Hazelcast replicates it between members and to near-caches.
 */
public record VaultRecord(String tokenPan,
                          String tokenRef,
                          long tokenBin,
                          byte[] fundingPanEnc,
                          byte[] fundingPanFingerprint,
                          String fundingLast4,
                          String fundingExpiry,
                          String tokenExpiry,
                          TokenStatus status,
                          String requestorId,
                          DomainType domainType,
                          String issuerId,
                          String deviceId,
                          int lastAtc,
                          int keyVersion,
                          Instant createdAt,
                          Instant updatedAt) implements Serializable {

    private static final long serialVersionUID = 1L;

    public VaultRecord {
        Objects.requireNonNull(tokenPan, "tokenPan");
        Objects.requireNonNull(tokenRef, "tokenRef");
        Objects.requireNonNull(fundingPanEnc, "fundingPanEnc");
        Objects.requireNonNull(status, "status");
        Objects.requireNonNull(domainType, "domainType");
    }

    public String tokenLast4() {
        return tokenPan.substring(tokenPan.length() - 4);
    }

    /** @return whether this token may authorize right now (S6.1 step 2). */
    public boolean canAuthorize() {
        return status.canAuthorize();
    }

    /**
     * Domain restriction check (S6.1 step 3) -- the token is bound to one requestor and one usage
     * domain, and is worthless outside them.
     */
    public boolean matchesBinding(String presentedRequestorId, DomainType presentedDomain) {
        return requestorId.equals(presentedRequestorId) && domainType == presentedDomain;
    }

    public VaultRecord withStatus(TokenStatus newStatus, Instant now) {
        return new VaultRecord(tokenPan, tokenRef, tokenBin, fundingPanEnc, fundingPanFingerprint,
                fundingLast4, fundingExpiry, tokenExpiry, newStatus, requestorId, domainType,
                issuerId, deviceId, lastAtc, keyVersion, createdAt, now);
    }

    /** Used by the card reissue flow: same token PAN, new funding card underneath (S5.5). */
    public VaultRecord withFunding(byte[] newEnc, byte[] newFingerprint, String newLast4,
                                   String newExpiry, int newKeyVersion, Instant now) {
        return new VaultRecord(tokenPan, tokenRef, tokenBin, newEnc, newFingerprint,
                newLast4, newExpiry, tokenExpiry, status, requestorId, domainType,
                issuerId, deviceId, lastAtc, newKeyVersion, createdAt, now);
    }

    public VaultRecord withLastAtc(int newAtc) {
        return new VaultRecord(tokenPan, tokenRef, tokenBin, fundingPanEnc, fundingPanFingerprint,
                fundingLast4, fundingExpiry, tokenExpiry, status, requestorId, domainType,
                issuerId, deviceId, newAtc, keyVersion, createdAt, updatedAt);
    }

    /** Never renders the token PAN or any ciphertext. */
    @Override
    public String toString() {
        return "VaultRecord[tokenRef=" + tokenRef + ", tokenLast4=" + tokenLast4()
                + ", status=" + status + ", requestor=" + requestorId + ", domain=" + domainType
                + ", issuer=" + issuerId + ", lastAtc=" + lastAtc + ", keyVersion=" + keyVersion + "]";
    }
}
