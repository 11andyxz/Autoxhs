package com.adxztech.pts.hzmember;

import com.adxztech.pts.common.cluster.VaultClusterConfig;
import com.hazelcast.core.HazelcastInstance;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Cluster visibility for the failover demo (S10.4) and the cache dashboard (S13).
 *
 * <p>Exposes what the map sizes and member list actually are, so "kill a member and the map survives"
 * is an observation rather than an assertion.
 */
@RestController
public class ClusterStatusController {

    private final HazelcastInstance hazelcast;

    public ClusterStatusController(HazelcastInstance hazelcast) {
        this.hazelcast = hazelcast;
    }

    @GetMapping(path = "/cluster/status", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("instanceName", hazelcast.getName());
        out.put("clusterName", hazelcast.getConfig().getClusterName());
        out.put("members", hazelcast.getCluster().getMembers().stream()
                .map(m -> m.getAddress().toString())
                .toList());
        out.put("vaultRecords", hazelcast.getMap(VaultClusterConfig.MAP_VAULT).size());
        out.put("tokenAtcEntries", hazelcast.getMap(VaultClusterConfig.MAP_ATC).size());
        return out;
    }
}
