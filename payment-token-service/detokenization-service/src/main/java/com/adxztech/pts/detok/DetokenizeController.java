package com.adxztech.pts.detok;

import com.adxztech.pts.common.api.DetokenizeRequest;
import com.adxztech.pts.common.api.DetokenizeResponse;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * The internal detokenization endpoint called by the auth switch (S6.1).
 *
 * <p>{@code 200} carries the funding PAN; {@code 422} carries a {@link
 * com.adxztech.pts.common.api.RejectReason}. A rejection is a business outcome with a body, not an error
 * with a stack trace -- that distinction is what lets the switch map it to a meaningful DE 39 instead of
 * a generic system error.
 */
@RestController
@RequestMapping(path = "/v1", produces = MediaType.APPLICATION_JSON_VALUE)
public class DetokenizeController {

    private final DetokenizationService detokenizationService;

    public DetokenizeController(DetokenizationService detokenizationService) {
        this.detokenizationService = detokenizationService;
    }

    @PostMapping(path = "/detokenize", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<DetokenizeResponse> detokenize(@Valid @RequestBody DetokenizeRequest request) {
        DetokenizeResponse response = detokenizationService.detokenize(request);
        return response.isProceed()
                ? ResponseEntity.ok(response)
                : ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body(response);
    }

    /** Which flag combination is live. The A/B harness labels each run from this. */
    @GetMapping("/detokenize/config")
    public Map<String, String> configuration() {
        return detokenizationService.activeConfiguration();
    }
}
