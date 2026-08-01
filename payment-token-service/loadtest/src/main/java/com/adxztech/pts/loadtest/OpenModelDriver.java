package com.adxztech.pts.loadtest;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.LockSupport;
import java.util.function.Function;

/**
 * Drives requests at a scheduled arrival rate and records honest tail latencies (S11.1).
 *
 * <p><b>The measurement that makes this trustworthy.</b> Latency is measured from the request's
 * <em>scheduled</em> arrival time, not from when a worker thread actually picked it up. If the system is
 * too slow and work backs up, that queueing delay lands in the histogram where it belongs. Timing from
 * pickup instead would silently subtract the backlog and report a healthy p99 for a saturated service --
 * which is the single most common way load-test numbers turn out to be fiction.
 *
 * <p>A single scheduler thread computes arrival times from the profile and hands each to a worker pool.
 * If the pool is saturated the request is still counted, as a rejection, rather than being dropped
 * silently: an unreported drop is indistinguishable from a fast success in the final numbers.
 */
public class OpenModelDriver {

    private static final Logger log = LoggerFactory.getLogger(OpenModelDriver.class);

    /** Outcome of one attempt, so failures are visible in the report rather than absorbed. */
    public enum Outcome {
        SUCCESS,
        REJECTED_BY_SERVICE,
        ERROR,
        DROPPED_NO_CAPACITY
    }

    public record Result(long attempted,
                         long succeeded,
                         long serviceRejected,
                         long errors,
                         long dropped,
                         long elapsedMillis,
                         LatencyHistogram.Snapshot latency,
                         double achievedRate,
                         double offeredRate,
                         String profile) {

        public double errorPercent() {
            return attempted == 0 ? 0 : 100.0 * (errors + dropped) / attempted;
        }
    }

    private final int workerThreads;

    public OpenModelDriver(int workerThreads) {
        this.workerThreads = Math.max(1, workerThreads);
    }

    /**
     * @param profile arrival-rate schedule
     * @param request performs one request and reports its outcome
     */
    public Result run(InjectionProfile profile, Function<Integer, Outcome> request) {
        LatencyHistogram histogram = new LatencyHistogram();
        AtomicLong attempted = new AtomicLong();
        AtomicLong succeeded = new AtomicLong();
        AtomicLong serviceRejected = new AtomicLong();
        AtomicLong errors = new AtomicLong();
        AtomicLong dropped = new AtomicLong();

        AtomicLong workerNumber = new AtomicLong();
        ThreadFactory factory = runnable -> {
            Thread t = new Thread(runnable);
            t.setName("load-worker-" + workerNumber.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
        ExecutorService workers = Executors.newFixedThreadPool(workerThreads, factory);

        long startNanos = System.nanoTime();
        int sequence = 0;

        try {
            for (InjectionProfile.Stage stage : profile.stages()) {
                long stageStartNanos = System.nanoTime();
                long stageDurationNanos = stage.durationMillis() * 1_000_000L;
                // Fractional arrival accumulator: at 2000/s the interval is 500us, well below the
                // resolution of any sleep primitive, so arrivals are scheduled by accumulated debt
                // rather than by sleeping per request.
                double owed = 0.0;
                long lastTickNanos = stageStartNanos;

                while (true) {
                    long nowNanos = System.nanoTime();
                    long offsetNanos = nowNanos - stageStartNanos;
                    if (offsetNanos >= stageDurationNanos) {
                        break;
                    }
                    double rate = stage.rateAt(offsetNanos / 1_000_000L);
                    owed += rate * (nowNanos - lastTickNanos) / 1_000_000_000.0;
                    lastTickNanos = nowNanos;

                    while (owed >= 1.0) {
                        owed -= 1.0;
                        // The scheduled arrival time IS now; latency is measured from here.
                        final long scheduledNanos = System.nanoTime();
                        final int id = sequence++;
                        attempted.incrementAndGet();
                        try {
                            workers.execute(() -> {
                                Outcome outcome;
                                try {
                                    outcome = request.apply(id);
                                } catch (RuntimeException e) {
                                    outcome = Outcome.ERROR;
                                }
                                histogram.record(System.nanoTime() - scheduledNanos);
                                switch (outcome) {
                                    case SUCCESS -> succeeded.incrementAndGet();
                                    case REJECTED_BY_SERVICE -> serviceRejected.incrementAndGet();
                                    default -> errors.incrementAndGet();
                                }
                            });
                        } catch (RejectedExecutionException e) {
                            dropped.incrementAndGet();
                        }
                    }
                    // Park briefly: fine enough to keep arrival timing accurate, coarse enough not to
                    // spend the whole core spinning in the scheduler.
                    LockSupport.parkNanos(200_000L);
                }
            }
        } finally {
            workers.shutdown();
            try {
                if (!workers.awaitTermination(60, TimeUnit.SECONDS)) {
                    log.warn("workers did not drain within 60s; in-flight requests are excluded");
                    workers.shutdownNow();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                workers.shutdownNow();
            }
        }

        long elapsedMillis = (System.nanoTime() - startNanos) / 1_000_000;
        double achievedRate = elapsedMillis == 0 ? 0 : attempted.get() * 1000.0 / elapsedMillis;
        double offeredRate = profile.totalDurationMillis() == 0 ? 0
                : profile.expectedArrivals() * 1000.0 / profile.totalDurationMillis();

        return new Result(attempted.get(), succeeded.get(), serviceRejected.get(), errors.get(),
                dropped.get(), elapsedMillis, histogram.snapshot(), achievedRate, offeredRate,
                profile.describe());
    }
}
