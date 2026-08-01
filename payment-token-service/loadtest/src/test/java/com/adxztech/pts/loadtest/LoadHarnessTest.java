package com.adxztech.pts.loadtest;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Tests for the measuring instrument itself.
 *
 * <p>A load harness reports the numbers a performance claim rests on, so its own correctness has to be
 * established first. A histogram that quietly reports the wrong percentile, or a feeder that is
 * accidentally uniform, produces confident numbers that mean nothing -- and nobody would notice.
 */
class LoadHarnessTest {

    @Nested
    class Histogram {

        @Test
        @DisplayName("percentiles are correct for a known distribution")
        void knownDistribution() {
            LatencyHistogram histogram = new LatencyHistogram();
            // 990 samples at 10ms, 10 at 100ms: p50 and p95 sit in the body, p99 in the tail.
            for (int i = 0; i < 990; i++) {
                histogram.record(10_000_000L);
            }
            for (int i = 0; i < 10; i++) {
                histogram.record(100_000_000L);
            }

            assertThat(histogram.count()).isEqualTo(1000);
            assertThat(histogram.percentileMillis(50)).isCloseTo(10.0, within(0.05));
            assertThat(histogram.percentileMillis(95)).isCloseTo(10.0, within(0.05));
            assertThat(histogram.percentileMillis(99)).isCloseTo(10.0, within(0.05));
            // The last 1% are the 100ms samples.
            assertThat(histogram.percentileMillis(99.5)).isGreaterThanOrEqualTo(100.0);
            assertThat(histogram.maxMillis()).isCloseTo(100.0, within(0.5));
        }

        @Test
        @DisplayName("resolution around the 22ms budget is fine enough to distinguish 20ms from 25ms")
        void resolutionAtTheBudget() {
            // A recorder with 10ms buckets would put both of these in one bucket and make the whole
            // 38ms -> 22ms claim unmeasurable.
            LatencyHistogram histogram = new LatencyHistogram();
            for (int i = 0; i < 100; i++) {
                histogram.record(20_000_000L);
            }
            for (int i = 0; i < 100; i++) {
                histogram.record(25_000_000L);
            }
            assertThat(histogram.percentileMillis(25)).isCloseTo(20.0, within(0.05));
            assertThat(histogram.percentileMillis(75)).isCloseTo(25.0, within(0.05));
        }

        @Test
        @DisplayName("monotonic in the percentile requested")
        void monotonic() {
            LatencyHistogram histogram = new LatencyHistogram();
            Random random = new Random(7);
            for (int i = 0; i < 20_000; i++) {
                histogram.record((long) (random.nextExponential() * 5_000_000L));
            }
            double p50 = histogram.percentileMillis(50);
            double p95 = histogram.percentileMillis(95);
            double p99 = histogram.percentileMillis(99);
            double p999 = histogram.percentileMillis(99.9);
            assertThat(p50).isLessThanOrEqualTo(p95);
            assertThat(p95).isLessThanOrEqualTo(p99);
            assertThat(p99).isLessThanOrEqualTo(p999);
            assertThat(p999).isLessThanOrEqualTo(histogram.maxMillis());
        }

        @Test
        @DisplayName("handles multi-second outliers and an empty histogram without lying")
        void edgeCases() {
            LatencyHistogram empty = new LatencyHistogram();
            assertThat(empty.count()).isZero();
            assertThat(empty.percentileMillis(99)).isZero();

            LatencyHistogram histogram = new LatencyHistogram();
            histogram.record(1_000_000L);
            histogram.record(5_000_000_000L); // 5s
            assertThat(histogram.maxMillis()).isCloseTo(5000.0, within(1.0));
            assertThat(histogram.percentileMillis(100)).isGreaterThan(1000.0);
        }

        private org.assertj.core.data.Offset<Double> within(double tolerance) {
            return org.assertj.core.data.Offset.offset(tolerance);
        }
    }

    @Nested
    class Feeder {

