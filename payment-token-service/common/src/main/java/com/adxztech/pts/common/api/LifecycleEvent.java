package com.adxztech.pts.common.api;

import java.time.Instant;
import java.util.UUID;

/**
 * The lifecycle event published to {@code token.lifecycle} (S10.3).
 *
 * <p>Contains <b>no PAN and no full token</b> -- only {@code tokenRef} and {@code tokenLast4} -- so
 * downstream risk, reporting and issuer-notification consumers are outside PCI scope by construction.
 * {@code schemaVersion} exists so a new field can be added without breaking existing consumers.
 *
 * <p>{@code eventId} is the consumer's dedupe key: at-least-once delivery plus dedupe on this field
 * yields exactly-once <em>effect</em> (S10.2).
 */
public record LifecycleEvent(String eventId,
                             String eventType,
                             String tokenRef,
                             String tokenLast4,
                             String requestorId,
                             String occurredAt,
                             int schemaVersion) {

    public static final int CURRENT_SCHEMA_VERSION = 1;

    public static LifecycleEvent of(EventType type, String tokenRef, String tokenLast4, String requestorId) {
        return new LifecycleEvent(UUID.randomUUID().toString(), type.name(), tokenRef, tokenLast4,
                requestorId, Instant.now().toString(), CURRENT_SCHEMA_VERSION);
    }
}
