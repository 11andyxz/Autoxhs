package com.adxztech.pts.it;

import com.adxztech.pts.common.api.LifecycleEvent;
import com.adxztech.pts.common.client.RestClients;
import com.adxztech.pts.common.demo.DemoCards;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The transactional outbox and the idempotent consumer (S10.2, S10.3).
 *
 * <p>Two guarantees are separable and both are tested here. The outbox makes the event durable <em>with</em>
 * the state change, so a crash cannot lose it. The consumer's {@code eventId} dedupe makes at-least-once
 * delivery exactly-once in effect, so a redelivery cannot double-notify. Neither depends on a broker
 * feature, which is why the guarantee survives all three transports.
 */
class OutboxNotificationIT extends IntegrationTestBase {

    @Test
    @DisplayName("provisioning writes its events to the outbox in the same transaction as the token")
    void eventsAreQueuedWithTheStateChange() {
        String tokenRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");

        // The poller is disabled in the fixture, so the events are still pending. This is the window in
        // which a crash would previously have lost them; with an outbox they simply wait.
        List<com.adxztech.pts.common.persistence.OutboxRepository.OutboxRow> rows =
                new com.adxztech.pts.common.persistence.OutboxRepository(
                        new org.springframework.jdbc.core.JdbcTemplate(dataSource()))
                        .findByTokenRef(tokenRef);
        assertThat(rows).extracting(
                        com.adxztech.pts.common.persistence.OutboxRepository.OutboxRow::eventType)
                .containsExactly("PROVISIONED", "ACTIVATED");
        assertThat(rows).allMatch(
                com.adxztech.pts.common.persistence.OutboxRepository.OutboxRow::pending);
    }

    @Test
    @DisplayName("draining the outbox notifies the consumer exactly once per event")
    void drainDeliversEachEventOnce() {
        String tokenRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");

        client.drainOutboxFully();

        List<LifecycleEvent> notifications = client.notificationsFor(tokenRef);
        assertThat(notifications).extracting(LifecycleEvent::eventType)
                .containsExactly("PROVISIONED", "ACTIVATED");
        assertThat(notifications).extracting(LifecycleEvent::eventId).doesNotHaveDuplicates();

        // A second drain publishes nothing: published_at has been stamped.
        Map<String, Object> second = client.drainOutbox();
        assertThat(((Number) second.get("published")).intValue()).isZero();
        assertThat(client.notificationsFor(tokenRef)).hasSize(2);
    }

    @Test
    @DisplayName("a redelivered event is suppressed, so a broker retry cannot double-notify")
    void duplicateDeliveryIsSuppressed() {
        String tokenRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");
        client.drainOutboxFully();

        List<LifecycleEvent> delivered = client.notificationsFor(tokenRef);
        assertThat(delivered).isNotEmpty();
        LifecycleEvent alreadySeen = delivered.get(0);

        // Redeliver the exact event, as an outbox republish after a crash between ack and stamp would.
        RestClient notificationClient = RestClients.controlPlane(fixture.notificationUrl(), null);
        for (int attempt = 0; attempt < 3; attempt++) {
            Map<?, ?> response = notificationClient.post()
                    .uri("/events")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(alreadySeen)
                    .retrieve()
                    .body(Map.class);
            assertThat(response).isNotNull();
            assertThat(response.get("duplicate")).isEqualTo(true);
            assertThat(response.get("notified")).isEqualTo(false);
        }

        // Still exactly the events from the first delivery: no duplicate notification was produced.
        assertThat(client.notificationsFor(tokenRef)).hasSameSizeAs(delivered);
    }

    @Test
    @DisplayName("lifecycle changes produce their own events, in order, per token")
    void lifecycleEventsAreOrdered() {
        String tokenRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");
        client.suspend(tokenRef);
        client.resume(tokenRef);
        client.delete(tokenRef);
        client.drainOutboxFully();

        assertThat(client.notificationsFor(tokenRef)).extracting(LifecycleEvent::eventType)
                .containsExactly("PROVISIONED", "ACTIVATED", "SUSPENDED", "RESUMED", "DELETED");
    }

    @Test
    @DisplayName("events carry no PAN and no full token, so downstream consumers stay out of PCI scope")
    void eventPayloadIsSafeForDownstream() {
        String card = ItCards.nextIssaApprove();
        String tokenRef = client.provisionActiveToken(card, DemoCards.WALLET_REQUESTOR, "ECOM");
        String tokenPan = client.vault(tokenRef).tokenPan();
        client.drainOutboxFully();

        List<LifecycleEvent> events = client.notificationsFor(tokenRef);
        assertThat(events).isNotEmpty();
        for (LifecycleEvent event : events) {
            String rendered = event.toString();
            assertThat(rendered).doesNotContain(card);
            assertThat(rendered).doesNotContain(tokenPan);
            assertThat(event.tokenLast4()).isEqualTo(tokenPan.substring(tokenPan.length() - 4));
            assertThat(event.schemaVersion()).isEqualTo(LifecycleEvent.CURRENT_SCHEMA_VERSION);
            assertThat(event.occurredAt()).isNotBlank();
        }
    }

    @Test
    @DisplayName("the dedupe store grows by one per distinct event, never per delivery")
    void dedupeStoreCountsDistinctEventsOnly() {
        long dedupeBefore = ((Number) client.notificationCounters().get("dedupeEntries")).longValue();

        String tokenRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");
        // The drain also flushes any backlog left by earlier tests, so the comparison is against what was
        // actually published rather than against this token's share of it.
        int published = client.drainOutboxFully();

        long dedupeAfter = ((Number) client.notificationCounters().get("dedupeEntries")).longValue();
        assertThat(dedupeAfter - dedupeBefore).isEqualTo(published);

        // Redelivering an already-seen event adds no row: the store counts distinct events, not deliveries.
        List<LifecycleEvent> delivered = client.notificationsFor(tokenRef);
        assertThat(delivered).isNotEmpty();
        RestClients.controlPlane(fixture.notificationUrl(), null).post()
                .uri("/events")
                .contentType(MediaType.APPLICATION_JSON)
                .body(delivered.get(0))
                .retrieve()
                .toBodilessEntity();
        assertThat(((Number) client.notificationCounters().get("dedupeEntries")).longValue())
                .isEqualTo(dedupeAfter);
    }

    private javax.sql.DataSource dataSource() {
        org.springframework.jdbc.datasource.DriverManagerDataSource ds =
                new org.springframework.jdbc.datasource.DriverManagerDataSource(
                        fixture.jdbcUrl(), "sa", "");
        ds.setDriverClassName("org.h2.Driver");
        return ds;
    }
}
