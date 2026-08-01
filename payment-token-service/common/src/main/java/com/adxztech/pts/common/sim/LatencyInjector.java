package com.adxztech.pts.common.sim;

import java.util.concurrent.locks.LockSupport;

/**
 * Adds a fixed delay to a simulated network hop -- the in-process stand-in for Toxiproxy (S11.3).
 *
 * <p><b>Why this exists and why it is disclosed.</b> On one laptop, a local database answers in well
 * under a millisecond. Measured there, removing a round trip looks like removing nothing, and the
 * before/after percentile curves say nothing about production. Toxiproxy solves this properly in the
 * Docker Compose stack by injecting ~6-8 ms RTT on the JDBC and controls-service paths. This class
 * gives the same calibration to the pure-JVM local stack, which is the one that runs without Docker.
 *
 * <p>The honest claim is about <em>shape</em>: removing N synchronous round trips of ~7 ms each. The
 * absolute milliseconds are host- and calibration-dependent, and saying so is the difference between
 * a credible number and a laptop number presented as production truth.
 *
 * <p>Default is {@code 0} -- disabled -- so unit and integration tests are fast and this never
 * silently distorts a correctness test.
 */
public class LatencyInjector {

    private final long delayNanos;

    public LatencyInjector(double hopLatencyMillis) {
        if (hopLatencyMillis < 0) {
            throw new IllegalArgumentException("hop latency must be >= 0");
        }
        this.delayNanos = (long) (hopLatencyMillis * 1_000_000L);
    }

    public static LatencyInjector disabled() {
        return new LatencyInjector(0);
    }

    public boolean enabled() {
        return delayNanos > 0;
    }

    public double hopLatencyMillis() {
        return delayNanos / 1_000_000.0;
    }

    /**
     * Simulates one network round trip. Called at each site that would cross a rack in production:
     * a JDBC query and a call to token-controls-service.
     */
    public void hop() {
        if (delayNanos <= 0) {
            return;
        }
        // parkNanos rather than Thread.sleep: no InterruptedException to swallow, and it does not
        // clear the interrupt flag out from under a shutting-down request thread.
        long deadline = System.nanoTime() + delayNanos;
        long remaining = delayNanos;
        while (remaining > 0) {
            LockSupport.parkNanos(remaining);
            remaining = deadline - System.nanoTime();
        }
    }

    @Override
    public String toString() {
        return enabled()
                ? "LatencyInjector[" + hopLatencyMillis() + "ms per simulated hop]"
                : "LatencyInjector[disabled]";
    }
}
