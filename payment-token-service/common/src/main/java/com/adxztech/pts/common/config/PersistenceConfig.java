package com.adxztech.pts.common.config;

import com.adxztech.pts.common.crypto.JdbcDekRegistry;
import com.adxztech.pts.common.crypto.KeyService;
import com.adxztech.pts.common.persistence.BinMapRepository;
import com.adxztech.pts.common.persistence.IdempotencyRepository;
import com.adxztech.pts.common.persistence.IdvSessionRepository;
import com.adxztech.pts.common.persistence.KeyRegistryRepository;
import com.adxztech.pts.common.persistence.NotificationDedupeRepository;
import com.adxztech.pts.common.persistence.OutboxRepository;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.sim.LatencyInjector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Repository and key-registry beans, plus the idempotent start-up seed.
 *
 * <p>Imported by every service that touches the vault. One place for the SQL means the controls
 * service, the switch and the detokenization service cannot drift into three subtly different ideas of
 * what "the vault" is.
 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(BinProperties.class)
public class PersistenceConfig {

    private static final Logger log = LoggerFactory.getLogger(PersistenceConfig.class);

    @Bean
    public VaultRepository vaultRepository(JdbcTemplate jdbc, LatencyInjector latency) {
        return new VaultRepository(jdbc, latency);
    }

    @Bean
    public OutboxRepository outboxRepository(JdbcTemplate jdbc) {
        return new OutboxRepository(jdbc);
    }

    @Bean
    public IdvSessionRepository idvSessionRepository(JdbcTemplate jdbc) {
        return new IdvSessionRepository(jdbc);
    }

    @Bean
    public BinMapRepository binMapRepository(JdbcTemplate jdbc) {
        return new BinMapRepository(jdbc);
    }

    @Bean
    public KeyRegistryRepository keyRegistryRepository(JdbcTemplate jdbc) {
        return new KeyRegistryRepository(jdbc);
    }

    @Bean
    public IdempotencyRepository idempotencyRepository(JdbcTemplate jdbc) {
        return new IdempotencyRepository(jdbc);
    }

    @Bean
    public NotificationDedupeRepository notificationDedupeRepository(JdbcTemplate jdbc) {
        return new NotificationDedupeRepository(jdbc);
    }

    @Bean
    public JdbcDekRegistry dekRegistry(KeyRegistryRepository repository, KeyService keyService) {
        return new JdbcDekRegistry(repository, keyService);
    }

    /**
     * Seeds the BIN maps and makes sure an ACTIVE DEK exists before any traffic arrives.
     *
     * <p>Runs first ({@link Order}) because everything else -- allocating a token PAN, sealing a
     * funding PAN, resolving an issuer's token capability -- depends on it. Both operations are
     * idempotent, so several services sharing one database can each run this at start-up.
     */
    @Bean
    @Order(0)
    public ApplicationRunner referenceDataSeeder(BinProperties properties,
                                                 BinMapRepository binMapRepository,
                                                 JdbcDekRegistry dekRegistry) {
        return args -> {
            if (!properties.isSeedOnStartup()) {
                log.info("BIN map seeding disabled (pts.bins.seed-on-startup=false)");
            } else {
                properties.getTokenRanges().forEach(r -> binMapRepository.upsertTokenRange(r.toDomain()));
                properties.getFundingRanges().forEach(r -> binMapRepository.upsertFundingRange(r.toDomain()));
                log.info("seeded {} token BIN range(s) and {} funding BIN range(s)",
                        properties.getTokenRanges().size(), properties.getFundingRanges().size());
            }
            dekRegistry.bootstrap();
        };
    }
}
