package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.api.EventType;
import com.adxztech.pts.common.api.TokenView;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.token.LifecycleOp;
import com.adxztech.pts.common.token.TokenStateMachine;
import com.adxztech.pts.common.token.TokenStatus;
import com.adxztech.pts.common.vault.VaultRecord;
import com.adxztech.pts.common.web.ApiExceptions;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Issuer- and wallet-initiated lifecycle operations (S5.4).
 *
 * <p>Each is one transaction: vault update, outbox event, cache write-through. The state machine
 * decides legality, so "suspend an already-suspended token" is a 409 from one place rather than three
 * slightly different checks in three controllers.
 *
 * <p><b>On DELETE.</b> This is a domain delete: the row is marked {@code DELETED} and kept as an audit
 * tombstone. It is deliberately not a row deletion -- purging tombstones is a separate, out-of-band
 * retention job with its own authorisation, because "the API can erase vault history" is not a property
 * a payment system should have.
 */
@Service
public class LifecycleService {

    private static final Logger log = LoggerFactory.getLogger(LifecycleService.class);

    private final VaultRepository vaultRepository;
    private final VaultWriter vaultWriter;

    public LifecycleService(VaultRepository vaultRepository, VaultWriter vaultWriter) {
        this.vaultRepository = vaultRepository;
        this.vaultWriter = vaultWriter;
    }

    public TokenView suspend(String tokenRef) {
        return transition(tokenRef, LifecycleOp.SUSPEND, EventType.SUSPENDED);
    }

    public TokenView resume(String tokenRef) {
        return transition(tokenRef, LifecycleOp.RESUME, EventType.RESUMED);
    }

    public TokenView delete(String tokenRef) {
        return transition(tokenRef, LifecycleOp.DELETE, EventType.DELETED);
    }

    private TokenView transition(String tokenRef, LifecycleOp op, EventType eventType) {
        VaultRecord current = vaultRepository.findByTokenRef(tokenRef)
                .orElseThrow(() -> new ApiExceptions.NotFoundException("unknown tokenRef " + tokenRef));

        // Throws IllegalTransitionException -> 409, from the single transition table.
        TokenStatus next = TokenStateMachine.next(current.status(), op);
        VaultRecord updated = vaultWriter.applyStatus(current, next, eventType);

        log.info("lifecycle {}: tokenRef={} {} -> {}", op, tokenRef, current.status(), next);
        return TokenViews.of(updated);
    }

    public TokenView view(String tokenRef) {
        return TokenViews.of(vaultRepository.findByTokenRef(tokenRef)
                .orElseThrow(() -> new ApiExceptions.NotFoundException("unknown tokenRef " + tokenRef)));
    }
}
