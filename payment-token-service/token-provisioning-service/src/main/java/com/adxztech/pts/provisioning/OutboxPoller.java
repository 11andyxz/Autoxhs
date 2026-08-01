package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.api.LifecycleEvent;
import com.adxztech.pts.common.event.EventBroker;
import com.adxztech.pts.common.persistence.OutboxRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Publishes outbox rows to the broker and stamps them published (S10.2).
 *
 * <p><b>Ordering of the two steps is deliberate.</b> Publish first, then stamp. If the process dies in
 * between, the event is republished on restart -- a duplicate, which the idempotent producer and the
 * consumer's {@code eventId} dedupe absorb. The alternative ordering (stamp then publish) would lose
 * the event entirely on the same crash, and a lost suspend notification is unrecoverable in a way a
 * duplicate never is.
 *
 * <p>A failed publish leaves the row pending and stops the batch: continuing past a broker failure
 * would reorder events for other tokens behind a stuck one, and per-token ordering is a guarantee the
 * Kafka key exists to provide.
 */
@Component
public class OutboxPoller {

    private static final Logger log = LoggerFactory.getLogger(OutboxPoller.class);

    private final OutboxRepository outboxRepository;
    private final EventBroker eventBroker;
    private final ObjectMapper objectMapper;
    private final ProvisioningProperties properties;
    private final Counter published;
    private final Counter failures;
    private final AtomicLong pendingGaugeValue = new AtomicLong();

    public OutboxPoller(OutboxRepository outboxRepository,
                        EventBroker eventBroker,
                        ObjectMapper objectMapper,
                        ProvisioningProperties properties,
                        MeterRegistry meterRegistry) {
        this.outboxRepository = outboxRepository;
        this.eventBroker = eventBroker;
        this.objectMapper = objectMapper;
        this.properties = properties;
        this.published = Counter.builder("pts.outbox.published")
                .description("lifecycle events successfully handed to the broker").register(meterRegistry);
        this.failures = Counter.builder("pts.outbox.publish_failures")
                .description("failed publish attempts; the row stays pending").register(meterRegistry);
        Gauge.builder("pts.outbox.pending", pendingGaugeValue, AtomicLong::get)
                .description("outbox backlog -- the Kafka lag panel's companion")
                .register(meterRegistry);
    }

    @Scheduled(fixedDelayString = "${provisioning.outbox.poll-interval-ms:250}")
    public void poll() {
        if (!properties.getOutbox().isEnabled()) {
            return;
        }
        drainOnce();
    }

    /**
     * Publishes one batch.
     *
     * @return how many events were published, so tests can drive the poller deterministically instead
     *         of sleeping and hoping
     */
    public int drainOnce() {
        List<OutboxRepository.OutboxRow> pending =
                outboxRepository.fetchPending(properties.getOutbox().getBatchSize());
        pendingGaugeValue.set(outboxRepository.countPending());
        if (pending.isEmpty()) {
            return 0;
        }

        int sent = 0;
        for (OutboxRepository.OutboxRow row : pending) {
            try {
                LifecycleEvent event = objectMapper.readValue(row.payload(), LifecycleEvent.class);
                eventBroker.publish(event);
                outboxRepository.markPublished(row.eventId());
                published.increment();
                sent++;
            } catch (Exception e) {
                failures.increment();
                log.warn("outbox publish failed for event {} ({}), leaving it pending: {}",
                        row.eventId(), row.eventType(), e.toString());
                break; // preserve per-token ordering; retry on the next tick
            }
        }
        pendingGaugeValue.set(outboxRepository.countPending());
        if (sent > 0) {
            log.debug("published {} outbox event(s) via {}", sent, eventBroker.describe());
        }
        return sent;
    }
}
