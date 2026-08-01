package com.adxztech.pts.common.api;

/** Token lifecycle event types written to the outbox and published to Kafka (S4.2, S10.3). */
public enum EventType {
    PROVISIONED,
    ACTIVATED,
    SUSPENDED,
    RESUMED,
    DELETED,
    CARD_UPDATED
}
