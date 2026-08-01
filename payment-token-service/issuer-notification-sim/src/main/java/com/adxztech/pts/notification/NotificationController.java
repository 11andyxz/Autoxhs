package com.adxztech.pts.notification;

import com.adxztech.pts.common.api.LifecycleEvent;
import com.adxztech.pts.common.persistence.NotificationDedupeRepository;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * HTTP ingress for lifecycle events, used when the stack runs without Kafka.
 *
 * <p>Always answers 200, including for a suppressed duplicate. Returning an error for a duplicate would
 * make the sender retry forever -- the correct response to "I have already handled this" is success.
 */
@RestController
public class NotificationController {

    private final NotificationHandler handler;
    private final NotificationDedupeRepository dedupe;

    public NotificationController(NotificationHandler handler, NotificationDedupeRepository dedupe) {
        this.handler = handler;
        this.dedupe = dedupe;
    }

    @PostMapping(path = "/events", consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> receive(@RequestBody LifecycleEvent event) {
        boolean notified = handler.handle(event);
        return ResponseEntity.ok(Map.of(
                "eventId", event.eventId() == null ? "" : event.eventId(),
                "notified", notified,
                "duplicate", !notified));
    }

    @GetMapping(path = "/sim/notifications", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<LifecycleEvent> notifications() {
        return handler.notifications();
    }

    @GetMapping(path = "/sim/notifications/{tokenRef}", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<LifecycleEvent> notificationsFor(@PathVariable String tokenRef) {
        return handler.notificationsFor(tokenRef);
    }

    @GetMapping(path = "/sim/counters", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> counters() {
        return Map.of(
                "notifications", handler.notifications().size(),
                "dedupeEntries", dedupe.count());
    }
}
