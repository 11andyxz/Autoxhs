package com.adxztech.pts.it;

import com.adxztech.pts.common.api.ProvisionRequest;
import com.adxztech.pts.common.api.ProvisionResponse;
import com.adxztech.pts.common.api.TokenView;
import com.adxztech.pts.common.demo.DemoCards;
import com.adxztech.pts.common.token.TokenStatus;
import com.adxztech.pts.common.vault.VaultRecord;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Provisioning, ID&amp;V, OTP step-up, idempotency and the lifecycle state machine, end to end
 * (S5.1-S5.4, S10.1).
 */
class ProvisioningLifecycleIT extends IntegrationTestBase {

    private ProvisionRequest request(String fundingPan, String requestorId, String domainType) {
        return new ProvisionRequest(fundingPan, "2812", "A XIONG", requestorId, domainType,
                "device-" + UUID.randomUUID(), "SMS");
    }

    @Test
    @DisplayName("green-path ID&V provisions an ACTIVE token in the issuer's own token BIN range")
    void greenPathProvisioning() {
        String card = ItCards.nextIssaApprove();
        ResponseEntity<ProvisionResponse> response =
                client.provision(request(card, DemoCards.WALLET_REQUESTOR, "ECOM"));

        assertThat(response.getStatusCode().value()).isEqualTo(201);
        ProvisionResponse body = response.getBody();
        assertThat(body).isNotNull();
        assertThat(body.decision()).isEqualTo("APPROVE");
        assertThat(body.status()).isEqualTo("ACTIVE");
        assertThat(body.tokenRef()).isNotBlank();
        assertThat(body.tokenLast4()).hasSize(4);
        // The token outlives the plastic, which is what makes reissue survivable (S5.5).
        assertThat(body.tokenExpiry()).isEqualTo("3112");

        VaultRecord record = client.vault(body.tokenRef());
        assertThat(record.status()).isEqualTo(TokenStatus.ACTIVE);
        assertThat(record.issuerId()).isEqualTo("ISSA");
        assertThat(record.fundingLast4()).isEqualTo(card.substring(card.length() - 4));
        assertThat(record.keyVersion()).isPositive();
        assertThat(record.lastAtc()).isZero();
        // Token BIN inside ISSA's configured block, so lookups prune to its Oracle partition (S4.1).
        assertThat(record.tokenBin()).isBetween(49996000L, 49996099L);
        // The API must never reveal the token PAN; only the vault has it.
        assertThat(body.tokenLast4()).isEqualTo(record.tokenLast4());
    }

    @Test
    @DisplayName("the funding PAN is stored only as authenticated ciphertext")
    void fundingPanIsEncryptedAtRest() {
        String card = ItCards.nextIssaApprove();
        String tokenRef = client.provisionActiveToken(card, DemoCards.WALLET_REQUESTOR, "ECOM");
        VaultRecord record = client.vault(tokenRef);

        String raw = new String(record.fundingPanEnc(), java.nio.charset.StandardCharsets.ISO_8859_1);
        assertThat(raw).doesNotContain(card);
        assertThat(record.fundingPanEnc()).hasSizeGreaterThan(40); // IV + ciphertext + GCM tag
        assertThat(record.fundingPanFingerprint()).hasSize(32);    // keyed HMAC, not a bare hash
    }

    @Test
    @DisplayName("yellow-path ID&V from a wallet requires OTP step-up before the token can activate")
    void yellowPathRequiresStepUp() {
        String card = ItCards.nextIssaStepUp();
        ResponseEntity<ProvisionResponse> provisioned =
                client.provision(request(card, DemoCards.WALLET_REQUESTOR, "ECOM"));

        assertThat(provisioned.getStatusCode().value()).isEqualTo(202);
        ProvisionResponse body = provisioned.getBody();
        assertThat(body).isNotNull();
        assertThat(body.decision()).isEqualTo("STEP_UP");
        assertThat(body.status()).isEqualTo("PENDING_IDV");
        assertThat(body.idvSessionId()).isNotBlank();
        assertThat(client.vault(body.tokenRef()).status()).isEqualTo(TokenStatus.PENDING_IDV);

        String otp = client.peekOtp(body.idvSessionId());
        assertThat(otp).hasSize(6).containsOnlyDigits();

        ResponseEntity<ProvisionResponse> verified =
                client.verifyOtp(body.tokenRef(), body.idvSessionId(), otp);
        assertThat(verified.getStatusCode().value()).isEqualTo(200);
        assertThat(verified.getBody()).isNotNull();
        assertThat(verified.getBody().status()).isEqualTo("ACTIVE");
        assertThat(client.vault(body.tokenRef()).status()).isEqualTo(TokenStatus.ACTIVE);
    }

