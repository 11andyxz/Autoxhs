package com.adxztech.pts.common.config;

import com.adxztech.pts.common.cache.HazelcastVaultCache;
import com.adxztech.pts.common.cache.NoopVaultCache;
import com.adxztech.pts.common.cache.VaultCache;
import com.adxztech.pts.common.cluster.AtcMapStore;
import com.adxztech.pts.common.cluster.VaultClusterConfig;
import com.adxztech.pts.common.cluster.VaultMapLoader;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.hazelcast.client.HazelcastClient;
import com.hazelcast.core.Hazelcast;
import com.hazelcast.core.HazelcastInstance;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/**
 * Wires Hazelcast according to {@code pts.hazelcast.mode} (S3.1).
 *
 * <p>Three modes, one config class, because the member and the client must agree about cluster name,
 * map names and TTLs. Splitting that across two services is how a near-cache ends up pointing at a map
 * that does not exist.
 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(HazelcastProperties.class)
public class HazelcastConfig {

    private static final Logger log = LoggerFactory.getLogger(HazelcastConfig.class);

    /** Read-through loader; only a member needs it. */
    @Bean
    @ConditionalOnProperty(name = "pts.hazelcast.mode", havingValue = "MEMBER")
    public VaultMapLoader vaultMapLoader(VaultRepository vaultRepository) {
        return new VaultMapLoader(vaultRepository);
    }

    /** Write-behind store for the ATC counters; only a member needs it. */
    @Bean
    @ConditionalOnProperty(name = "pts.hazelcast.mode", havingValue = "MEMBER")
    public AtcMapStore atcMapStore(VaultRepository vaultRepository) {
        return new AtcMapStore(vaultRepository);
    }

    @Bean(destroyMethod = "shutdown")
    @ConditionalOnProperty(name = "pts.hazelcast.mode", havingValue = "MEMBER")
    public HazelcastInstance hazelcastMember(HazelcastProperties properties,
                                             VaultMapLoader vaultMapLoader,
                                             AtcMapStore atcMapStore,
                                             Environment environment) {
        String instanceName = environment.getProperty("spring.application.name", "pts")
                + "-member-" + properties.getPort();
        HazelcastInstance instance = Hazelcast.newHazelcastInstance(
                VaultClusterConfig.member(properties.toMemberSettings(instanceName),
                        vaultMapLoader, atcMapStore));
        log.info("hazelcast MEMBER '{}' up on port {} (cluster '{}', vault TTL {}s, write-behind {}s)",
                instanceName, properties.getPort(), properties.getClusterName(),
                properties.getVaultTtlSeconds(), properties.getWriteBehindSeconds());
        return instance;
    }

    @Bean(destroyMethod = "shutdown")
    @ConditionalOnProperty(name = "pts.hazelcast.mode", havingValue = "CLIENT")
    public HazelcastInstance hazelcastClient(HazelcastProperties properties) {
        HazelcastInstance instance =
                HazelcastClient.newHazelcastClient(VaultClusterConfig.client(properties.toClientSettings()));
        log.info("hazelcast CLIENT connected to cluster '{}' at {} (near-cache {}{})",
                properties.getClusterName(), properties.getMembers(),
                properties.getNearCache().isEnabled() ? "ON" : "OFF",
                properties.getNearCache().isEnabled()
                        ? ", ttl=" + properties.getNearCache().getTtlSeconds() + "s, max="
                          + properties.getNearCache().getMaxEntries()
                        : "");
        return instance;
    }

    /**
     * The cache facade. Falls back to a no-op when Hazelcast is disabled, so the write path does not
     * need to know whether a cache tier exists -- it always calls write-through and the no-op absorbs it.
     */
    @Bean
    public VaultCache vaultCache(org.springframework.beans.factory.ObjectProvider<HazelcastInstance> hazelcast) {
        HazelcastInstance instance = hazelcast.getIfAvailable();
        VaultCache cache = instance == null ? new NoopVaultCache() : new HazelcastVaultCache(instance);
        log.info("vault cache strategy: {}", cache.describe());
        return cache;
    }
}
