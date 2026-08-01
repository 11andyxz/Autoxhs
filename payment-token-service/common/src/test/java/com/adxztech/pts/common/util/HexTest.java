package com.adxztech.pts.common.util;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HexTest {

    @Test
    @DisplayName("encodes to uppercase and decodes either case")
    void roundTrip() {
        byte[] bytes = {0x00, 0x0F, (byte) 0xA1, (byte) 0xFF, 0x7F};
        assertThat(Hex.encode(bytes)).isEqualTo("000FA1FF7F");
        assertThat(Hex.decode("000fa1ff7f")).isEqualTo(bytes);
        assertThat(Hex.decode("000FA1FF7F")).isEqualTo(bytes);
    }

    @Test
    @DisplayName("round trips arbitrary byte content")
    void randomRoundTrip() {
        Random random = new Random(11);
        for (int i = 0; i < 200; i++) {
            byte[] bytes = new byte[random.nextInt(64)];
            random.nextBytes(bytes);
            assertThat(Hex.decode(Hex.encode(bytes))).isEqualTo(bytes);
        }
    }

    @Test
    @DisplayName("tolerates surrounding whitespace, rejects odd length and non-hex characters")
    void validatesInput() {
        assertThat(Hex.decode("  A1B2  ")).isEqualTo(new byte[]{(byte) 0xA1, (byte) 0xB2});
        assertThat(Hex.encode(null)).isNull();
        assertThatThrownBy(() -> Hex.decode("ABC")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Hex.decode("ZZ")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Hex.decode(null)).isInstanceOf(IllegalArgumentException.class);
    }
}
