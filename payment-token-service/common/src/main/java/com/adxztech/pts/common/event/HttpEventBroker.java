package com.adxztech.pts.common.event;

import com.adxztech.pts.common.api.LifecycleEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;

/**
 * Delivers lifecycle events over HTTP to the notification consumer.
 *
 * <p>Exists so the "no duplicate notifications" claim is demonstrable in the pure-JVM stack, which has
 * no Kafka. {@code deliveriesPerEvent} lets a demo or test force the duplicate that a broker retry
 * would produce, and the consumer's {@code eventId} dedupe absorbs it.
 */
public class HttpEventBroker implements EventBroker {

    private static final Logger log = LoggerFactory.getLogger(HttpEventBroker.class);

    private final RestClient restClient;
    private final String endpoint;
    private final int deliveriesPerEvent;

    public HttpEventBroker(RestClient restClient, String endpoint, int deliveriesPerEvent) {
        this.restClient = restClient;
        this.endpoint = endpoint;
        this.deliveriesPerEvent = Math.max(1, deliveriesPerEvent);
    }

    @Override
    public void publish(LifecycleEvent event) {
        for (int attempt = 1; attempt <= deliveriesPerEvent; attempt++) {
            restClient.post()
                    .uri(endpoint)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(event)
                    .retrieve()
                    .toBodilessEntity();
            if (attempt > 1) {
                log.info("re-delivered event {} (simulated at-least-once duplicate #{})",
                        event.eventId(), attempt);
            }
        }
    }

    @Override
    public String describe() {
        return "HTTP -> " + endpoint + " (deliveries per event: " + deliveriesPerEvent + ")";
    }
}
