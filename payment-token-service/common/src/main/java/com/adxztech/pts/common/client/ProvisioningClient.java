package com.adxztech.pts.common.client;

import com.adxztech.pts.common.api.CardUpdateRequest;
import com.adxztech.pts.common.api.CardUpdateResponse;
import com.adxztech.pts.common.api.IdvVerifyRequest;
import com.adxztech.pts.common.api.ProvisionRequest;
import com.adxztech.pts.common.api.ProvisionResponse;
import com.adxztech.pts.common.api.TokenView;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.RestClient;

/**
 * Provisioning API client, used by the cert harness and the integration suite (S10.5).
 *
 * <p>Returns {@link ResponseEntity} rather than bare bodies because certification cares about status
 * codes: "202 with an ID&amp;V session" and "409 on an illegal transition" are the assertions, not just
 * the payload.
 */
public class ProvisioningClient {

    private final RestClient restClient;

    public ProvisioningClient(RestClient restClient) {
        this.restClient = restClient;
    }

    public ResponseEntity<ProvisionResponse> provision(ProvisionRequest request, String idempotencyKey) {
        RestClient.RequestBodySpec spec = restClient.post()
                .uri("/v1/tokens")
                .contentType(MediaType.APPLICATION_JSON);
        if (idempotencyKey != null) {
            spec = spec.header("Idempotency-Key", idempotencyKey);
        }
        return spec.body(request)
                .retrieve()
                .onStatus(HttpStatusCode::isError, (req, res) -> { })
                .toEntity(ProvisionResponse.class);
    }

    public ResponseEntity<ProvisionResponse> verifyOtp(String tokenRef, IdvVerifyRequest request) {
        return restClient.post()
                .uri("/v1/tokens/{ref}/idv/verify", tokenRef)
                .contentType(MediaType.APPLICATION_JSON)
                .body(request)
                .retrieve()
                .onStatus(HttpStatusCode::isError, (req, res) -> { })
                .toEntity(ProvisionResponse.class);
    }

    public ResponseEntity<TokenView> suspend(String tokenRef) {
        return lifecycle(tokenRef, "suspend");
    }

    public ResponseEntity<TokenView> resume(String tokenRef) {
        return lifecycle(tokenRef, "resume");
    }

    private ResponseEntity<TokenView> lifecycle(String tokenRef, String op) {
        return restClient.post()
                .uri("/v1/tokens/{ref}/{op}", tokenRef, op)
                .retrieve()
                .onStatus(HttpStatusCode::isError, (req, res) -> { })
                .toEntity(TokenView.class);
    }

    public ResponseEntity<TokenView> delete(String tokenRef) {
        return restClient.delete()
                .uri("/v1/tokens/{ref}", tokenRef)
                .retrieve()
                .onStatus(HttpStatusCode::isError, (req, res) -> { })
                .toEntity(TokenView.class);
    }

    public ResponseEntity<TokenView> get(String tokenRef) {
        return restClient.get()
                .uri("/v1/tokens/{ref}", tokenRef)
                .retrieve()
                .onStatus(HttpStatusCode::isError, (req, res) -> { })
                .toEntity(TokenView.class);
    }

    public ResponseEntity<CardUpdateResponse> updateCard(CardUpdateRequest request) {
        return restClient.post()
                .uri("/v1/cards/update")
                .contentType(MediaType.APPLICATION_JSON)
                .body(request)
                .retrieve()
                .onStatus(HttpStatusCode::isError, (req, res) -> { })
                .toEntity(CardUpdateResponse.class);
    }

    /** Test/demo hook: reveals the OTP the simulated SMS channel would have delivered (S5.3). */
    public String peekOtp(String idvSessionId) {
        return restClient.get()
                .uri("/v1/idv/sessions/{id}/otp", idvSessionId)
                .retrieve()
                .onStatus(HttpStatusCode::isError, (req, res) -> { })
                .body(String.class);
    }
}
