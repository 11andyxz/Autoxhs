package com.adxztech.pts.common.api;

import com.fasterxml.jackson.annotation.JsonInclude;

/** Uniform error body across every service. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ApiError(String error, String message, String traceId) {

    public static ApiError of(String error, String message, String traceId) {
        return new ApiError(error, message, traceId);
    }
}
