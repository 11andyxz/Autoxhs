package com.adxztech.pts.common.client;

import com.adxztech.pts.common.api.ControlsCheckRequest;
import com.adxztech.pts.common.api.ControlsCheckResponse;
import com.adxztech.pts.common.web.ApiExceptions;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/**
 * The synchronous call that the optimization deletes (S8.2).
 *
 * <p>Kept as a first-class client with real error handling, because the baseline has to be a fair
 * comparison: if the "before" architecture were sloppily implemented, the improvement would be
 * measuring the sloppiness rather than the removed round trip.
 */
public class ControlsClient {

    private final RestClient restClient;

    public ControlsClient(RestClient restClient) {
        this.restClient = restClient;
    }

    public ControlsCheckResponse check(ControlsCheckRequest request) {
        try {
            return restClient.post()
                    .uri("/internal/controls/check")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(request)
                    .retrieve()
                    .body(ControlsCheckResponse.class);
        } catch (RestClientException e) {
            throw new ApiExceptions.DependencyUnavailableException("token-controls-service unavailable", e);
        }
    }
}
