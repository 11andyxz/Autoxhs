package com.adxztech.pts.common.event;

import com.adxztech.pts.common.api.LifecycleEvent;

/**
 * Publishes lifecycle events read from the outbox (S10.2).
 *
 * <p>Deliberately an interface with three implementations. The outbox pattern, the idempotent
 * producer configuration and the consumer-side dedupe are all separable concerns, and only one of
 * them needs a broker to exist:
 *
 * <ul>
 *   <li>{@code InMemoryEventBroker} -- unit tests and single-JVM integration tests.</li>
 *   <li>{@code HttpEventBroker} -- the local multi-process stack, which has no Kafka. Delivery is
 *       at-least-once with a deliberately injectable duplicate, which is how the consumer's dedupe
 *       gets proven without standing up a broker.</li>
 *   <li>{@code KafkaEventBroker} -- the Docker Compose stack, with {@code enable.idempotence=true}.</li>
 * </ul>
 *
 * The exactly-once <em>effect</em> claim survives all three, because it rests on the outbox plus the
 * consumer dedupe rather than on any broker feature.
 */
public interface EventBroker {

    /**
     * Publishes one event. Throwing means "not published" -- the outbox row stays pending and the
     * poller retries, which is the whole point of the outbox.
     */
    void publish(LifecycleEvent event);

    String describe();
}
