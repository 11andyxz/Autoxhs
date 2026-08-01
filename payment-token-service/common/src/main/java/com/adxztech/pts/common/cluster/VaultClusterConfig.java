package com.adxztech.pts.common.cluster;

import com.adxztech.pts.common.vault.VaultRecord;
import com.hazelcast.client.config.ClientConfig;
import com.hazelcast.config.Config;
import com.hazelcast.config.EvictionConfig;
import com.hazelcast.config.EvictionPolicy;
import com.hazelcast.config.InMemoryFormat;
import com.hazelcast.config.JoinConfig;
import com.hazelcast.config.MapConfig;
import com.hazelcast.config.MapStoreConfig;
import com.hazelcast.config.MaxSizePolicy;
import com.hazelcast.config.NearCacheConfig;
import com.hazelcast.config.NetworkConfig;

import java.util.List;

/**
 * Builds the Hazelcast member and client configurations for the two maps the design specifies (S3.1).
 *
 * <pre>
 *   vault-records : read-through MapLoader from the vault, TTL 300s, 1 backup
 *   token-atc     : write-behind MapStore to token_vault.last_atc, atomic advance via EntryProcessor
 * </pre>
 *
 * <p><b>Why members run our code.</b> Read-through and write-behind require the {@code MapLoader} /
 * {@code MapStore} implementations to execute <em>on the member</em>, and the ATC compare-and-set runs
 * as an {@code EntryProcessor} on the partition owner. That means members cannot be stock Hazelcast
 * containers: they are the {@code hazelcast-member} module, which carries these classes and a
 * DataSource. This is the same reason production Hazelcast deployments either ship member-side jars or
 * enable user-code deployment -- worth knowing before an interviewer asks why the topology looks like
 * this.
 *
 * <p><b>Why the client has the near-cache and the member does not.</b> The point of the optimization is
 * to remove the hop. A cache on the member still costs a client-to-member round trip; a near-cache on
 * the client is in-process. {@code invalidateOnChange} keeps those local copies coherent -- that is the
 * property Redis cannot offer without a hop of its own (S16).
 */
public final class VaultClusterConfig {

    public static final String MAP_VAULT = "vault-records";
    public static final String MAP_ATC = "token-atc";

    public static final int DEFAULT_VAULT_TTL_SECONDS = 300;
    public static final int DEFAULT_NEAR_CACHE_TTL_SECONDS = 60;
    public static final int DEFAULT_NEAR_CACHE_MAX_ENTRIES = 50_000;
    public static final int DEFAULT_WRITE_BEHIND_SECONDS = 1;

    private VaultClusterConfig() {
    }

    /** Parameters for a member, kept as a record so the member app and the tests configure identically. */
    public record MemberSettings(String clusterName,
                                 String instanceName,
                                 int port,
                                 List<String> members,
                                 int vaultTtlSeconds,
                                 int writeBehindSeconds,
                                 int backupCount) {

        public static MemberSettings localSingleton(String clusterName, int port) {
            return new MemberSettings(clusterName, clusterName + "-member-" + port, port,
                    List.of("127.0.0.1:" + port), DEFAULT_VAULT_TTL_SECONDS,
                    DEFAULT_WRITE_BEHIND_SECONDS, 0);
        }
    }

