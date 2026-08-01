package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.config.CryptoConfig;
import com.adxztech.pts.common.config.HazelcastConfig;
import com.adxztech.pts.common.config.PersistenceConfig;
import com.adxztech.pts.common.web.WebConfig;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Owns the token state machine and every write to the vault (S5, S7).
 *
 * <p>Responsibilities: provisioning with ID&amp;V, OTP step-up, lifecycle transitions, card reissue,
 * key rotation, and the transactional outbox that feeds lifecycle events downstream.
 *
 * <p>The authorization path never writes. Concentrating writes here is what makes "one legal
 * transition = one transaction that updates the vault, inserts the outbox event and pushes the cache"
 * an invariant rather than a convention (S4.3).
 */
@SpringBootApplication
@EnableScheduling
@Import({CryptoConfig.class, PersistenceConfig.class, HazelcastConfig.class, WebConfig.class})
public class ProvisioningApplication {

    public static void main(String[] args) {
        SpringApplication.run(ProvisioningApplication.class, args);
    }
}
