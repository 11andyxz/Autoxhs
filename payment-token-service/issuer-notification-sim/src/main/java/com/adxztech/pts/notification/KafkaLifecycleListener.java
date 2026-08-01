package com.adxztech.pts.notification;

import com.adxztech.pts.common.api.LifecycleEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Kafka ingress for lifecycle events (S10.2), active only in the Compose stack.
 *
 * <p>The consumer is not "exactly once" at the broker level and does not try to be: it is at-least-once
 * delivery plus {@link NotificationHandler}'s durable {@code eventId} dedupe, which is a simpler and more
 * robust construction than transactional consumption -- and it keeps working when the duplicate came from
 * the outbox poller rather than from Kafka.
 */
@Component
@ConditionalOnProperty(name = "notification.kafka.enabled", havingValue = "true")
public class KafkaLifecycleListener {

    private static final Logger log = LoggerFactory.getLogger(KafkaLifecycleListener.class);

    private final NotificationHandler handler;

    public KafkaLifecycleListener(NotificationHandler handler) {
        this.handler = handler;
    }

    @KafkaListener(topics = "${notification.kafka.topic:token.lifecycle}",
            groupId = "${notification.kafka.group-id:issuer-notification-sim}")
    public void onEvent(LifecycleEvent event) {
        log.debug("kafka delivery: {} {}", event.eventType(), event.eventId());
        handler.handle(event);
    }
}
