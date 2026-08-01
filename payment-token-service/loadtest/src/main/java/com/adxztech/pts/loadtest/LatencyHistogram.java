package com.adxztech.pts.loadtest;

import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicLongArray;

/**
 * Lock-free latency histogram with resolution matched to a 22 ms budget (S11).
 *
 * <p>Bucket layout: 10 us up to 100 ms, then 1 ms up to 10 s, then an overflow bucket. A p99 quoted at
 * "22 ms" is meaningless if the recorder's bucket width is 10 ms, so the region the claim lives in gets
 * sub-100-microsecond resolution while the tail stays cheap.
 *
 * <p><b>Why not a mean.</b> Averages hide exactly the behaviour that matters here: a stall in 1 % of
 * authorizations barely moves the mean and is the entire p99 story. Only percentiles are recorded.
 */
public class LatencyHistogram {

    private static final int FINE_BUCKETS = 10_000;      // 10us each -> 0..100ms
    private static final long FINE_WIDTH_NANOS = 10_000L;
    private static final int COARSE_BUCKETS = 9_900;     // 1ms each  -> 100ms..10s
    private static final long COARSE_WIDTH_NANOS = 1_000_000L;
    private static final long FINE_LIMIT_NANOS = FINE_BUCKETS * FINE_WIDTH_NANOS;

    private final AtomicLongArray fine = new AtomicLongArray(FINE_BUCKETS);
    private final AtomicLongArray coarse = new AtomicLongArray(COARSE_BUCKETS);
    private final AtomicLong overflow = new AtomicLong();
    private final AtomicLong count = new AtomicLong();
    private final AtomicLong maxNanos = new AtomicLong();

    public void record(long nanos) {
        if (nanos < 0) {
            return;
        }
        count.incrementAndGet();
        maxNanos.accumulateAndGet(nanos, Math::max);

        if (nanos < FINE_LIMIT_NANOS) {
            fine.incrementAndGet((int) (nanos / FINE_WIDTH_NANOS));
            return;
        }
        int coarseIndex = (int) ((nanos - FINE_LIMIT_NANOS) / COARSE_WIDTH_NANOS);
        if (coarseIndex < COARSE_BUCKETS) {
            coarse.incrementAndGet(coarseIndex);
        } else {
            overflow.incrementAndGet();
        }
    }

    public long count() {
        return count.get();
    }

    public double maxMillis() {
        return maxNanos.get() / 1_000_000.0;
    }

    /**
     * @param percentile e.g. {@code 99.0} or {@code 99.9}
     * @return the latency at that percentile, in milliseconds
     */
    public double percentileMillis(double percentile) {
        long total = count.get();
        if (total == 0) {
            return 0.0;
        }
        // Nearest-rank: the smallest value at or below which at least `percentile`% of samples fall.
        long target = (long) Math.ceil(percentile / 100.0 * total);
        if (target < 1) {
            target = 1;
        }
        long cumulative = 0;

        for (int i = 0; i < FINE_BUCKETS; i++) {
            cumulative += fine.get(i);
            if (cumulative >= target) {
                // Upper edge of the bucket: quoting the lower edge would understate the percentile.
                return ((i + 1) * FINE_WIDTH_NANOS) / 1_000_000.0;
            }
        }
        for (int i = 0; i < COARSE_BUCKETS; i++) {
            cumulative += coarse.get(i);
            if (cumulative >= target) {
                return (FINE_LIMIT_NANOS + (i + 1) * COARSE_WIDTH_NANOS) / 1_000_000.0;
            }
        }
        return maxMillis();
    }

    public Snapshot snapshot() {
        return new Snapshot(count(), percentileMillis(50), percentileMillis(95), percentileMillis(99),
                percentileMillis(99.9), maxMillis());
    }

    public record Snapshot(long count, double p50, double p95, double p99, double p999, double max) {
    }
}
