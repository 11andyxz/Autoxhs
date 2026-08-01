package com.adxztech.pts.common.crypto;

import com.adxztech.pts.common.demo.DemoCards;
import com.adxztech.pts.common.util.Hex;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Covers the whole S7 cryptography story: HKDF, key wrapping, envelope encryption, fingerprints. */
class CryptoTest {

    private static final String SEED = "unit-test-seed-0123456789abcdef";
    private final KeyService keyService = new JceKeyService(SEED);

    @Nested
    class HkdfSpec {

        @Test
        @DisplayName("derivation is deterministic for the same seed and info")
        void deterministic() {
            byte[] a = Hkdf.derive("salt".getBytes(StandardCharsets.UTF_8),
                    SEED.getBytes(StandardCharsets.UTF_8), "label", 32);
            byte[] b = Hkdf.derive("salt".getBytes(StandardCharsets.UTF_8),
                    SEED.getBytes(StandardCharsets.UTF_8), "label", 32);
            assertThat(a).isEqualTo(b).hasSize(32);
        }

        @Test
        @DisplayName("different info labels yield independent keys")
        void domainSeparation() {
            byte[] prk = Hkdf.extract(null, SEED.getBytes(StandardCharsets.UTF_8));
            assertThat(Hkdf.expand(prk, "kek", 32)).isNotEqualTo(Hkdf.expand(prk, "mac", 32));
        }

        @Test
        @DisplayName("produces output longer than one hash block correctly")
        void multiBlockExpansion() {
            byte[] prk = Hkdf.extract(null, SEED.getBytes(StandardCharsets.UTF_8));
            byte[] long1 = Hkdf.expand(prk, "long", 100);
            byte[] long2 = Hkdf.expand(prk, "long", 100);
            assertThat(long1).hasSize(100).isEqualTo(long2);
            // The first 32 bytes must match the single-block derivation (RFC 5869 T(1) prefix).
            assertThat(java.util.Arrays.copyOf(long1, 32)).isEqualTo(Hkdf.expand(prk, "long", 32));
        }

        @Test
        @DisplayName("rejects impossible output lengths")
        void rejectsBadLength() {
            byte[] prk = Hkdf.extract(null, SEED.getBytes(StandardCharsets.UTF_8));
            assertThatThrownBy(() -> Hkdf.expand(prk, "x", 0))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> Hkdf.expand(prk, "x", 255 * 32 + 1))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Nested
    class KeyServiceSpec {

        @Test
        @DisplayName("a DEK survives a wrap/unwrap round trip under the KEK")
        void wrapUnwrapRoundTrip() {
            SecretKey dek = keyService.generateDek();
            assertThat(dek.getEncoded()).hasSize(32);
            byte[] wrapped = keyService.wrapDek(dek);
            assertThat(wrapped).isNotEqualTo(dek.getEncoded());
            assertThat(keyService.unwrapDek(wrapped).getEncoded()).isEqualTo(dek.getEncoded());
        }

        @Test
        @DisplayName("the wrapped DEK fits the key_registry column")
        void wrappedDekFitsColumn() {
            assertThat(keyService.wrapDek(keyService.generateDek()).length)
                    .isLessThanOrEqualTo(64); // key_registry.wrapped_dek is RAW(64)
        }

        @Test
        @DisplayName("a different seed cannot unwrap another deployment's DEK")
        void seedIsolation() {
            byte[] wrapped = keyService.wrapDek(keyService.generateDek());
            KeyService otherDeployment = new JceKeyService("a-completely-different-seed-value");
            assertThatThrownBy(() -> otherDeployment.unwrapDek(wrapped))
                    .isInstanceOf(KeyServiceException.class);
        }

        @Test
        @DisplayName("every service configured with the same seed derives the same keys")
        void sharedSeedYieldsSharedKeys() {
            // This is what lets the provisioning service seal a PAN that the detokenization service
            // can open, without a shared keystore file.
            KeyService peer = new JceKeyService(SEED);
            byte[] input = "same-input".getBytes(StandardCharsets.UTF_8);
            assertThat(peer.cryptogramMac(input)).isEqualTo(keyService.cryptogramMac(input));
            assertThat(peer.fingerprintMac(input)).isEqualTo(keyService.fingerprintMac(input));
        }

        @Test
        @DisplayName("cryptogram and fingerprint keys are independent")
        void keysAreIndependent() {
            byte[] input = "x".getBytes(StandardCharsets.UTF_8);
            assertThat(keyService.cryptogramMac(input)).isNotEqualTo(keyService.fingerprintMac(input));
        }

        @Test
        @DisplayName("refuses a seed too short to carry meaningful entropy")
        void rejectsWeakSeed() {
            assertThatThrownBy(() -> new JceKeyService("short"))
                    .isInstanceOf(KeyServiceException.class);
            assertThatThrownBy(() -> new JceKeyService(null))
                    .isInstanceOf(KeyServiceException.class);
        }

        @Test
        @DisplayName("describes itself as a dev stand-in, so nobody mistakes it for an HSM")
        void describesItselfHonestly() {
            assertThat(keyService.describe()).contains("NOT a security boundary");
        }
    }

    @Nested
    class EnvelopeCipherSpec {

        private final EnvelopeCipher cipher = new EnvelopeCipher();
        private final SecretKey dek = keyService.generateDek();
        private final String tokenPan = "4999600000004822";

        @Test
        @DisplayName("a funding PAN survives a seal/open round trip")
        void roundTrip() {
            byte[] blob = cipher.seal(dek, DemoCards.ISSA_APPROVE, tokenPan);
            assertThat(cipher.open(dek, blob, tokenPan)).isEqualTo(DemoCards.ISSA_APPROVE);
        }

