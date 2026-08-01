package com.adxztech.pts.common.event;

import com.adxztech.pts.common.api.LifecycleEvent;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * In-JVM broker: records everything published and fans out to local subscribers.
 *
 * <p>Used by tests to assert that a lifecycle change produced exactly the events it should have, in
 * order, with the right payload -- assertions that would otherwise need a broker.
 */
public class InMemoryEventBroker implements EventBroker {

    private final List<LifecycleEvent> published = new CopyOnWriteArrayList<>();
    private final List<Consumer<LifecycleEvent>> subscribers = new CopyOnWriteArrayList<>();

    /** Number of times each event is delivered; >1 exercises consumer dedupe (S10.2). */
    private volatile int deliveriesPerEvent = 1;

    @Override
    public void publish(LifecycleEvent event) {
        published.add(event);
        for (int i = 0; i < deliveriesPerEvent; i++) {
            for (Consumer<LifecycleEvent> subscriber : subscribers) {
                subscriber.accept(event);
            }
        }
    }

    public void subscribe(Consumer<LifecycleEvent> subscriber) {
        subscribers.add(subscriber);
    }

    /** Simulates at-least-once delivery duplicating an event. */
    public void setDeliveriesPerEvent(int deliveries) {
        if (deliveries < 1) {
            throw new IllegalArgumentException("deliveries must be >= 1");
        }
        this.deliveriesPerEvent = deliveries;
    }

    public List<LifecycleEvent> published() {
        return List.copyOf(published);
    }

    public List<LifecycleEvent> publishedOfType(String eventType) {
        return published.stream().filter(e -> e.eventType().equals(eventType)).toList();
    }

    public void clear() {
        published.clear();
    }

    @Override
    public String describe() {
        return "IN_MEMORY (deliveries per event: " + deliveriesPerEvent + ")";
    }
}
