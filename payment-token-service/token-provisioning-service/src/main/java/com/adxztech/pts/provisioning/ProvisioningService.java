package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.api.EventType;
import com.adxztech.pts.common.api.IdvDecision;
import com.adxztech.pts.common.api.ProvisionRequest;
import com.adxztech.pts.common.api.ProvisionResponse;
import com.adxztech.pts.common.crypto.DekVersion;
import com.adxztech.pts.common.crypto.EnvelopeCipher;
import com.adxztech.pts.common.crypto.JdbcDekRegistry;
import com.adxztech.pts.common.crypto.PanFingerprint;
import com.adxztech.pts.common.pan.InvalidPanException;
import com.adxztech.pts.common.pan.Pan;
import com.adxztech.pts.common.persistence.BinMapRepository;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.token.DomainType;
import com.adxztech.pts.common.token.FundingBinRange;
import com.adxztech.pts.common.token.TokenBinRange;
import com.adxztech.pts.common.token.TokenPanAllocator;
import com.adxztech.pts.common.token.TokenStatus;
import com.adxztech.pts.common.vault.VaultRecord;
import com.adxztech.pts.common.web.ApiExceptions;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.YearMonth;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Provisioning: ID&amp;V, token allocation, envelope encryption and the first lifecycle events (S5.1).
 */
@Service
public class ProvisioningService {

    private static final Logger log = LoggerFactory.getLogger(ProvisioningService.class);

    /** Token PAN uniqueness is arbitrated by the vault primary key; collisions are retried. */
    private static final int ALLOCATION_ATTEMPTS = 5;

    private final IdvDecisionEngine idvEngine;
    private final OtpService otpService;
    private final VaultWriter vaultWriter;
    private final VaultRepository vaultRepository;
    private final BinMapRepository binMapRepository;
    private final TokenPanAllocator tokenPanAllocator;
    private final EnvelopeCipher envelopeCipher;
    private final PanFingerprint panFingerprint;
    private final JdbcDekRegistry dekRegistry;
    private final Counter approved;
    private final Counter steppedUp;
    private final Counter declined;

    public ProvisioningService(IdvDecisionEngine idvEngine,
                               OtpService otpService,
                               VaultWriter vaultWriter,
                               VaultRepository vaultRepository,
                               BinMapRepository binMapRepository,
                               TokenPanAllocator tokenPanAllocator,
                               EnvelopeCipher envelopeCipher,
                               PanFingerprint panFingerprint,
                               JdbcDekRegistry dekRegistry,
                               MeterRegistry meterRegistry) {
        this.idvEngine = idvEngine;
        this.otpService = otpService;
        this.vaultWriter = vaultWriter;
        this.vaultRepository = vaultRepository;
        this.binMapRepository = binMapRepository;
        this.tokenPanAllocator = tokenPanAllocator;
        this.envelopeCipher = envelopeCipher;
        this.panFingerprint = panFingerprint;
        this.dekRegistry = dekRegistry;
        this.approved = Counter.builder("pts.provisioning.decision")
                .tag("decision", "APPROVE").register(meterRegistry);
        this.steppedUp = Counter.builder("pts.provisioning.decision")
                .tag("decision", "STEP_UP").register(meterRegistry);
        this.declined = Counter.builder("pts.provisioning.decision")
                .tag("decision", "DECLINE").register(meterRegistry);
    }

    /** HTTP status is derived from the decision, so a replayed response reproduces it exactly. */
    public static int statusFor(ProvisionResponse response) {
        return switch (IdvDecision.valueOf(response.decision())) {
            case APPROVE -> 201;
            case STEP_UP -> 202;
            case DECLINE -> 200;
        };
    }

    public ProvisionResponse provision(ProvisionRequest request) {
        Pan fundingPan = Pan.of(request.fundingPan());
        requireFutureExpiry(request.expiry());
        DomainType domain = DomainType.parse(request.domainType());

        FundingBinRange fundingRange = binMapRepository.findFundingRange(fundingPan.bin8())
                .orElseThrow(() -> new IllegalArgumentException(
                        "funding BIN " + fundingPan.bin(8) + " is not onboarded"));

        IdvDecisionEngine.Outcome outcome = idvEngine.decide(request, fundingPan, fundingRange);

        if (outcome.decision() == IdvDecision.DECLINE) {
            declined.increment();
            // Nothing is persisted beyond the audit trail: no vault row exists for a declined
            // provisioning attempt, so there is nothing to clean up later (S5.1 step 4).
            log.info("provisioning DECLINED for card {} requestor {}: {}",
                    fundingPan.masked(), request.requestorId(), outcome.reason());
            return ProvisionResponse.declined(outcome.reason());
        }

        TokenBinRange tokenRange = binMapRepository.findTokenRangeByIssuer(fundingRange.issuerId())
                .orElseThrow(() -> new IllegalStateException(
                        "issuer " + fundingRange.issuerId() + " has no token BIN range configured"));

        boolean stepUp = outcome.decision() == IdvDecision.STEP_UP;
        TokenStatus initialStatus = stepUp ? TokenStatus.PENDING_IDV : TokenStatus.ACTIVE;
        List<EventType> events = stepUp
                ? List.of(EventType.PROVISIONED)
                : List.of(EventType.PROVISIONED, EventType.ACTIVATED);

        Allocation allocation = allocate(request, fundingPan, fundingRange, tokenRange, domain,
                initialStatus, events, stepUp);

        if (stepUp) {
            steppedUp.increment();
            log.info("provisioning STEP_UP: tokenRef={} session={} ({})",
                    allocation.record().tokenRef(), allocation.stepUpSessionId(), outcome.reason());
            return ProvisionResponse.stepUp(allocation.record().tokenRef(),
                    allocation.record().tokenLast4(), allocation.record().tokenExpiry(),
                    allocation.stepUpSessionId(), request.idvChannel() == null ? "SMS" : request.idvChannel());
        }
        approved.increment();
        log.info("provisioning APPROVED: tokenRef={} tokenLast4={} issuer={} ({})",
                allocation.record().tokenRef(), allocation.record().tokenLast4(),
                fundingRange.issuerId(), outcome.reason());
        return ProvisionResponse.approved(allocation.record().tokenRef(),
                allocation.record().tokenLast4(), allocation.record().tokenExpiry());
    }