        @Test
        @DisplayName("ciphertext never contains the plaintext and fits the vault column")
        void ciphertextIsOpaqueAndFitsColumn() {
            byte[] blob = cipher.seal(dek, DemoCards.ISSA_APPROVE, tokenPan);
            assertThat(new String(blob, StandardCharsets.ISO_8859_1))
                    .doesNotContain(DemoCards.ISSA_APPROVE);
            // IV(12) + ciphertext(16) + tag(16) = 44 bytes for a 16-digit PAN.
            assertThat(blob).hasSize(44);
            assertThat(blob.length).isLessThanOrEqualTo(120); // funding_pan_enc column width
        }

        @Test
        @DisplayName("the IV is fresh per record, so the same PAN never yields the same ciphertext")
        void ivIsUniquePerRecord() {
            Set<String> ciphertexts = new HashSet<>();
            for (int i = 0; i < 500; i++) {
                ciphertexts.add(Hex.encode(cipher.seal(dek, DemoCards.ISSA_APPROVE, tokenPan)));
            }
            assertThat(ciphertexts).hasSize(500);
        }

        @Test
        @DisplayName("tampering with the ciphertext is detected, not silently decrypted")
        void detectsTampering() {
            byte[] blob = cipher.seal(dek, DemoCards.ISSA_APPROVE, tokenPan);
            blob[20] ^= 0x01;
            assertThatThrownBy(() -> cipher.open(dek, blob, tokenPan))
                    .isInstanceOf(EnvelopeCipher.TamperedCiphertextException.class);
        }

        @Test
        @DisplayName("ciphertext is bound to its token: it cannot be lifted onto another vault row")
        void aadBindsCiphertextToTheRow() {
            // Without AAD binding, copying funding_pan_enc from token A to token B would silently
            // re-point token B at another cardholder's funding account.
            byte[] blob = cipher.seal(dek, DemoCards.ISSA_APPROVE, tokenPan);
            assertThatThrownBy(() -> cipher.open(dek, blob, "4999600000009999"))
                    .isInstanceOf(EnvelopeCipher.TamperedCiphertextException.class);
        }

        @Test
        @DisplayName("the wrong key version fails authentication rather than returning garbage")
        void wrongKeyFails() {
            byte[] blob = cipher.seal(dek, DemoCards.ISSA_APPROVE, tokenPan);
            SecretKey otherVersion = keyService.generateDek();
            assertThatThrownBy(() -> cipher.open(otherVersion, blob, tokenPan))
                    .isInstanceOf(EnvelopeCipher.TamperedCiphertextException.class);
        }

        @Test
        @DisplayName("a truncated blob is rejected before any crypto is attempted")
        void rejectsTruncatedBlob() {
            assertThatThrownBy(() -> cipher.open(dek, new byte[10], tokenPan))
                    .isInstanceOf(EnvelopeCipher.TamperedCiphertextException.class);
            assertThatThrownBy(() -> cipher.open(dek, null, tokenPan))
                    .isInstanceOf(EnvelopeCipher.TamperedCiphertextException.class);
        }
    }

    @Nested
    class PanFingerprintSpec {

        private final PanFingerprint fingerprint = new PanFingerprint(keyService);

        @Test
        @DisplayName("the same card always fingerprints identically, so reissue lookup is an index probe")
        void deterministic() {
            assertThat(fingerprint.compute(DemoCards.ISSA_APPROVE))
                    .isEqualTo(fingerprint.compute("4111 1000 0000 0725"))
                    .hasSize(32);
        }

        @Test
        @DisplayName("different cards fingerprint differently")
        void distinctCards() {
            assertThat(fingerprint.compute(DemoCards.ISSA_APPROVE))
                    .isNotEqualTo(fingerprint.compute(DemoCards.ISSA_APPROVE_2));
        }

        @Test
        @DisplayName("the fingerprint is keyed, so a stolen table cannot be brute-forced offline")
        void isKeyedNotABareHash() throws Exception {
            // A bare SHA-256 of a 16-digit PAN is enumerable in minutes on a GPU. Two properties must
            // hold: another deployment's key produces different values, and the value is not simply
            // SHA-256(pan), which an attacker holding only the table could recompute.
            PanFingerprint otherDeployment =
                    new PanFingerprint(new JceKeyService("another-deployment-seed-value"));
            assertThat(otherDeployment.compute(DemoCards.ISSA_APPROVE))
                    .isNotEqualTo(fingerprint.compute(DemoCards.ISSA_APPROVE));

            byte[] bareSha256 = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(DemoCards.ISSA_APPROVE.getBytes(StandardCharsets.UTF_8));
            assertThat(fingerprint.compute(DemoCards.ISSA_APPROVE)).isNotEqualTo(bareSha256);
        }
    }

    @Nested
    class ConstantTimeSpec {

        @Test
        @DisplayName("compares equal and unequal arrays without short-circuiting on content")
        void comparison() {
            assertThat(ConstantTime.equals(new byte[]{1, 2, 3}, new byte[]{1, 2, 3})).isTrue();
            assertThat(ConstantTime.equals(new byte[]{1, 2, 3}, new byte[]{1, 2, 4})).isFalse();
            assertThat(ConstantTime.equals(new byte[]{1, 2, 3}, new byte[]{1, 2})).isFalse();
            assertThat(ConstantTime.equals(null, new byte[]{1})).isFalse();
            assertThat(ConstantTime.equals(new byte[]{1}, null)).isFalse();
        }
    }
}
