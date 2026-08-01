package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.api.EventType;
import com.adxztech.pts.common.api.LifecycleEvent;
import com.adxztech.pts.common.cache.VaultCache;
import com.adxztech.pts.common.persistence.OutboxRepository;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.vault.VaultRecord;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;
import java.util.List;

/**
 * The one place a vault change is committed (S4.3, S8.4).
 *
 * <p>Every state change is a single database transaction that does two things atomically:
 * <ol>
 *   <li>updates {@code token_vault};</li>
 *   <li>inserts the lifecycle event into {@code token_outbox}.</li>
 * </ol>
 * and then, <b>after the transaction commits</b>, pushes the new record into the cache.
 *
 * <p><b>Why the cache write is after commit and not inside the transaction.</b> Pushing before commit
 * publishes state that may never exist: if the transaction rolls back, the authorization path is left
 * holding a phantom record -- in the worst case an ACTIVE token that the vault never accepted. Ordering
 * it after commit means the cache can only ever be <em>behind</em> the vault, never ahead of it, and
 * "behind" is a bounded, detectable condition (TTL plus the reconciliation sweep) whereas "ahead" is a
 * correctness failure.
 *
 * <p>The residual risk is a crash in the window between commit and push. That is what
 * {@code CacheReconciliationJob} exists for, and it is the honest answer to "what is the biggest risk
 * in this design" (S16).
 */
@Component
public class VaultWriter {

    private static final Logger log = LoggerFactory.getLogger(VaultWriter.class);

    private final VaultRepository vaultRepository;
    private final OutboxRepository outboxRepository;
    private final VaultCache vaultCache;
    private final ObjectMapper objectMapper;

    public VaultWriter(VaultRepository vaultRepository,
                       OutboxRepository outboxRepository,
                       VaultCache vaultCache,
                       ObjectMapper objectMapper) {
        this.vaultRepository = vaultRepository;
        this.outboxRepository = outboxRepository;
        this.vaultCache = vaultCache;
        this.objectMapper = objectMapper;
    }

    /** Provisioning: insert the row, queue its events, then publish to the cache. */
    @Transactional
    public void createToken(VaultRecord record, List<EventType> eventTypes) {
        createToken(record, eventTypes, null);
    }

    /**
     * Provisioning with extra work that must share the transaction -- specifically, the OTP step-up
     * session. Committing the token without its session would leave a {@code PENDING_IDV} token that
     * nobody can ever activate.
     */
    @Transactional
    public void createToken(VaultRecord record, List<EventType> eventTypes, Runnable inTransaction) {
        vaultRepository.insert(record);
        if (inTransaction != null) {
            inTransaction.run();
        }
        queueEvents(record, eventTypes);
        pushAfterCommit(record);
    }

    /** A lifecycle transition: the new status, its event, then the cache. */
    @Transactional
    public VaultRecord applyStatus(VaultRecord current, com.adxztech.pts.common.token.TokenStatus newStatus,
                                   EventType eventType) {
        Instant now = Instant.now();
        VaultRecord updated = current.withStatus(newStatus, now);
        int rows = vaultRepository.updateStatus(current.tokenRef(), newStatus, now);
        if (rows != 1) {
            throw new IllegalStateException(
                    "vault row for tokenRef " + current.tokenRef() + " disappeared mid-transition");
        }
        queueEvents(updated, List.of(eventType));
        pushAfterCommit(updated);
        return updated;
    }

    /** Card reissue: new funding data under the same token PAN (S5.5). */
    @Transactional
    public VaultRecord applyFundingUpdate(VaultRecord current, byte[] fundingPanEnc, byte[] fingerprint,
                                          String last4, String expiry, int keyVersion) {
        Instant now = Instant.now();
        VaultRecord updated = current.withFunding(fundingPanEnc, fingerprint, last4, expiry, keyVersion, now);
        int rows = vaultRepository.updateFunding(current.tokenPan(), fundingPanEnc, fingerprint,
                last4, expiry, keyVersion, now);
        if (rows != 1) {
            throw new IllegalStateException(
                    "vault row for token " + current.tokenRef() + " disappeared mid-update");
        }
        queueEvents(updated, List.of(EventType.CARD_UPDATED));
        pushAfterCommit(updated);
        return updated;
    }

    private void queueEvents(VaultRecord record, List<EventType> eventTypes) {
        for (EventType type : eventTypes) {
            LifecycleEvent event = LifecycleEvent.of(type, record.tokenRef(), record.tokenLast4(),
                    record.requestorId());
            outboxRepository.insert(event.eventId(), event.tokenRef(), event.eventType(),
                    serialize(event));
        }
    }

    private String serialize(LifecycleEvent event) {
        try {
            return objectMapper.writeValueAsString(event);
        } catch (JsonProcessingException e) {
            // Cannot happen for this record type, and if it somehow did, failing the transaction is
            // strictly better than committing a state change nobody downstream will hear about.
            throw new IllegalStateException("cannot serialise lifecycle event", e);
        }
    }

    private void pushAfterCommit(VaultRecord record) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            vaultCache.put(record);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                vaultCache.put(record);
                log.debug("cache write-through after commit: {} -> {}",
                        record.tokenRef(), record.status());
            }
        });
    }
}