    private record Allocation(VaultRecord record, String stepUpSessionId) {
    }

    /**
     * Allocates a token PAN and commits the vault row, retrying on the (vanishingly rare) primary-key
     * collision rather than pre-checking for one. Pre-checking would be a race; the primary key is not.
     */
    private Allocation allocate(ProvisionRequest request, Pan fundingPan, FundingBinRange fundingRange,
                                TokenBinRange tokenRange, DomainType domain, TokenStatus initialStatus,
                                List<EventType> events, boolean stepUp) {
        DekVersion dek = dekRegistry.active();
        byte[] fingerprint = panFingerprint.compute(fundingPan);
        String tokenExpiry = TokenPanAllocator.deriveTokenExpiry(request.expiry());

        DuplicateKeyException lastCollision = null;
        for (int attempt = 1; attempt <= ALLOCATION_ATTEMPTS; attempt++) {
            String tokenPan = tokenPanAllocator.allocate(tokenRange);
            // The token PAN is the AAD, so this ciphertext is not portable to another vault row.
            byte[] sealed = envelopeCipher.seal(dek.key(), fundingPan.value(), tokenPan);
            Instant now = Instant.now();
            VaultRecord record = new VaultRecord(
                    tokenPan, UUID.randomUUID().toString(), Long.parseLong(tokenPan.substring(0, 8)),
                    sealed, fingerprint, fundingPan.last4(), request.expiry(), tokenExpiry,
                    initialStatus, request.requestorId(), domain, fundingRange.issuerId(),
                    request.deviceId(), 0, dek.version(), now, now);

            OtpService.PendingStepUp pending =
                    stepUp ? otpService.prepareStepUp(record.tokenRef(), request.idvChannel()) : null;

            try {
                vaultWriter.createToken(record, events,
                        pending == null ? null : () -> otpService.persist(pending));
                return new Allocation(record, pending == null ? null : pending.sessionId());
            } catch (DuplicateKeyException e) {
                lastCollision = e;
                log.warn("token PAN collision on attempt {}/{}, reallocating",
                        attempt, ALLOCATION_ATTEMPTS);
            }
        }
        throw new IllegalStateException(
                "could not allocate a unique token PAN in " + ALLOCATION_ATTEMPTS + " attempts",
                lastCollision);
    }

    /** Completes OTP step-up: {@code PENDING_IDV -> ACTIVE} in one transaction (S5.3). */
    public ProvisionResponse completeStepUp(String tokenRef, String sessionId, String otp) {
        VaultRecord record = vaultRepository.findByTokenRef(tokenRef)
                .orElseThrow(() -> new ApiExceptions.NotFoundException("unknown tokenRef " + tokenRef));

        OtpService.VerifyResult result = otpService.verify(sessionId, tokenRef, otp);
        switch (result) {
            case OK -> { /* fall through to activation */ }
            case UNKNOWN_SESSION -> throw new ApiExceptions.NotFoundException(
                    "unknown or already-completed ID&V session " + sessionId);
            case SESSION_TOKEN_MISMATCH -> throw new ApiExceptions.UnprocessableException(
                    "ID&V session " + sessionId + " does not belong to token " + tokenRef);
            case EXPIRED -> throw new ApiExceptions.UnprocessableException(
                    "ID&V session expired; provisioning must be retried");
            case ATTEMPTS_EXHAUSTED -> throw new ApiExceptions.UnprocessableException(
                    "OTP attempt limit reached; the session has been invalidated");
            case WRONG_CODE -> throw new ApiExceptions.UnprocessableException("incorrect OTP");
        }

        // The state machine is the arbiter: an already-ACTIVE token yields 409, not a second ACTIVATED
        // event.
        TokenStatus next = com.adxztech.pts.common.token.TokenStateMachine.next(
                record.status(), com.adxztech.pts.common.token.LifecycleOp.ACTIVATE);
        VaultRecord activated = vaultWriter.applyStatus(record, next, EventType.ACTIVATED);
        log.info("ID&V step-up completed: tokenRef={} now {}", tokenRef, activated.status());
        return ProvisionResponse.approved(activated.tokenRef(), activated.tokenLast4(),
                activated.tokenExpiry());
    }

    public Optional<VaultRecord> findByRef(String tokenRef) {
        return vaultRepository.findByTokenRef(tokenRef);
    }

    private void requireFutureExpiry(String yymm) {
        int year = 2000 + Integer.parseInt(yymm.substring(0, 2));
        int month = Integer.parseInt(yymm.substring(2, 4));
        if (month < 1 || month > 12) {
            throw new InvalidPanException("expiry month out of range: " + yymm);
        }
        if (YearMonth.of(year, month).isBefore(YearMonth.now())) {
            throw new InvalidPanException("funding card expiry " + yymm + " is in the past");
        }
    }
}
