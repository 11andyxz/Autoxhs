package com.adxztech.pts.common.crypto;

import com.adxztech.pts.common.util.Hex;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The cryptogram is the only thing standing between a captured token and a fraudulent authorization,
 * so each property it is supposed to have gets its own test (S7.4).
 */
class CryptogramServiceTest {

    private static final String TOKEN = "4999600000004822";
    private static final String UN = "A1B2C3D4";
    private static final int ATC = 41;
    private static final long AMOUNT = 4999;

    private final KeyService keyService = new JceKeyService("cryptogram-test-seed-000000");
    private final CryptogramService service = new CryptogramService(keyService);

    @Test
    @DisplayName("verification accepts the cryptogram it computed")
    void verifiesOwnCryptogram() {
        byte[] cryptogram = service.compute(TOKEN, ATC, UN, AMOUNT);
        assertThat(cryptogram).hasSize(8);
        assertThat(service.verify(TOKEN, ATC, UN, AMOUNT, cryptogram)).isTrue();
        assertThat(service.verifyHex(TOKEN, ATC, UN, AMOUNT, Hex.encode(cryptogram))).isTrue();
    }

    @Test
    @DisplayName("the cryptogram is bound to the amount: a $1 capture cannot authorize $1000")
    void boundToAmount() {
        byte[] cryptogram = service.compute(TOKEN, ATC, UN, 100);
        assertThat(service.verify(TOKEN, ATC, UN, 100_000, cryptogram)).isFalse();
    }

    @Test
    @DisplayName("the cryptogram is bound to the ATC: replaying it at a new counter fails")
    void boundToAtc() {
        byte[] cryptogram = service.compute(TOKEN, ATC, UN, AMOUNT);
        assertThat(service.verify(TOKEN, ATC + 1, UN, AMOUNT, cryptogram)).isFalse();
    }

    @Test
    @DisplayName("the cryptogram is bound to the unpredictable number: it is single-use")
    void boundToUnpredictableNumber() {
        byte[] cryptogram = service.compute(TOKEN, ATC, UN, AMOUNT);
        assertThat(service.verify(TOKEN, ATC, "DEADBEEF", AMOUNT, cryptogram)).isFalse();
    }

    @Test
    @DisplayName("the cryptogram is bound to the token: it cannot be presented with another token")
    void boundToToken() {
        byte[] cryptogram = service.compute(TOKEN, ATC, UN, AMOUNT);
        assertThat(service.verify("4999600000009999", ATC, UN, AMOUNT, cryptogram)).isFalse();
    }

    @Test
    @DisplayName("only the holder of the cryptogram key can produce a valid value")
    void requiresTheKey() {
        CryptogramService attacker =
                new CryptogramService(new JceKeyService("attacker-guessed-seed-00000"));
        byte[] forged = attacker.compute(TOKEN, ATC, UN, AMOUNT);
        assertThat(service.verify(TOKEN, ATC, UN, AMOUNT, forged)).isFalse();
    }

    @Test
    @DisplayName("malformed presented values are a failed verification, never an exception")
    void malformedInputsFailClosed() {
        assertThat(service.verify(TOKEN, ATC, UN, AMOUNT, null)).isFalse();
        assertThat(service.verify(TOKEN, ATC, UN, AMOUNT, new byte[7])).isFalse();
        assertThat(service.verify(TOKEN, ATC, UN, AMOUNT, new byte[9])).isFalse();
        assertThat(service.verifyHex(TOKEN, ATC, UN, AMOUNT, "not-hex-at-all!!")).isFalse();
        assertThat(service.verifyHex(TOKEN, ATC, UN, AMOUNT, "ABC")).isFalse();
        assertThat(service.verifyHex(TOKEN, ATC, UN, AMOUNT, null)).isFalse();
    }

    @Test
    @DisplayName("the unpredictable number is case-insensitive, so hex casing cannot decline a good auth")
    void unpredictableNumberIsCaseInsensitive() {
        byte[] cryptogram = service.compute(TOKEN, ATC, "a1b2c3d4", AMOUNT);
        assertThat(service.verify(TOKEN, ATC, "A1B2C3D4", AMOUNT, cryptogram)).isTrue();
    }

    @Test
    @DisplayName("the canonical input is separated, so no two distinct inputs collide")
    void canonicalInputIsUnambiguous() {
        // Without separators, ("4999...", atc=1, un="23") and ("4999...", atc=12, un="3") could
        // serialise identically and share a cryptogram. The pinned format prevents that.
        String a = new String(CryptogramService.canonicalInput(TOKEN, 0x0001, "AB", 5),
                StandardCharsets.UTF_8);
        String b = new String(CryptogramService.canonicalInput(TOKEN, 0x0012, "B", 5),
                StandardCharsets.UTF_8);
        assertThat(a).isNotEqualTo(b);
        assertThat(a).isEqualTo(TOKEN + "|0001|AB|5");
    }

    @Test
    @DisplayName("the canonical input rejects out-of-range values rather than silently truncating")
    void canonicalInputValidates() {
        assertThatThrownBy(() -> CryptogramService.canonicalInput(TOKEN, 0x10000, UN, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CryptogramService.canonicalInput(TOKEN, -1, UN, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CryptogramService.canonicalInput(TOKEN, ATC, UN, -1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CryptogramService.canonicalInput(null, ATC, UN, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CryptogramService.canonicalInput(TOKEN, ATC, "  ", 1))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("computation is stable across instances sharing a seed (switch vs harness agreement)")
    void stableAcrossInstances() {
        CryptogramService peer = new CryptogramService(new JceKeyService("cryptogram-test-seed-000000"));
        assertThat(peer.computeHex(TOKEN, ATC, UN, AMOUNT))
                .isEqualTo(service.computeHex(TOKEN, ATC, UN, AMOUNT));
    }
}
