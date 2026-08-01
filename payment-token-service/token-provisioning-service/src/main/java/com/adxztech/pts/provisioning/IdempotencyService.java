package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.persistence.IdempotencyRepository;
import com.adxztech.pts.common.web.ApiExceptions;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;

/**
 * End-to-end idempotency for provisioning (S10.1).
 *
 * <p>Provisioning is mutating and retriable, so a client timeout must not create two tokens for one
 * card. The pattern mirrors the public payment APIs:
 *
 * <ul>
 *   <li><b>Same key, same request</b> -> replay the stored response, including the same
 *       {@code tokenRef}. Storing the <em>response</em> rather than just the key is what makes this
 *       genuinely idempotent instead of merely deduplicated.</li>
 *   <li><b>Same key, different request</b> -> 422. Reusing a key with a different body is a client bug,
 *       and silently honouring it would let one key mask two different intents.</li>
 *   <li><b>Same key, still in flight</b> -> 409. The key is claimed by an insert <em>before</em> the
 *       work starts, so two concurrent retries cannot both provision; the loser is told to wait rather
 *       than being handed a half-finished answer.</li>
 * </ul>
 */
@Component
public class IdempotencyService {

    private static final Logger log = LoggerFactory.getLogger(IdempotencyService.class);

    private final IdempotencyRepository repository;
    private final ObjectMapper objectMapper;

    public IdempotencyService(IdempotencyRepository repository, ObjectMapper objectMapper) {
        this.repository = repository;
        this.objectMapper = objectMapper;
    }

    /**
     * Claims the key or reports a replay.
     *
     * @return the stored response when this is a replay of a completed request; empty when the caller
     *         now owns the work
     * @throws ApiExceptions.UnprocessableException the key was used with a different request body
     * @throws ApiExceptions.ConflictException      the key is claimed by an in-flight request
     */
    public Optional<String> claim(String key, Object request) {
        byte[] hash = hashOf(request);

        Optional<IdempotencyRepository.IdemRow> existing = repository.find(key);
        if (existing.isEmpty()) {
            if (repository.tryClaim(key, hash)) {
                return Optional.empty();
            }
            // Lost the insert race; fall through and evaluate whatever the winner stored.
            existing = repository.find(key);
        }

        IdempotencyRepository.IdemRow row = existing.orElseThrow(() ->
                new ApiExceptions.ConflictException("idempotency key " + key + " is being processed"));

        if (!MessageDigest.isEqual(row.requestHash(), hash)) {
            throw new ApiExceptions.UnprocessableException(
                    "Idempotency-Key " + key + " was already used with a different request body");
        }
        if (row.response() == null) {
            throw new ApiExceptions.ConflictException(
                    "Idempotency-Key " + key + " is already being processed; retry shortly");
        }
        log.info("replaying stored response for Idempotency-Key {}", key);
        return Optional.of(row.response());
    }

    public void complete(String key, Object response) {
        repository.storeResponse(key, serialize(response));
    }

    /** Releases the claim so a genuine retry is not blocked by a failed attempt. */
    public void abandon(String key) {
        repository.release(key);
    }

    public <T> T deserialize(String json, Class<T> type) {
        try {
            return objectMapper.readValue(json, type);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("cannot read stored idempotent response", e);
        }
    }

    /** Keys expire after 24h (S10.1). */
    public int purgeExpired() {
        return repository.deleteOlderThan(Instant.now().minus(24, ChronoUnit.HOURS));
    }

    private byte[] hashOf(Object request) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(serialize(request).getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private String serialize(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("cannot serialise value for idempotency store", e);
        }
    }
}
