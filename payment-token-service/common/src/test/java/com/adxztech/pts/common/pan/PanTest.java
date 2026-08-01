package com.adxztech.pts.common.pan;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PanTest {

    @Test
    @DisplayName("normalises spaces and dashes that humans type")
    void normalisesFormatting() {
        assertThat(Pan.of("4111 1111 1111 1111").value()).isEqualTo("4111111111111111");
        assertThat(Pan.of("4111-1111-1111-1111").value()).isEqualTo("4111111111111111");
    }

    @Test
    @DisplayName("rejects short, long, non-Luhn and non-numeric values")
    void rejectsInvalid() {
        assertThatThrownBy(() -> Pan.of("41111111111")).isInstanceOf(InvalidPanException.class);
        assertThatThrownBy(() -> Pan.of("41111111111111111111")).isInstanceOf(InvalidPanException.class);
        assertThatThrownBy(() -> Pan.of("4111111111111112")).isInstanceOf(InvalidPanException.class);
        assertThatThrownBy(() -> Pan.of("4111x11111111111")).isInstanceOf(InvalidPanException.class);
        assertThatThrownBy(() -> Pan.of(null)).isInstanceOf(InvalidPanException.class);
    }

    @Test
    @DisplayName("exposes last4 and the 8-digit BIN used as the Oracle partition key")
    void exposesBinAndLast4() {
        Pan pan = Pan.of("4999600000004822");
        assertThat(pan.last4()).isEqualTo("4822");
        assertThat(pan.bin(6)).isEqualTo("499960");
        assertThat(pan.bin8()).isEqualTo(49996000L);
        assertThat(pan.length()).isEqualTo(16);
    }

    @Test
    @DisplayName("toString is masked so an accidental log or exception cannot leak the PAN")
    void toStringIsMasked() {
        Pan pan = Pan.of("4999600000004822");
        assertThat(pan.toString()).isEqualTo("499960******4822");
        assertThat(pan.toString()).doesNotContain("4999600000004822");
        // A 15-digit PAN masks a shorter middle but still hides everything between 6 and 4.
        assertThat(Pan.of("340000000000009").toString()).isEqualTo("340000*****0009");
    }

    @Test
    @DisplayName("equality is by digits, not identity")
    void equality() {
        assertThat(Pan.of("4111 1111 1111 1111")).isEqualTo(Pan.of("4111111111111111"));
        assertThat(Pan.of("4111111111111111")).isNotEqualTo(Pan.of("4999600000004822"));
    }
}
