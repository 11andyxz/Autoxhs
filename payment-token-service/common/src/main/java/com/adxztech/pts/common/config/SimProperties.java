package com.adxztech.pts.common.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code pts.sim.*} -- demo calibration knobs, all disclosed rather than hidden (S11.3).
 */
@ConfigurationProperties(prefix = "pts.sim")
public class SimProperties {

    /**
     * Milliseconds added to each simulated network hop (JDBC query, controls-service call). The
     * in-process equivalent of the Toxiproxy latency toxic, for running the A/B without Docker.
     * Default 0: correctness tests must never pay for this.
     */
    private double hopLatencyMs = 0.0;

    public double getHopLatencyMs() {
        return hopLatencyMs;
    }

    public void setHopLatencyMs(double hopLatencyMs) {
        this.hopLatencyMs = hopLatencyMs;
    }
}
