package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.api.IdvVerifyRequest;
import com.adxztech.pts.common.api.ProvisionRequest;
import com.adxztech.pts.common.api.ProvisionResponse;
import com.adxztech.pts.common.api.TokenView;
import com.adxztech.pts.common.web.ApiExceptions;
import jakarta.validation.Valid;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Optional;

/**
 * The provisioning and lifecycle API (S5.1, S5.3, S5.4).
 *
 * <p>Status codes carry meaning and are part of the certification contract: {@code 201} provisioned and
 * active, {@code 202} accepted pending OTP step-up, {@code 200} with a DECLINE decision, {@code 409} on
 * an illegal lifecycle transition, {@code 422} on idempotency-key misuse.
 *
 * <p>No endpoint here ever returns a token PAN. Callers get {@code tokenRef} and {@code tokenLast4}.
 */
@RestController
@RequestMapping(path = "/v1", produces = MediaType.APPLICATION_JSON_VALUE)
public class TokenController {

    private final ProvisioningService provisioningService;
    private final LifecycleService lifecycleService;
    private final IdempotencyService idempotencyService;
    private final OtpService otpService;

    public TokenController(ProvisioningService provisioningService,
                           LifecycleService lifecycleService,
                           IdempotencyService idempotencyService,
                           OtpService otpService) {
        this.provisioningService = provisioningService;
        this.lifecycleService = lifecycleService;
        this.idempotencyService = idempotencyService;
        this.otpService = otpService;
    }

    @PostMapping(path = "/tokens", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<ProvisionResponse> provision(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @Valid @RequestBody ProvisionRequest request) {

        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            ProvisionResponse response = provisioningService.provision(request);
            return ResponseEntity.status(ProvisioningService.statusFor(response)).body(response);
        }

        Optional<String> replay = idempotencyService.claim(idempotencyKey, request);
        if (replay.isPresent()) {
            ProvisionResponse stored =
                    idempotencyService.deserialize(replay.get(), ProvisionResponse.class);
            return ResponseEntity.status(ProvisioningService.statusFor(stored))
                    .header("Idempotent-Replay", "true")
                    .body(stored);
        }

        try {
            ProvisionResponse response = provisioningService.provision(request);
            idempotencyService.complete(idempotencyKey, response);
            return ResponseEntity.status(ProvisioningService.statusFor(response)).body(response);
        } catch (RuntimeException e) {
            // Release the claim so a genuine retry is not blocked forever by a transient failure.
            idempotencyService.abandon(idempotencyKey);
            throw e;
        }
    }

    @PostMapping(path = "/tokens/{tokenRef}/idv/verify", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<ProvisionResponse> verifyOtp(@PathVariable String tokenRef,
                                                       @Valid @RequestBody IdvVerifyRequest request) {
        ProvisionResponse response =
                provisioningService.completeStepUp(tokenRef, request.idvSessionId(), request.otp());
        return ResponseEntity.ok(response);
    }

    @PostMapping("/tokens/{tokenRef}/suspend")
    public TokenView suspend(@PathVariable String tokenRef) {
        return lifecycleService.suspend(tokenRef);
    }

    @PostMapping("/tokens/{tokenRef}/resume")
    public TokenView resume(@PathVariable String tokenRef) {
        return lifecycleService.resume(tokenRef);
    }

    /** Domain delete: marks the token DELETED and keeps the row as an audit tombstone (S5.4). */
    @DeleteMapping("/tokens/{tokenRef}")
    public TokenView delete(@PathVariable String tokenRef) {
        return lifecycleService.delete(tokenRef);
    }

    @GetMapping("/tokens/{tokenRef}")
    public TokenView get(@PathVariable String tokenRef) {
        return lifecycleService.view(tokenRef);
    }

    /**
     * Demo hook: reveals the OTP the simulated SMS channel delivered.
     *
     * <p>Returns 404 unless {@code provisioning.idv.expose-otp-for-demo} is explicitly enabled, so the
     * endpoint is inert by default rather than merely undocumented.
     */
    @GetMapping(path = "/idv/sessions/{sessionId}/otp", produces = MediaType.TEXT_PLAIN_VALUE)
    public String peekOtp(@PathVariable String sessionId) {
        if (!otpService.demoOtpExposed()) {
            throw new ApiExceptions.NotFoundException(
                    "OTP peek is disabled (provisioning.idv.expose-otp-for-demo=false)");
        }
        return otpService.peekDemoOtp(sessionId)
                .orElseThrow(() -> new ApiExceptions.NotFoundException(
                        "no pending OTP for session " + sessionId));
    }
}
