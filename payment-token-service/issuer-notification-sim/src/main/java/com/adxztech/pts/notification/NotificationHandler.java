package com.adxztech.pts.notification;

import com.adxztech.pts.common.api.LifecycleEvent;
import com.adxztech.pts.common.persistence.NotificationDedupeRepository;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Handles one lifecycle event, exactly once in effect (S10.2).
 *
 * <p>The dedupe insert is the gate: it either claims the {@code eventId} or discovers someone already
 * did. Claiming <em>before</em> acting is what makes this safe under concurrent redelivery -- a
 * check-then-act would let two threads both pass the check and both notify.
 */
@Component
public class NotificationHandler {

    private static final Logger log = LoggerFactory.getLogger(NotificationHandler.class);

    private final NotificationDedupeRepository dedupe;
    private final Counter delivered;
    private final Counter suppressed;

    /** Notifications actually "sent", for demo and test assertions. */
    private final List<LifecycleEvent> notifications = new CopyOnWriteArrayList<>();

    public NotificationHandler(NotificationDedupeRepository dedupe, MeterRegistry meterRegistry) {
        this.dedupe = dedupe;
        this.delivered = Counter.builder("pts.notifications.delivered")
                .description("first-time events that produced a notification").register(meterRegistry);
        this.suppressed = Counter.builder("pts.notifications.suppressed_duplicates")
                .description("redelivered events suppressed by eventId dedupe").register(meterRegistry);
    }

    /** @return true if this delivery produced a notification, false if it was a suppressed duplicate */
    public boolean handle(LifecycleEvent event) {
        if (event == null || event.eventId() == null) {
            log.warn("discarding an event with no eventId; it cannot be deduplicated");
            return false;
        }
        boolean firstTime = dedupe.markSeen(event.eventId(), event.eventType(), event.tokenRef());
        if (!firstTime) {
            suppressed.increment();
            log.info("duplicate delivery of event {} ({}) suppressed", event.eventId(), event.eventType());
            return false;
        }
        notifications.add(event);
        delivered.increment();
        log.info("notified issuer: {} for tokenRef={} tokenLast4={} (schemaVersion={})",
                event.eventType(), event.tokenRef(), event.tokenLast4(), event.schemaVersion());
        return true;
    }

    public List<LifecycleEvent> notifications() {
        return new ArrayList<>(notifications);
    }

    public List<LifecycleEvent> notificationsFor(String tokenRef) {
        return notifications.stream().filter(e -> tokenRef.equals(e.tokenRef())).toList();
    }

    public void clear() {
        notifications.clear();
    }
}