    @Test
    @DisplayName("a trusted merchant is approved on the yellow path without step-up")
    void trustedRequestorSkipsStepUp() {
        // Same risk score as the previous test; only the requestor differs. This is the local rule
        // distinguishing a card-on-file merchant from a wallet enrolling a new device (S5.2).
        String card = ItCards.nextIssaStepUp();
        ResponseEntity<ProvisionResponse> response =
                client.provision(request(card, DemoCards.TRUSTED_MERCHANT_REQUESTOR, "ECOM"));

        assertThat(response.getStatusCode().value()).isEqualTo(201);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().decision()).isEqualTo("APPROVE");
    }

    @Test
    @DisplayName("three wrong OTPs invalidate the session and leave the token inactive")
    void otpAttemptLimit() {
        String card = ItCards.nextIssaStepUp();
        ProvisionResponse body = client.provision(request(card, DemoCards.WALLET_REQUESTOR, "ECOM"))
                .getBody();
        assertThat(body).isNotNull();
        String tokenRef = body.tokenRef();
        String sessionId = body.idvSessionId();

        assertThat(client.verifyOtp(tokenRef, sessionId, "000000").getStatusCode().value())
                .isEqualTo(422);
        assertThat(client.verifyOtp(tokenRef, sessionId, "111111").getStatusCode().value())
                .isEqualTo(422);
        assertThat(client.verifyOtp(tokenRef, sessionId, "222222").getStatusCode().value())
                .isEqualTo(422);

        // The session is gone, so even the correct code cannot be used any more.
        assertThat(client.verifyOtp(tokenRef, sessionId, "333333").getStatusCode().value())
                .isEqualTo(404);
        assertThat(client.vault(tokenRef).status()).isEqualTo(TokenStatus.PENDING_IDV);
    }

    @Test
    @DisplayName("an OTP session cannot be used to activate a different token")
    void otpSessionIsBoundToItsToken() {
        ProvisionResponse first = client.provision(
                request(ItCards.nextIssaStepUp(), DemoCards.WALLET_REQUESTOR, "ECOM")).getBody();
        ProvisionResponse second = client.provision(
                request(ItCards.nextIssaStepUp(), DemoCards.WALLET_REQUESTOR, "ECOM")).getBody();
        assertThat(first).isNotNull();
        assertThat(second).isNotNull();

        String firstOtp = client.peekOtp(first.idvSessionId());
        // Presenting token 1's session (and its correct code) against token 2 must be refused.
        assertThat(client.verifyOtp(second.tokenRef(), first.idvSessionId(), firstOtp)
                .getStatusCode().value()).isEqualTo(422);
        assertThat(client.vault(second.tokenRef()).status()).isEqualTo(TokenStatus.PENDING_IDV);
    }

    @Test
    @DisplayName("red-path ID&V declines and persists no token")
    void redPathDeclines() {
        long before = client.vaultRepository().count();
        ResponseEntity<ProvisionResponse> response =
                client.provision(request(DemoCards.ISSA_DECLINE, DemoCards.WALLET_REQUESTOR, "ECOM"));

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().decision()).isEqualTo("DECLINE");
        assertThat(response.getBody().tokenRef()).isNull();
        assertThat(client.vaultRepository().count()).isEqualTo(before);
    }

    @Test
    @DisplayName("a blocklisted funding BIN is declined despite a clean issuer risk score")
    void localBlocklistOverridesIssuerSignal() {
        // BLOCKED_BIN_CARD scores 25 -- green. The local rule must win, and it must be evaluated
        // before the issuer is even asked.
        ResponseEntity<ProvisionResponse> response = client.provision(
                request(DemoCards.BLOCKED_BIN_CARD, DemoCards.WALLET_REQUESTOR, "ECOM"));

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().decision()).isEqualTo("DECLINE");
        assertThat(response.getBody().reason()).isEqualTo("FUNDING_BIN_BLOCKED");
    }

    @Test
    @DisplayName("a retried request with the same idempotency key returns the same token, not a second one")
    void idempotentRetryReplaysTheSameToken() {
        String card = ItCards.nextIssaApprove();
        ProvisionRequest body = request(card, DemoCards.WALLET_REQUESTOR, "ECOM");
        String key = "idem-" + UUID.randomUUID();
        long before = client.vaultRepository().count();

        ResponseEntity<ProvisionResponse> first = client.provision(body, key);
        ResponseEntity<ProvisionResponse> second = client.provision(body, key);

        assertThat(first.getStatusCode().value()).isEqualTo(201);
        assertThat(second.getStatusCode().value()).isEqualTo(201);
        assertThat(second.getHeaders().getFirst("Idempotent-Replay")).isEqualTo("true");
        assertThat(second.getBody()).isNotNull();
        assertThat(first.getBody()).isNotNull();
        assertThat(second.getBody().tokenRef()).isEqualTo(first.getBody().tokenRef());
        assertThat(client.vaultRepository().count()).isEqualTo(before + 1);
    }

    @Test
    @DisplayName("reusing an idempotency key with a different body is a 422, not a silent second token")
    void idempotencyKeyReuseWithDifferentBodyIsRejected() {
        String key = "idem-" + UUID.randomUUID();
        client.provision(request(ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM"), key);
        long after = client.vaultRepository().count();

        ResponseEntity<ProvisionResponse> reused = client.provision(
                request(ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM"), key);

        assertThat(reused.getStatusCode().value()).isEqualTo(422);
        assertThat(client.vaultRepository().count()).isEqualTo(after);
    }

    @Test
    @DisplayName("suspend, resume and delete each move the token and reject illegal transitions with 409")
    void lifecycleTransitions() {
        String tokenRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");

        ResponseEntity<TokenView> suspended = client.suspend(tokenRef);
        assertThat(suspended.getStatusCode().value()).isEqualTo(200);
        assertThat(suspended.getBody()).isNotNull();
        assertThat(suspended.getBody().status()).isEqualTo("SUSPENDED");

        // ACTIVE --SUSPEND--> SUSPENDED is legal; SUSPENDED --SUSPEND--> is not.
        assertThat(client.suspend(tokenRef).getStatusCode().value()).isEqualTo(409);

        assertThat(client.resume(tokenRef).getBody()).isNotNull();
        assertThat(client.token(tokenRef).getBody().status()).isEqualTo("ACTIVE");
        assertThat(client.resume(tokenRef).getStatusCode().value()).isEqualTo(409);

        assertThat(client.delete(tokenRef).getBody().status()).isEqualTo("DELETED");
        // DELETED is terminal: nothing is legal from it, not even another DELETE.
        assertThat(client.delete(tokenRef).getStatusCode().value()).isEqualTo(409);
        assertThat(client.suspend(tokenRef).getStatusCode().value()).isEqualTo(409);
        assertThat(client.resume(tokenRef).getStatusCode().value()).isEqualTo(409);
    }

    @Test
    @DisplayName("a domain delete keeps the row as an audit tombstone rather than erasing it")
    void deleteIsATombstone() {
        String tokenRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");
        client.delete(tokenRef);

        VaultRecord record = client.vault(tokenRef);
        assertThat(record.status()).isEqualTo(TokenStatus.DELETED);
        assertThat(record.fundingPanEnc()).isNotEmpty();
        assertThat(client.token(tokenRef).getStatusCode().value()).isEqualTo(200);
    }

    @Test
    @DisplayName("unknown tokens are 404 and malformed input is 400")
    void errorMapping() {
        assertThat(client.token("not-a-real-token-ref").getStatusCode().value()).isEqualTo(404);
        assertThat(client.suspend("not-a-real-token-ref").getStatusCode().value()).isEqualTo(404);

        // Fails the Luhn check.
        assertThat(client.provision(request("4111100000003126", DemoCards.WALLET_REQUESTOR, "ECOM"))
                .getStatusCode().value()).isEqualTo(400);
        // Expiry in the past.
        assertThat(client.provision(new ProvisionRequest(ItCards.nextIssaApprove(), "2001",
                "A", DemoCards.WALLET_REQUESTOR, "ECOM", null, "SMS"))
                .getStatusCode().value()).isEqualTo(400);
        // Funding BIN that has not been onboarded.
        assertThat(client.provision(request("4999609999999995", DemoCards.WALLET_REQUESTOR, "ECOM"))
                .getStatusCode().value()).isEqualTo(400);
        // Domain outside the enum.
        assertThat(client.provision(request(ItCards.nextIssaApprove(),
                DemoCards.WALLET_REQUESTOR, "TELEPATHY")).getStatusCode().value()).isEqualTo(400);
    }
}