    public static Config member(MemberSettings settings,
                                VaultMapLoader vaultLoader,
                                AtcMapStore atcStore) {
        Config config = new Config();
        config.setClusterName(settings.clusterName());
        config.setInstanceName(settings.instanceName());

        // Keep the demo self-contained and quiet: no usage reporting, no Jet engine (we never submit
        // a job, and disabling it measurably shortens member start-up).
        config.setProperty("hazelcast.phone.home.enabled", "false");
        config.setProperty("hazelcast.shutdownhook.enabled", "false");
        config.getJetConfig().setEnabled(false);
        config.getMetricsConfig().setEnabled(true);

        // ---------------------------------------------------------------------------------------
        // The single most important setting in this class.
        //
        // Hazelcast BATCHES near-cache invalidation events by default: they are accumulated and
        // flushed only when the batch reaches hazelcast.map.invalidation.batch.size (100) or after
        // hazelcast.map.invalidation.batchfrequency.seconds (10) elapses. On a low-write map -- and
        // lifecycle changes are inherently low-TPS -- neither trigger fires promptly, so a client's
        // near-cache can keep serving a stale record for up to TEN SECONDS after a write.
        //
        // For this system that is not a performance nuance, it is a security defect: a token
        // suspended for fraud would keep authorizing for the length of the batch window, and the
        // whole "a suspension is visible to the authorization path within milliseconds" property
        // (S8.4) would quietly be false. The integration suite caught exactly that.
        //
        // Turning batching off sends each invalidation immediately. The cost is one small cluster
        // message per vault write instead of one per batch, which is negligible against a write rate
        // measured in provisioning requests rather than authorizations -- and it is the right trade
        // whenever the cached field is security-relevant.
        // ---------------------------------------------------------------------------------------
        config.setProperty("hazelcast.map.invalidation.batch.enabled", "false");
        // Belt and braces: if batching is ever re-enabled, keep the window sub-second rather than 10s.
        config.setProperty("hazelcast.map.invalidation.batchfrequency.seconds", "1");

        NetworkConfig network = config.getNetworkConfig();
        network.setPort(settings.port()).setPortAutoIncrement(false);

        // Explicit TCP/IP membership only. Multicast and cloud auto-detection are disabled so a
        // developer's laptop cannot accidentally join a colleague's cluster -- which, with a map called
        // "vault-records", would be a memorable incident.
        JoinConfig join = network.getJoin();
        join.getMulticastConfig().setEnabled(false);
        join.getAutoDetectionConfig().setEnabled(false);
        join.getKubernetesConfig().setEnabled(false);
        join.getTcpIpConfig().setEnabled(true).setMembers(settings.members());

        MapConfig vault = new MapConfig(MAP_VAULT)
                .setBackupCount(settings.backupCount())
                .setTimeToLiveSeconds(settings.vaultTtlSeconds())
                .setInMemoryFormat(InMemoryFormat.BINARY)
                .setStatisticsEnabled(true)
                .setPerEntryStatsEnabled(false);
        if (vaultLoader != null) {
            // MapLoader only -- deliberately NOT a MapStore. Writes to this map are cache
            // write-throughs from the provisioning service; the database write already happened in
            // its own transaction. Wiring a store here would double-write the vault.
            vault.setMapStoreConfig(new MapStoreConfig()
                    .setEnabled(true)
                    .setImplementation(vaultLoader)
                    .setInitialLoadMode(MapStoreConfig.InitialLoadMode.LAZY));
        }
        config.addMapConfig(vault);

        MapConfig atc = new MapConfig(MAP_ATC)
                .setBackupCount(settings.backupCount())
                .setInMemoryFormat(InMemoryFormat.BINARY)
                .setStatisticsEnabled(true);
        if (atcStore != null) {
            atc.setMapStoreConfig(new MapStoreConfig()
                    .setEnabled(true)
                    .setImplementation(atcStore)
                    .setWriteDelaySeconds(settings.writeBehindSeconds())
                    .setWriteCoalescing(true)
                    .setInitialLoadMode(MapStoreConfig.InitialLoadMode.LAZY));
        }
        config.addMapConfig(atc);

        return config;
    }

    /** Parameters for a client. {@code nearCache=false} yields a plain remote cache for comparison. */
    public record ClientSettings(String clusterName,
                                 List<String> addresses,
                                 boolean nearCache,
                                 int nearCacheTtlSeconds,
                                 int nearCacheMaxEntries,
                                 int connectTimeoutMillis) {

        public static ClientSettings local(String clusterName, int port) {
            return new ClientSettings(clusterName, List.of("127.0.0.1:" + port), true,
                    DEFAULT_NEAR_CACHE_TTL_SECONDS, DEFAULT_NEAR_CACHE_MAX_ENTRIES, 15_000);
        }
    }

    public static ClientConfig client(ClientSettings settings) {
        ClientConfig config = new ClientConfig();
        config.setClusterName(settings.clusterName());
        config.setProperty("hazelcast.client.statistics.enabled", "true");
        config.getNetworkConfig().setAddresses(settings.addresses());
        config.getNetworkConfig().setSmartRouting(true);

        // Bound the reconnect loop: a client that retries forever turns "cluster is down" into
        // "service hangs", which is a far worse failure mode on the authorization path.
        config.getConnectionStrategyConfig().getConnectionRetryConfig()
                .setClusterConnectTimeoutMillis(settings.connectTimeoutMillis())
                .setInitialBackoffMillis(200)
                .setMaxBackoffMillis(3_000);

        if (settings.nearCache()) {
            NearCacheConfig nearCacheConfig = new NearCacheConfig(MAP_VAULT)
                    // OBJECT: hits skip deserialization entirely, which is the point of being in-process.
                    .setInMemoryFormat(InMemoryFormat.OBJECT)
                    // The correctness lever: any write anywhere in the cluster purges this local copy.
                    .setInvalidateOnChange(true)
                    .setTimeToLiveSeconds(settings.nearCacheTtlSeconds())
                    .setSerializeKeys(false);
            nearCacheConfig.setEvictionConfig(new EvictionConfig()
                    .setEvictionPolicy(EvictionPolicy.LRU)
                    .setMaxSizePolicy(MaxSizePolicy.ENTRY_COUNT)
                    .setSize(settings.nearCacheMaxEntries()));
            config.addNearCacheConfig(nearCacheConfig);
        }
        return config;
    }

    /** Type token helper so callers do not repeat the generic signature. */
    public static Class<VaultRecord> vaultValueType() {
        return VaultRecord.class;
    }
}
