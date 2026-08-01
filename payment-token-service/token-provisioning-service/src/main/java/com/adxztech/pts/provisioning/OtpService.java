package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.crypto.ConstantTime;
import com.adxztech.pts.common.persistence.IdvSessionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * OTP step-up sessions (S5.3).
 *
 * <p>The code is never stored in the clear: {@code idv_sessions.otp_hash} holds
 * {@code SHA-256(sessionId || ':' || otp)}. Salting with the session id means two concurrent step-ups
 * that happen to draw the same six digits do not share a hash, so one session's stored value cannot be
 * used to complete another.
 *
 * <p>Session creation is split into {@link #prepareStepUp} and {@link #persist} so the insert can join
 * the same transaction that creates the token. Otherwise a failure between the two would leave a token
 * stuck in {@code PENDING_IDV} with no session to complete it.
 */
@Component
public class OtpService {

    private static final Logger log = LoggerFactory.getLogger(OtpService.class);

    private final IdvSessionRepository sessions;
    private final ProvisioningProperties properties;
    private final SecureRandom random = new SecureRandom();

    /**
     * Codes the simulated SMS channel "delivered", for demos and tests only. Never populated unless
     * {@code provisioning.idv.expose-otp-for-demo} is on; a real service has no equivalent.
     */
    private final Map<String, String> demoOtps = new ConcurrentHashMap<>();

    public OtpService(IdvSessionRepository sessions, ProvisioningProperties properties) {
        this.sessions = sessions;
        this.properties = properties;
    }

    /** A step-up session that has been generated but not yet committed. */
    public record PendingStepUp(String sessionId, IdvSessionRepository.IdvSession session, String otp,
                                String channel) {
    }

    /** Outcome of a verification attempt, so each case maps to the right HTTP status. */
    public enum VerifyResult {
        OK,
        WRONG_CODE,
        ATTEMPTS_EXHAUSTED,
        EXPIRED,
        UNKNOWN_SESSION,
        SESSION_TOKEN_MISMATCH
    }

    public PendingStepUp prepareStepUp(String tokenRef, String channel) {
        ProvisioningProperties.Idv rules = properties.getIdv();
        String sessionId = UUID.randomUUID().toString();
        String otp = generateOtp(rules.getOtpLength());
        Instant expiresAt = Instant.now().plusSeconds(rules.getOtpTtlSeconds());
        IdvSessionRepository.IdvSession session = new IdvSessionRepository.IdvSession(
                sessionId, tokenRef, hash(sessionId, otp), 0, expiresAt);
        return new PendingStepUp(sessionId, session, otp, channel == null ? "SMS" : channel);
    }

    /** Commits the session. Call inside the token-creation transaction. */
    public void persist(PendingStepUp pending) {
        sessions.insert(pending.session());
        if (properties.getIdv().isExposeOtpForDemo()) {
            demoOtps.put(pending.sessionId(), pending.otp());
        }
        // The code itself must never reach a log, at any level.
        log.info("ID&V step-up started: session={} tokenRef={} channel={} expiresAt={}",
                pending.sessionId(), pending.session().tokenRef(), pending.channel(),
                pending.session().expiresAt());
    }

    public VerifyResult verify(String sessionId, String tokenRef, String otp) {
        Optional<IdvSessionRepository.IdvSession> found = sessions.find(sessionId);
        if (found.isEmpty()) {
            return VerifyResult.UNKNOWN_SESSION;
        }
        IdvSessionRepository.IdvSession session = found.get();

        if (!session.tokenRef().equals(tokenRef)) {
            // A session belongs to exactly one token. Presenting it for another is a client bug at
            // best, and an attempt to activate someone else's token at worst.
            return VerifyResult.SESSION_TOKEN_MISMATCH;
        }
        if (session.expired(Instant.now())) {
            discard(sessionId);
            return VerifyResult.EXPIRED;
        }
        if (session.attempts() >= properties.getIdv().getOtpMaxAttempts()) {
            discard(sessionId);
            return VerifyResult.ATTEMPTS_EXHAUSTED;
        }
        if (!ConstantTime.equals(session.otpHash(), hash(sessionId, otp))) {
            sessions.incrementAttempts(sessionId);
            int used = session.attempts() + 1;
            if (used >= properties.getIdv().getOtpMaxAttempts()) {
                discard(sessionId);
                log.info("ID&V step-up locked out after {} attempts: session={}", used, sessionId);
                return VerifyResult.ATTEMPTS_EXHAUSTED;
            }
            return VerifyResult.WRONG_CODE;
        }

        discard(sessionId);
        return VerifyResult.OK;
    }

    /** Demo hook; empty unless {@code provisioning.idv.expose-otp-for-demo} is enabled. */
    public Optional<String> peekDemoOtp(String sessionId) {
        return Optional.ofNullable(demoOtps.get(sessionId));
    }

    public boolean demoOtpExposed() {
        return properties.getIdv().isExposeOtpForDemo();
    }

    /** Scheduled cleanup of abandoned step-ups (S5.3). */
    public int purgeExpired() {
        return sessions.deleteExpired(Instant.now());
    }

    private void discard(String sessionId) {
        sessions.delete(sessionId);
        demoOtps.remove(sessionId);
    }

    private String generateOtp(int length) {
        StringBuilder sb = new StringBuilder(length);
        for (int i = 0; i < length; i++) {
            sb.append(random.nextInt(10));
        }
        return sb.toString();
    }

    private byte[] hash(String sessionId, String otp) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest((sessionId + ':' + otp).getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
