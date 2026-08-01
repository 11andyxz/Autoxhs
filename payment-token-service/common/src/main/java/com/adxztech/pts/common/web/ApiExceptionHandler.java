package com.adxztech.pts.common.web;

import com.adxztech.pts.common.api.ApiError;
import com.adxztech.pts.common.crypto.EnvelopeCipher;
import com.adxztech.pts.common.crypto.KeyServiceException;
import com.adxztech.pts.common.pan.InvalidPanException;
import com.adxztech.pts.common.token.IllegalTransitionException;
import com.adxztech.pts.common.trace.TraceContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.stream.Collectors;

/**
 * One error contract for every service.
 *
 * <p>The mapping that matters for the design: an illegal lifecycle transition is <b>409 Conflict</b>,
 * enforced centrally by the state machine rather than re-derived in each controller (S4.3, S5.4).
 *
 * <p>Every response carries the trace id, so a caller reporting "I got a 409" hands over the one token
 * needed to find the request across all services.
 */
@RestControllerAdvice
public class ApiExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(IllegalTransitionException.class)
    public ResponseEntity<ApiError> onIllegalTransition(IllegalTransitionException e) {
        return build(HttpStatus.CONFLICT, "ILLEGAL_TRANSITION", e.getMessage());
    }

    @ExceptionHandler(ApiExceptions.NotFoundException.class)
    public ResponseEntity<ApiError> onNotFound(ApiExceptions.NotFoundException e) {
        return build(HttpStatus.NOT_FOUND, "NOT_FOUND", e.getMessage());
    }

    @ExceptionHandler(ApiExceptions.UnprocessableException.class)
    public ResponseEntity<ApiError> onUnprocessable(ApiExceptions.UnprocessableException e) {
        return build(HttpStatus.UNPROCESSABLE_ENTITY, "UNPROCESSABLE", e.getMessage());
    }

    @ExceptionHandler(ApiExceptions.ConflictException.class)
    public ResponseEntity<ApiError> onConflict(ApiExceptions.ConflictException e) {
        return build(HttpStatus.CONFLICT, "CONFLICT", e.getMessage());
    }

    @ExceptionHandler(InvalidPanException.class)
    public ResponseEntity<ApiError> onInvalidPan(InvalidPanException e) {
        return build(HttpStatus.BAD_REQUEST, "INVALID_PAN", e.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiError> onValidation(MethodArgumentNotValidException e) {
        String detail = e.getBindingResult().getFieldErrors().stream()
                .map(f -> f.getField() + ": " + f.getDefaultMessage())
                .collect(Collectors.joining("; "));
        return build(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", detail);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ApiError> onIllegalArgument(IllegalArgumentException e) {
        return build(HttpStatus.BAD_REQUEST, "BAD_REQUEST", e.getMessage());
    }

    @ExceptionHandler(ApiExceptions.DependencyUnavailableException.class)
    public ResponseEntity<ApiError> onDependencyDown(ApiExceptions.DependencyUnavailableException e) {
        log.warn("dependency unavailable: {}", e.getMessage());
        return build(HttpStatus.SERVICE_UNAVAILABLE, "DEPENDENCY_UNAVAILABLE", e.getMessage());
    }

    /**
     * Crypto failures are 500 and are logged without any payload detail -- a tampered-ciphertext
     * message must not become an oracle for an attacker probing the vault.
     */
    @ExceptionHandler({KeyServiceException.class, EnvelopeCipher.TamperedCiphertextException.class})
    public ResponseEntity<ApiError> onCryptoFailure(RuntimeException e) {
        log.error("cryptographic operation failed: {}", e.getClass().getSimpleName());
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "CRYPTO_FAILURE", "cryptographic operation failed");
    }

    private static ResponseEntity<ApiError> build(HttpStatus status, String code, String message) {
        return ResponseEntity.status(status).body(ApiError.of(code, message, TraceContext.current()));
    }
}
