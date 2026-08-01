package com.adxztech.pts.notification;

import com.adxztech.pts.common.config.CryptoConfig;
import com.adxztech.pts.common.config.PersistenceConfig;
import com.adxztech.pts.common.web.WebConfig;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Import;

/**
 * The idempotent consumer of {@code token.lifecycle} (S10.2).
 *
 * <p>This service is where "no duplicate notifications" is actually enforced. The idempotent producer
 * stops the broker duplicating its own retries, but it cannot stop a duplicate that originates upstream:
 * if the outbox poller dies between the broker ack and the {@code published_at} stamp, the event is
 * republished on restart. Deduping on {@code eventId} here -- durably, in the database -- is what makes
 * at-least-once delivery exactly-once in <em>effect</em>.
 *
 * <p>Durable rather than in-memory on purpose: an in-memory set would re-notify after every restart,
 * which is precisely when a redelivery is most likely.
 */
@SpringBootApplication
@Import({CryptoConfig.class, PersistenceConfig.class, WebConfig.class})
public class NotificationApplication {

    public static void main(String[] args) {
        SpringApplication.run(NotificationApplication.class, args);
    }
}
