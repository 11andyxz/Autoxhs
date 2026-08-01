package com.adxztech.pts.common.sim;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LatencyInjectorTest {

    @Test
    @DisplayName("disabled by default so correctness tests never pay for calibration")
    void disabledIsFree() {
        LatencyInjector injector = LatencyInjector.disabled();
        assertThat(injector.enabled()).isFalse();
        long start = System.nanoTime();
        for (int i = 0; i < 10_000; i++) {
            injector.hop();
        }
        assertThat(System.nanoTime() - start).isLessThan(50_000_000L); // 10k no-op hops well under 50ms
        assertThat(injector.toString()).contains("disabled");
    }

    @Test
    @DisplayName("a configured hop actually waits at least the requested time")
    void hopWaits() {
        LatencyInjector injector = new LatencyInjector(6);
        assertThat(injector.enabled()).isTrue();
        assertThat(injector.hopLatencyMillis()).isEqualTo(6.0);

        long start = System.nanoTime();
        injector.hop();
        long elapsedMs = (System.nanoTime() - start) / 1_000_000;
        // At least the requested delay; upper bound is generous because parkNanos may overshoot
        // on a loaded machine and a flaky timing test is worse than a loose one.
        assertThat(elapsedMs).isGreaterThanOrEqualTo(6L).isLessThan(500L);
    }

    @Test
    @DisplayName("rejects a negative delay")
    void rejectsNegative() {
        assertThatThrownBy(() -> new LatencyInjector(-1))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
