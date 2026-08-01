package com.adxztech.pts.controls;

import com.adxztech.pts.common.api.ControlsCheckRequest;
import com.adxztech.pts.common.api.ControlsCheckResponse;
import com.adxztech.pts.common.api.RejectReason;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.token.DomainType;
import com.adxztech.pts.common.vault.VaultRecord;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.Optional;

/**
 * Status and domain-restriction checks, served from this service's own database connection.
 *
 * <p>The verdict is identical to what {@code InlineControlsGate} computes inside the detokenization
 * service. That equivalence is asserted by the integration suite across all four flag combinations --
 * an optimization that quietly changes behaviour is not an optimization.
 */
@RestController
public class ControlsController {

    private static final Logger log = LoggerFactory.getLogger(ControlsController.class);

    private final VaultRepository vaultRepository;
    private final Timer checkTimer;

    public ControlsController(VaultRepository vaultRepository, MeterRegistry meterRegistry) {
        this.vaultRepository = vaultRepository;
        this.checkTimer = Timer.builder("pts.controls.check")
                .description("token-controls-service status and domain evaluation")
                .publishPercentiles(0.5, 0.95, 0.99, 0.999)
                .register(meterRegistry);
    }

    @PostMapping(path = "/internal/controls/check",
            consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public ControlsCheckResponse check(@Valid @RequestBody ControlsCheckRequest request) {
        return checkTimer.record(() -> evaluate(request));
    }

    private ControlsCheckResponse evaluate(ControlsCheckRequest request) {
        Optional<VaultRecord> found = vaultRepository.findByTokenPan(request.tokenPan());
        if (found.isEmpty()) {
            return ControlsCheckResponse.deny("UNKNOWN", RejectReason.TOKEN_NOT_FOUND);
        }
        VaultRecord record = found.get();
        if (!record.canAuthorize()) {
            log.debug("controls deny: token {} is {}", record.tokenRef(), record.status());
            return ControlsCheckResponse.deny(record.status().name(), RejectReason.TOKEN_NOT_ACTIVE);
        }
        DomainType presentedDomain;
        try {
            presentedDomain = DomainType.parse(request.domainType());
        } catch (IllegalArgumentException e) {
            return ControlsCheckResponse.deny(record.status().name(), RejectReason.DOMAIN_MISMATCH);
        }
        if (!record.matchesBinding(request.requestorId(), presentedDomain)) {
            log.debug("controls deny: token {} bound to {}/{} but presented by {}/{}",
                    record.tokenRef(), record.requestorId(), record.domainType(),
                    request.requestorId(), presentedDomain);
            return ControlsCheckResponse.deny(record.status().name(), RejectReason.DOMAIN_MISMATCH);
        }
        return ControlsCheckResponse.allow(record.status().name());
    }
}
