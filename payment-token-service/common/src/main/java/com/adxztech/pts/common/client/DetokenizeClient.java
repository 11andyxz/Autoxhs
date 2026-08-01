package com.adxztech.pts.common.client;

import com.adxztech.pts.common.api.DetokenizeRequest;
import com.adxztech.pts.common.api.DetokenizeResponse;
import com.adxztech.pts.common.api.RejectReason;
import com.adxztech.pts.common.web.ApiExceptions;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/**
 * Client used by the auth switch to call detokenization (S6.1).
 *
 * <p>A rejection is a <em>business outcome</em>, not a transport failure: the service answers 422 with
 * a populated {@code reason}, and this client returns it as a value rather than throwing. Only a
 * genuine transport failure raises -- which is the distinction that lets the switch return a
 * meaningful DE 39 instead of a generic system error.
 */
public class DetokenizeClient {

    private final RestClient restClient;

    public DetokenizeClient(RestClient restClient) {
        this.restClient = restClient;
    }

    public DetokenizeResponse detokenize(DetokenizeRequest request) {
        try {
            DetokenizeResponse response = restClient.post()
                    .uri("/v1/detokenize")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(request)
                    .retrieve()
                    // Suppress the default 4xx/5xx handler: the body is the answer we want.
                    .onStatus(HttpStatusCode::isError, (req, res) -> { })
                    .body(DetokenizeResponse.class);
            if (response == null) {
                return DetokenizeResponse.reject(RejectReason.VAULT_ERROR);
            }
            return response;
        } catch (RestClientException e) {
            throw new ApiExceptions.DependencyUnavailableException("detokenization-service unavailable", e);
        }
    }
}
