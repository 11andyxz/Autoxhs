package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.api.LifecycleEvent;
import com.adxztech.pts.common.event.EventBroker;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;

import java.util.concurrent.TimeUnit;

/**
 * Kafka transport for lifecycle events (S10.2).
 *
 * <p>Two producer settings carry the guarantee, and both are set in {@code application.yml} rather than
 * here so they are visible in configuration review:
 *
 * <ul>
 *   <li>{@code enable.idempotence=true} -- the broker deduplicates the producer's own retries, so a
 *       network blip between send and ack does not append the event twice. With
 *       {@code max.in.flight.requests.per.connection<=5} this also preserves ordering.</li>
 *   <li>{@code acks=all} -- an ack means the full in-sync replica set has it, so a leader failure
 *       cannot silently drop an acknowledged event.</li>
 * </ul>
 *
 * <p>The message key is {@code tokenRef}, which puts every event for one token in one partition and
 * therefore in order. That matters: SUSPENDED followed by RESUMED arriving out of order would leave a
 * downstream consumer with exactly the wrong idea about a card.
 *
 * <p>The send is awaited rather than fired and forgotten. The outbox row is only stamped published after
 * this returns, so an unacknowledged send must surface as a failure and leave the row pending.
 */
public class KafkaEventBroker implements EventBroker {

    private static final Logger log = LoggerFactory.getLogger(KafkaEventBroker.class);
    private static final long SEND_TIMEOUT_SECONDS = 10;

    private final KafkaTemplate<String, Object> kafkaTemplate;
    private final String topic;

    public KafkaEventBroker(KafkaTemplate<String, Object> kafkaTemplate, String topic) {
        this.kafkaTemplate = kafkaTemplate;
        this.topic = topic;
    }

    @Override
    public void publish(LifecycleEvent event) {
        try {
            kafkaTemplate.send(topic, event.tokenRef(), event)
                    .get(SEND_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            log.debug("published {} for tokenRef {} to {}", event.eventType(), event.tokenRef(), topic);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted publishing " + event.eventId(), e);
        } catch (Exception e) {
            // Propagate: the poller must leave the outbox row pending and retry.
            throw new IllegalStateException("kafka publish failed for " + event.eventId(), e);
        }
    }

    @Override
    public String describe() {
        return "KAFKA topic=" + topic + " (idempotent producer, key=tokenRef)";
    }
}
