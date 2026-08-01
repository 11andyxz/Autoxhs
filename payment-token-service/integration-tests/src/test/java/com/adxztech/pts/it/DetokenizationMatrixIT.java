package com.adxztech.pts.it;

import com.adxztech.pts.common.api.DetokenizeRequest;
import com.adxztech.pts.common.api.DetokenizeResponse;
import com.adxztech.pts.common.demo.DemoCards;
import com.adxztech.pts.common.vault.VaultRecord;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.http.ResponseEntity;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The behavioural-equivalence proof for the latency optimizations (S8.2).
 *
 * <p>Every test here runs against all four points of the {@code cache-mode} x {@code controls.inline}
 * matrix. That is the whole point: the optimizations remove network round trips, and they must not change
 * a single authorization outcome. An optimization that quietly declines something the baseline approved --
 * or worse, approves something the baseline declined -- is not faster, it is broken.
 *
 * <p>Each parameterisation provisions its own token so the four services cannot interfere through shared
 * ATC state (two of them keep the counter in the cluster, two in the database).
 */
class DetokenizationMatrixIT extends IntegrationTestBase {

    private String freshToken() {
        return client.provisionActiveToken(ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("the service reports the flag combination it is actually running")
    void reportsItsConfiguration(StackFixture.Flavour flavour) {
        Map<String, String> config = client.detokConfig(flavour);
        assertThat(config.get("cacheMode")).isEqualTo(flavour.cacheMode);
        assertThat(config.get("controlsInline")).isEqualTo(String.valueOf(flavour.controlsInline));
        assertThat(config.get("atcMode")).isEqualTo(flavour.atcMode);
        // The default ordering is the safe one; see DetokenizationService for why it deviates from S6.1.
        assertThat(config.get("atcOrder")).isEqualTo("AFTER_CRYPTOGRAM");
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("a valid authorization returns the funding PAN")
    void happyPath(StackFixture.Flavour flavour) {
        String tokenRef = freshToken();
        VaultRecord record = client.vault(tokenRef);

        ResponseEntity<DetokenizeResponse> response =
                client.detokenize(flavour, client.validRequest(tokenRef, 1, 4999));

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        DetokenizeResponse body = response.getBody();
        assertThat(body).isNotNull();
        assertThat(body.isProceed()).isTrue();
        assertThat(body.fundingPan()).endsWith(record.fundingLast4());
        assertThat(body.fundingExpiry()).isEqualTo(record.fundingExpiry());
        assertThat(body.tokenRef()).isEqualTo(tokenRef);
        assertThat(body.issuerId()).isEqualTo("ISSA");
        assertThat(body.reason()).isNull();
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("an unknown token is TOKEN_NOT_FOUND")
    void unknownToken(StackFixture.Flavour flavour) {
        DetokenizeRequest request = new DetokenizeRequest("4999609999999995",
                "0011223344556677", 1, "A1B2C3D4", 100, DemoCards.WALLET_REQUESTOR, "ECOM");
        assertReject(client.detokenize(flavour, request), "TOKEN_NOT_FOUND");
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("a suspended token is TOKEN_NOT_ACTIVE")
    void suspendedToken(StackFixture.Flavour flavour) {
        String tokenRef = freshToken();
        client.suspend(tokenRef);
        assertReject(client.detokenize(flavour, client.validRequest(tokenRef, 1, 4999)),
                "TOKEN_NOT_ACTIVE");
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("a deleted token is TOKEN_NOT_ACTIVE")
    void deletedToken(StackFixture.Flavour flavour) {
        String tokenRef = freshToken();
        client.delete(tokenRef);
        assertReject(client.detokenize(flavour, client.validRequest(tokenRef, 1, 4999)),
                "TOKEN_NOT_ACTIVE");
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("another requestor presenting the token is DOMAIN_MISMATCH")
    void wrongRequestor(StackFixture.Flavour flavour) {
        String tokenRef = freshToken();
        VaultRecord record = client.vault(tokenRef);
        String un = "A1B2C3D4";
        // A perfectly valid cryptogram: only the presenter is wrong. This is the control that makes a
        // stolen token worthless outside its binding.
        DetokenizeRequest request = new DetokenizeRequest(record.tokenPan(),
                client.cryptogramService().computeHex(record.tokenPan(), 1, un, 4999),
                1, un, 4999, DemoCards.OTHER_REQUESTOR, "ECOM");
        assertReject(client.detokenize(flavour, request), "DOMAIN_MISMATCH");
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("presenting an ECOM-bound token as CONTACTLESS is DOMAIN_MISMATCH")
    void wrongDomain(StackFixture.Flavour flavour) {
        String tokenRef = freshToken();
        VaultRecord record = client.vault(tokenRef);
        String un = "A1B2C3D4";
        DetokenizeRequest request = new DetokenizeRequest(record.tokenPan(),
                client.cryptogramService().computeHex(record.tokenPan(), 1, un, 4999),
                1, un, 4999, record.requestorId(), "CONTACTLESS");
        assertReject(client.detokenize(flavour, request), "DOMAIN_MISMATCH");
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("re-presenting a used ATC is REPLAY_SUSPECTED, and a lower one too")
    void replayRejected(StackFixture.Flavour flavour) {
        String tokenRef = freshToken();

        assertThat(client.detokenize(flavour, client.validRequest(tokenRef, 5, 4999))
                .getBody().isProceed()).isTrue();

        assertReject(client.detokenize(flavour, client.validRequest(tokenRef, 5, 4999)),
                "REPLAY_SUSPECTED");
        assertReject(client.detokenize(flavour, client.validRequest(tokenRef, 4, 4999)),
                "REPLAY_SUSPECTED");
        // The counter still advances for a genuinely newer transaction.
        assertThat(client.detokenize(flavour, client.validRequest(tokenRef, 6, 4999))
                .getBody().isProceed()).isTrue();
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("a tampered cryptogram is CRYPTOGRAM_INVALID")
    void tamperedCryptogram(StackFixture.Flavour flavour) {
        String tokenRef = freshToken();
        VaultRecord record = client.vault(tokenRef);
        DetokenizeRequest request = new DetokenizeRequest(record.tokenPan(),
                "0000000000000000", 1, "A1B2C3D4", 4999, record.requestorId(),
                record.domainType().name());
        assertReject(client.detokenize(flavour, request), "CRYPTOGRAM_INVALID");
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("a cryptogram captured for one amount cannot authorize another")
    void amountBinding(StackFixture.Flavour flavour) {
        String tokenRef = freshToken();
        VaultRecord record = client.vault(tokenRef);
        String un = "A1B2C3D4";
        // Cryptogram computed for 100 minor units, presented for 100000.
        DetokenizeRequest request = new DetokenizeRequest(record.tokenPan(),
                client.cryptogramService().computeHex(record.tokenPan(), 1, un, 100),
                1, un, 100_000, record.requestorId(), record.domainType().name());
        assertReject(client.detokenize(flavour, request), "CRYPTOGRAM_INVALID");
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("a forged cryptogram does not burn the ATC, so the genuine device is unaffected")
    void forgedCryptogramDoesNotConsumeTheCounter(StackFixture.Flavour flavour) {
        // This is the property the deliberate ordering deviation buys. Under the S6.1 ordering the
        // counter would advance before verification, and anyone who learned a token PAN could ratchet
        // it and deny service to the real card without holding any key material.
        String tokenRef = freshToken();
        VaultRecord record = client.vault(tokenRef);

        DetokenizeRequest forged = new DetokenizeRequest(record.tokenPan(),
                "DEADBEEFDEADBEEF", 500, "A1B2C3D4", 4999, record.requestorId(),
                record.domainType().name());
        assertReject(client.detokenize(flavour, forged), "CRYPTOGRAM_INVALID");

        // The genuine device presents a much lower ATC and must still be accepted.
        assertThat(client.detokenize(flavour, client.validRequest(tokenRef, 1, 4999))
                .getBody().isProceed())
                .withFailMessage("a forged cryptogram at ATC 500 burned the counter")
                .isTrue();
    }

    @ParameterizedTest
    @EnumSource(StackFixture.Flavour.class)
    @DisplayName("malformed requests are rejected by validation before any vault work happens")
    void validation(StackFixture.Flavour flavour) {
        String tokenRef = freshToken();
        VaultRecord record = client.vault(tokenRef);

        // Cryptogram that is not 16 hex characters.
        ResponseEntity<DetokenizeResponse> badCryptogram = client.detokenize(flavour,
                new DetokenizeRequest(record.tokenPan(), "XYZ", 1, "A1B2C3D4", 100,
                        record.requestorId(), "ECOM"));
        assertThat(badCryptogram.getStatusCode().value()).isEqualTo(400);

        // Unpredictable number that is not 8 hex characters.
        ResponseEntity<DetokenizeResponse> badUn = client.detokenize(flavour,
                new DetokenizeRequest(record.tokenPan(), "0011223344556677", 1, "ZZ", 100,
                        record.requestorId(), "ECOM"));
        assertThat(badUn.getStatusCode().value()).isEqualTo(400);
    }

    private void assertReject(ResponseEntity<DetokenizeResponse> response, String expectedReason) {
        assertThat(response.getStatusCode().value())
                .withFailMessage("expected 422 for a rejection but got %s", response.getStatusCode())
                .isEqualTo(422);
        DetokenizeResponse body = response.getBody();
        assertThat(body).isNotNull();
        assertThat(body.decision()).isEqualTo("REJECT");
        assertThat(body.reason()).isEqualTo(expectedReason);
        // A rejection must never leak the funding PAN.
        assertThat(body.fundingPan()).isNull();
    }
}