        private List<String> pool(int size) {
            List<String> tokens = new ArrayList<>(size);
            for (int i = 0; i < size; i++) {
                tokens.add(String.format("499960000000%04d", i));
            }
            return tokens;
        }

        @Test
        @DisplayName("selection is genuinely skewed, which is what makes the cache benefit realistic")
        void isSkewed() {
            ZipfianFeeder feeder = new ZipfianFeeder(pool(10_000), 1.0);
            Map<String, Integer> hits = new HashMap<>();
            Random random = new Random(11);
            int draws = 200_000;
            for (int i = 0; i < draws; i++) {
                hits.merge(feeder.next(random), 1, Integer::sum);
            }

            List<Integer> ranked = new ArrayList<>(hits.values());
            ranked.sort((a, b) -> Integer.compare(b, a));
            int top100 = ranked.subList(0, Math.min(100, ranked.size()))
                    .stream().mapToInt(Integer::intValue).sum();
            // At exponent 1.0 over a 10k pool the hottest 1% take a large share of traffic. A uniform
            // feeder would give ~1%.
            assertThat((double) top100 / draws).isGreaterThan(0.15);
            assertThat(feeder.topShare(100)).isGreaterThan(0.15);
        }

        @Test
        @DisplayName("exponent 0 degenerates to uniform, so the skew is genuinely coming from the exponent")
        void exponentZeroIsUniform() {
            ZipfianFeeder feeder = new ZipfianFeeder(pool(1_000), 0.0);
            Map<String, Integer> hits = new HashMap<>();
            Random random = new Random(3);
            for (int i = 0; i < 100_000; i++) {
                hits.merge(feeder.next(random), 1, Integer::sum);
            }
            List<Integer> ranked = new ArrayList<>(hits.values());
            ranked.sort((a, b) -> Integer.compare(b, a));
            int top10 = ranked.subList(0, 10).stream().mapToInt(Integer::intValue).sum();
            assertThat((double) top10 / 100_000).isLessThan(0.03); // ~1% expected
        }

        @Test
        @DisplayName("every token remains reachable, so the pool is not effectively smaller than declared")
        void allTokensReachable() {
            ZipfianFeeder feeder = new ZipfianFeeder(pool(50), 1.0);
            java.util.Set<String> seen = new java.util.HashSet<>();
            Random random = new Random(5);
            for (int i = 0; i < 200_000; i++) {
                seen.add(feeder.next(random));
            }
            assertThat(seen).hasSize(50);
        }

        @Test
        @DisplayName("rejects an empty pool and a negative exponent")
        void validatesInput() {
            assertThatThrownBy(() -> new ZipfianFeeder(List.of(), 1.0))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> new ZipfianFeeder(pool(10), -1))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Nested
    class Profile {

        @Test
        @DisplayName("parses the documented three-stage peak profile")
        void parsesPeakProfile() {
            InjectionProfile profile =
                    InjectionProfile.parse("ramp:50->2000/120s,constant:2000/300s,spike:6000/30s");

            assertThat(profile.stages()).hasSize(3);
            assertThat(profile.totalDurationMillis()).isEqualTo(450_000);
            // ramp average 1025/s * 120s + 2000 * 300 + 6000 * 30 = 123000 + 600000 + 180000
            assertThat(profile.expectedArrivals()).isEqualTo(903_000);
            assertThat(profile.describe()).contains("ramp").contains("constant");
        }

        @Test
        @DisplayName("a ramp interpolates linearly and is clamped at both ends")
        void rampInterpolates() {
            InjectionProfile profile = InjectionProfile.parse("ramp:100->1100/10s");
            InjectionProfile.Stage stage = profile.stages().get(0);
            assertThat(stage.rateAt(0)).isEqualTo(100.0);
            assertThat(stage.rateAt(5_000)).isEqualTo(600.0);
            assertThat(stage.rateAt(10_000)).isEqualTo(1100.0);
            assertThat(stage.rateAt(99_999)).isEqualTo(1100.0); // clamped, never extrapolated
        }

