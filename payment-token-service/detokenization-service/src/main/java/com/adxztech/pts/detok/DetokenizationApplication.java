package com.adxztech.pts.detok;

import com.adxztech.pts.common.cache.AtcGuard;
import com.adxztech.pts.common.cache.VaultCache;
import com.adxztech.pts.common.client.ControlsClient;
import com.adxztech.pts.common.client.RestClients;
import com.adxztech.pts.common.config.CryptoConfig;
import com.adxztech.pts.common.config.HazelcastConfig;
import com.adxztech.pts.common.config.PersistenceConfig;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.sim.LatencyInjector;
import com.adxztech.pts.common.trace.TraceHeaderInterceptor;
import com.adxztech.pts.common.web.WebConfig;
import com.hazelcast.core.HazelcastInstance;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;

/**
 * The detokenization service: the read path inside the authorization flow (S6, S8).
 *
 * <p>Read-only by design. It never writes the vault, which is what allows it to be scaled out and cached
 * aggressively without becoming a source of truth. The one piece of state it does advance -- the ATC
 * counter -- is a replay guard, and both of its implementations are atomic.
 */
@SpringBootApplication
@EnableConfigurationProperties(DetokProperties.class)
@Import({CryptoConfig.class, PersistenceConfig.class, HazelcastConfig.class, WebConfig.class})
public class DetokenizationApplication {

    public static void main(String[] args) {
        SpringApplication.run(DetokenizationApplication.class, args);
    }

    /** Selects the vault read strategy from {@code detok.cache-mode} (S8.2, Optimization A). */
    @Bean
    public VaultReader vaultReader(DetokProperties properties,
                                   VaultRepository vaultRepository,
                                   VaultCache vaultCache,
                                   MeterRegistry meterRegistry) {
        return switch (properties.getCacheMode()) {
            case DIRECT -> new VaultReader.DirectJdbc(vaultRepository, meterRegistry);
            case NEAR_CACHE -> new VaultReader.NearCache(vaultCache, meterRegistry);
        };
    }

    /** Selects the controls strategy from {@code detok.controls.inline} (S8.2, Optimization B). */
    @Bean
    public ControlsGate controlsGate(DetokProperties properties,
                                     TraceHeaderInterceptor traceInterceptor,
                                     LatencyInjector latencyInjector) {
        if (properties.getControls().isInline()) {
            return new ControlsGate.Inline();
        }
        return new ControlsGate.Remote(
                new ControlsClient(RestClients.hotPath(properties.getControls().getUrl(), traceInterceptor)),
                latencyInjector);
    }

    /**
     * Selects the ATC guard from {@code detok.atc-mode}.
     *
     * <p>{@code CLUSTER} requires a Hazelcast instance; if one is not configured this falls back to the
     * database guard rather than failing to start. Losing the replay guard entirely would be a far worse
     * outcome than losing the optimization.
     */
    @Bean
    public AtcGuard atcGuard(DetokProperties properties,
                             VaultRepository vaultRepository,
                             ObjectProvider<HazelcastInstance> hazelcast) {
        if (properties.getAtcMode() == DetokProperties.AtcMode.CLUSTER) {
            HazelcastInstance instance = hazelcast.getIfAvailable();
            if (instance != null) {
                return new AtcGuards.Cluster(instance);
            }
        }
        return new AtcGuards.Jdbc(vaultRepository);
    }
}
