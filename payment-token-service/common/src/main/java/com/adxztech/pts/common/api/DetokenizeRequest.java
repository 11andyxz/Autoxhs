package com.adxztech.pts.common.api;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

/**
 * {@code POST /v1/detokenize} body -- the latency-critical internal call from the auth switch (S6.1).
 *
 * @param tokenPan            the network token presented in DE 2
 * @param cryptogram          TAVV-style cryptogram, 8 bytes as 16 hex chars
 * @param atc                 application transaction counter, must exceed the stored value
 * @param unpredictableNumber freshness nonce, bound into the cryptogram
 * @param amountMinor         transaction amount in minor units, bound into the cryptogram
 * @param requestorId         token requestor presenting the token -- checked against the binding
 * @param domainType          usage domain -- checked against the binding
 */
public record DetokenizeRequest(

        @NotBlank(message = "tokenPan is required")
        String tokenPan,

        @NotBlank(message = "cryptogram is required")
        @Pattern(regexp = "[0-9A-Fa-f]{16}", message = "cryptogram must be 16 hex characters")
        String cryptogram,

        @Min(value = 0, message = "atc must be >= 0")
        int atc,

        @NotBlank(message = "unpredictableNumber is required")
        @Pattern(regexp = "[0-9A-Fa-f]{8}", message = "unpredictableNumber must be 8 hex characters")
        String unpredictableNumber,

        @Min(value = 0, message = "amountMinor must be >= 0")
        long amountMinor,

        @NotBlank(message = "requestorId is required")
        String requestorId,

        @NotBlank(message = "domainType is required")
        String domainType) {
}
