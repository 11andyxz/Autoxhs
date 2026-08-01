package com.adxztech.pts.common.pan;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LuhnTest {

    @ParameterizedTest
    @ValueSource(strings = {
            "4111111111111111",   // canonical Visa test number
            "5500005555555559",
            "340000000000009",    // 15 digits
            "4999600000004822",   // demo token BIN range
            "4111100000000725",   // demo funding card
            "79927398713"         // ISO/IEC 7812-1 worked example
    })
    @DisplayName("accepts known-valid account numbers")
    void acceptsValid(String pan) {
        assertThat(Luhn.isValid(pan)).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "4111111111111112",   // last digit off by one
            "79927398710",
            "79927398711",
            "0000000000000001"
    })
    @DisplayName("rejects account numbers with a wrong check digit")
    void rejectsInvalid(String pan) {
        assertThat(Luhn.isValid(pan)).isFalse();
    }

    @Test
    @DisplayName("rejects null, too-short and non-numeric input instead of throwing")
    void rejectsMalformed() {
        assertThat(Luhn.isValid(null)).isFalse();
        assertThat(Luhn.isValid("")).isFalse();
        assertThat(Luhn.isValid("4")).isFalse();
        assertThat(Luhn.isValid("4111-1111-1111-1111")).isFalse();
        assertThat(Luhn.isValid("41111111111111a1")).isFalse();
    }

    @Test
    @DisplayName("completing a prefix yields a valid PAN one digit longer")
    void completeProducesValidPan() {
        String completed = Luhn.complete("411111111111111");
        assertThat(completed).isEqualTo("4111111111111111");
        assertThat(Luhn.isValid(completed)).isTrue();
    }

    @Test
    @DisplayName("every 7-digit suffix under a token BIN completes to a Luhn-valid 16-digit token")
    void completeIsCorrectForEveryTokenSuffix() {
        // The allocator generates BIN(8) + random(7) and appends a check digit. If checkDigit were
        // off for any parity, tokens would be rejected by legacy validation gates on the rails.
        for (int suffix = 0; suffix < 3000; suffix++) {
            String prefix = "49996000" + String.format("%07d", suffix);
            String token = Luhn.complete(prefix);
            assertThat(token).hasSize(16);
            assertThat(Luhn.isValid(token))
                    .withFailMessage("suffix %d produced non-Luhn token %s", suffix, token)
                    .isTrue();
        }
    }

    @Test
    @DisplayName("checkDigit rejects non-numeric input")
    void checkDigitValidatesInput() {
        assertThatThrownBy(() -> Luhn.checkDigit("12a4"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Luhn.checkDigit(""))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