        @Test
        @DisplayName("accepts ms, s and m durations")
        void durationUnits() {
            assertThat(InjectionProfile.parse("constant:10/500ms").totalDurationMillis()).isEqualTo(500);
            assertThat(InjectionProfile.parse("constant:10/2s").totalDurationMillis()).isEqualTo(2000);
            assertThat(InjectionProfile.parse("constant:10/2m").totalDurationMillis()).isEqualTo(120_000);
        }

        @Test
        @DisplayName("malformed profiles fail loudly rather than silently running the wrong load")
        void rejectsMalformed() {
            assertThatThrownBy(() -> InjectionProfile.parse(null))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> InjectionProfile.parse("constant"))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> InjectionProfile.parse("constant:100"))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> InjectionProfile.parse("ramp:100/10s"))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> InjectionProfile.parse("teleport:100/10s"))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> InjectionProfile.parse("constant:100/0s"))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Nested
    class Driver {

        @Test
        @DisplayName("offers approximately the requested arrival rate")
        void honoursTheArrivalRate() {
            AtomicInteger handled = new AtomicInteger();
            OpenModelDriver driver = new OpenModelDriver(16);
            OpenModelDriver.Result result = driver.run(
                    InjectionProfile.parse("constant:200/1s"),
                    id -> {
                        handled.incrementAndGet();
                        return OpenModelDriver.Outcome.SUCCESS;
                    });

            // Loose bounds: this asserts the scheduler is not off by an order of magnitude, which is the
            // failure that would matter. A tight bound would just be a flaky test on a busy machine.
            assertThat(result.attempted()).isBetween(100L, 400L);
            assertThat(result.succeeded()).isEqualTo(result.attempted() - result.errors()
                    - result.serviceRejected() - result.dropped());
            assertThat(handled.get()).isEqualTo((int) result.attempted() - (int) result.dropped());
            assertThat(result.errorPercent()).isZero();
        }

        @Test
        @DisplayName("service rejections are counted separately from errors")
        void separatesRejectionsFromErrors() {
            OpenModelDriver.Result result = new OpenModelDriver(8).run(
                    InjectionProfile.parse("constant:100/1s"),
                    id -> id % 2 == 0
                            ? OpenModelDriver.Outcome.REJECTED_BY_SERVICE
                            : OpenModelDriver.Outcome.SUCCESS);

            assertThat(result.serviceRejected()).isPositive();
            assertThat(result.succeeded()).isPositive();
            // A 422 is a business outcome, not a failure of the run.
            assertThat(result.errors()).isZero();
            assertThat(result.errorPercent()).isZero();
        }

        @Test
        @DisplayName("an exception in the request function is recorded, not swallowed")
        void recordsThrownErrors() {
            OpenModelDriver.Result result = new OpenModelDriver(4).run(
                    InjectionProfile.parse("constant:50/1s"),
                    id -> {
                        throw new IllegalStateException("simulated transport failure");
                    });
            assertThat(result.errors()).isPositive();
            assertThat(result.succeeded()).isZero();
            assertThat(result.errorPercent()).isGreaterThan(0.0);
        }

        @Test
        @DisplayName("slow responses inflate the recorded latency rather than throttling the offered load")
        void noCoordinatedOmission() {
            // Two workers cannot keep up with 100 arrivals/s of 50ms work. A closed-model harness would
            // simply offer less load and report ~50ms. An open-model one must keep offering and record the
            // queueing delay, so the measured latency exceeds the service time.
            OpenModelDriver.Result result = new OpenModelDriver(2).run(
                    InjectionProfile.parse("constant:100/1s"),
                    id -> {
                        try {
                            Thread.sleep(50);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        return OpenModelDriver.Outcome.SUCCESS;
                    });

            assertThat(result.attempted()).isGreaterThan(50L);
            assertThat(result.latency().p99())
                    .withFailMessage("queueing delay was not captured: p99 %.1fms is not above the "
                            + "50ms service time", result.latency().p99())
                    .isGreaterThan(50.0);
        }
    }
}
