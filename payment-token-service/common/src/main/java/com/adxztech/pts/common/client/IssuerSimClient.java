package com.adxztech.pts.common.client;

import com.adxztech.pts.common.api.IdvRiskRequest;
import com.adxztech.pts.common.api.IdvRiskResponse;
import com.adxztech.pts.common.api.IssuerAuthRequest;
import com.adxztech.pts.common.api.IssuerAuthResponse;
import com.adxztech.pts.common.web.ApiExceptions;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/** Calls the issuer stand-in for ID&amp;V risk signals and authorization decisions (S3.1). */
public class IssuerSimClient {

    private final RestClient restClient;

    public IssuerSimClient(RestClient restClient) {
        this.restClient = restClient;
    }

    public IdvRiskResponse risk(IdvRiskRequest request) {
        try {
            return restClient.post()
                    .uri("/sim/idv/risk")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(request)
                    .retrieve()
                    .body(IdvRiskResponse.class);
        } catch (RestClientException e) {
            throw new ApiExceptions.DependencyUnavailableException("issuer ID&V endpoint unavailable", e);
        }
    }

    public IssuerAuthResponse authorize(IssuerAuthRequest request) {
        try {
            return restClient.post()
                    .uri("/sim/authorize")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(request)
                    .retrieve()
                    .body(IssuerAuthResponse.class);
        } catch (RestClientException e) {
            throw new ApiExceptions.DependencyUnavailableException("issuer authorization endpoint unavailable", e);
        }
    }
}
