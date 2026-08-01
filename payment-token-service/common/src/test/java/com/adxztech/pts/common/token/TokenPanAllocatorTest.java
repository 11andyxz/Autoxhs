package com.adxztech.pts.common.token;

import com.adxztech.pts.common.pan.Luhn;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Random;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TokenPanAllocatorTest {

    private final TokenBinRange range = new TokenBinRange(49996000L, 49996100L, "ISSA", false);

    @Test
    @DisplayName("allocated tokens are 16 digits, Luhn-valid, and inside the issuer's BIN range")
    void allocatesValidTokensInsideRange() {
        TokenPanAllocator allocator = new TokenPanAllocator(new Random(42));
        for (int i = 0; i < 5_000; i++) {
            String token = allocator.allocate(range);
            assertThat(token).hasSize(16);
            assertThat(Luhn.isValid(token)).withFailMessage("not Luhn-valid: %s", token).isTrue();
            long bin = Long.parseLong(token.substring(0, 8));
            assertThat(range.contains(bin))
                    .withFailMessage("BIN %d outside [%d,%d)", bin, range.binStart(), range.binEnd())
                    .isTrue();
        }
    }

    @Test
    @DisplayName("BINs spread across the range so tokens land in several Oracle partitions")
    void spreadsAcrossRange() {
        TokenPanAllocator allocator = new TokenPanAllocator(new Random(7));
        Set<Long> bins = new HashSet<>();
        for (int i = 0; i < 2_000; i++) {
            bins.add(Long.parseLong(allocator.allocate(range).substring(0, 8)));
        }
        // A single-BIN allocator would put every token of an issuer in one partition segment.
        assertThat(bins).hasSizeGreaterThan(50);
    }

    @Test
    @DisplayName("collisions are rare enough to rely on the vault primary key for uniqueness")
    void allocationsAreEffectivelyUnique() {
        TokenPanAllocator allocator = new TokenPanAllocator(new Random(99));
        Set<String> tokens = new HashSet<>();
        for (int i = 0; i < 20_000; i++) {
            tokens.add(allocator.allocate(range));
        }
        assertThat(tokens).hasSizeGreaterThan(19_900);
    }

    @Test
    @DisplayName("token expiry outlives the funding card so a reissue does not break the wallet")
    void tokenExpiryOutlivesFundingExpiry() {
        assertThat(TokenPanAllocator.deriveTokenExpiry("2812")).isEqualTo("3112");
        assertThat(TokenPanAllocator.deriveTokenExpiry("2601")).isEqualTo("2901");
        assertThat(TokenPanAllocator.deriveTokenExpiry("9912")).isEqualTo("9912"); // capped, not wrapped
        assertThatThrownBy(() -> TokenPanAllocator.deriveTokenExpiry("281"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("BIN ranges validate their own bounds")
    void rangeValidation() {
        assertThatThrownBy(() -> new TokenBinRange(1234L, 49996100L, "ISSA", false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TokenBinRange(49996100L, 49996000L, "ISSA", false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TokenBinRange(49996000L, 49996100L, " ", false))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
