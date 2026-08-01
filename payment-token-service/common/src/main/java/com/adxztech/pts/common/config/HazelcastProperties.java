package com.adxztech.pts.common.config;

import com.adxztech.pts.common.cluster.VaultClusterConfig;
import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.List;

/** {@code pts.hazelcast.*} -- cluster topology and near-cache tuning (S3.1, S8.2). */
@ConfigurationProperties(prefix = "pts.hazelcast")
public class HazelcastProperties {

    public enum Mode {
        /** Hosts the maps, the read-through loader and the write-behind store. */
        MEMBER,
        /** Connects to the cluster; the only mode that can have a near-cache. */
        CLIENT,
        /** No Hazelcast at all -- every read goes to the database. */
        DISABLED
    }

    private Mode mode = Mode.DISABLED;
    private String clusterName = "pts-cluster";

    /** Member listen port. Auto-increment is off so a misconfiguration fails instead of drifting. */
    private int port = 5701;

    /** Explicit TCP/IP member list. Multicast discovery is never used. */
    private List<String> members = new ArrayList<>(List.of("127.0.0.1:5701"));

    private int vaultTtlSeconds = VaultClusterConfig.DEFAULT_VAULT_TTL_SECONDS;
    private int writeBehindSeconds = VaultClusterConfig.DEFAULT_WRITE_BEHIND_SECONDS;
    private int backupCount = 1;
    private int connectTimeoutMillis = 15_000;

    private NearCache nearCache = new NearCache();

    public VaultClusterConfig.MemberSettings toMemberSettings(String instanceName) {
        return new VaultClusterConfig.MemberSettings(clusterName, instanceName, port,
                List.copyOf(members), vaultTtlSeconds, writeBehindSeconds, backupCount);
    }

    public VaultClusterConfig.ClientSettings toClientSettings() {
        return new VaultClusterConfig.ClientSettings(clusterName, List.copyOf(members),
                nearCache.enabled, nearCache.ttlSeconds, nearCache.maxEntries, connectTimeoutMillis);
    }

    public Mode getMode() {
        return mode;
    }

    public void setMode(Mode mode) {
        this.mode = mode;
    }

    public String getClusterName() {
        return clusterName;
    }

    public void setClusterName(String clusterName) {
        this.clusterName = clusterName;
    }

    public int getPort() {
        return port;
    }

    public void setPort(int port) {
        this.port = port;
    }

    public List<String> getMembers() {
        return members;
    }

    public void setMembers(List<String> members) {
        this.members = members;
    }

    public int getVaultTtlSeconds() {
        return vaultTtlSeconds;
    }

    public void setVaultTtlSeconds(int vaultTtlSeconds) {
        this.vaultTtlSeconds = vaultTtlSeconds;
    }

    public int getWriteBehindSeconds() {
        return writeBehindSeconds;
    }

    public void setWriteBehindSeconds(int writeBehindSeconds) {
        this.writeBehindSeconds = writeBehindSeconds;
    }

    public int getBackupCount() {
        return backupCount;
    }

    public void setBackupCount(int backupCount) {
        this.backupCount = backupCount;
    }

    public int getConnectTimeoutMillis() {
        return connectTimeoutMillis;
    }

    public void setConnectTimeoutMillis(int connectTimeoutMillis) {
        this.connectTimeoutMillis = connectTimeoutMillis;
    }

    public NearCache getNearCache() {
        return nearCache;
    }

    public void setNearCache(NearCache nearCache) {
        this.nearCache = nearCache;
    }

    /** Near-cache settings. Only meaningful in {@link Mode#CLIENT}. */
    public static class NearCache {

        /** The optimization itself: hot entries resolved in-process, invalidated on any write. */
        private boolean enabled = true;

        private int ttlSeconds = VaultClusterConfig.DEFAULT_NEAR_CACHE_TTL_SECONDS;
        private int maxEntries = VaultClusterConfig.DEFAULT_NEAR_CACHE_MAX_ENTRIES;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public int getTtlSeconds() {
            return ttlSeconds;
        }

        public void setTtlSeconds(int ttlSeconds) {
            this.ttlSeconds = ttlSeconds;
        }

        public int getMaxEntries() {
            return maxEntries;
        }

        public void setMaxEntries(int maxEntries) {
            this.maxEntries = maxEntries;
        }
    }
}
