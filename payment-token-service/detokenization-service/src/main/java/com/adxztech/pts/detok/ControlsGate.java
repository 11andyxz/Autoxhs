package com.adxztech.pts.detok;

import com.adxztech.pts.common.api.ControlsCheckRequest;
import com.adxztech.pts.common.api.ControlsCheckResponse;
import com.adxztech.pts.common.api.DetokenizeRequest;
import com.adxztech.pts.common.api.RejectReason;
import com.adxztech.pts.common.client.ControlsClient;
import com.adxztech.pts.common.sim.LatencyInjector;
import com.adxztech.pts.common.token.DomainType;
import com.adxztech.pts.common.vault.VaultRecord;

/**
 * Status and domain-restriction evaluation -- the round trip that Optimization B deletes (S8.2).
 *
 * <p>Both implementations must return byte-identical verdicts. That is not an aspiration: the
 * integration suite runs the entire behavioural matrix under both and asserts the same reject reasons,
 * because an optimization that changes what gets declined is a regression wearing a performance badge.
 */
public interface ControlsGate {

    ControlsCheckResponse evaluate(VaultRecord record, DetokenizeRequest request);

    String describe();

    /**
     * Baseline: a synchronous HTTP call to token-controls-service, which does its own database read.
     *
     * <p>Roughly 7-9 ms through the calibrated network path (S8.1) -- the second of the two round trips
     * that dominate the baseline tail.
     */
    class Remote implements ControlsGate {

        private final ControlsClient controlsClient;
        private final LatencyInjector latency;

        public Remote(ControlsClient controlsClient, LatencyInjector latency) {
            this.controlsClient = controlsClient;
            this.latency = latency;
        }

        @Override
        public ControlsCheckResponse evaluate(VaultRecord record, DetokenizeRequest request) {
            // On a laptop this call is sub-millisecond; the injector represents the cross-rack RTT that
            // Toxiproxy adds in the Compose stack (S11.3). Disclosed, not hidden.
            latency.hop();
            return controlsClient.check(new ControlsCheckRequest(
                    request.tokenPan(), request.requestorId(), request.domainType()));
        }

        @Override
        public String describe() {
            return "REMOTE (synchronous call to token-controls-service)";
        }
    }

    /**
     * Optimized: the same evaluation against the vault record already in hand.
     *
     * <p>{@code status}, {@code requestorId} and {@code domainType} are denormalized onto the record, so
     * this costs no hop at all. That denormalization <em>is</em> the "eliminated a synchronous round
     * trip" from the latency story.
     */
    class Inline implements ControlsGate {

        @Override
        public ControlsCheckResponse evaluate(VaultRecord record, DetokenizeRequest request) {
            if (!record.canAuthorize()) {
                return ControlsCheckResponse.deny(record.status().name(), RejectReason.TOKEN_NOT_ACTIVE);
            }
            DomainType presented;
            try {
                presented = DomainType.parse(request.domainType());
            } catch (IllegalArgumentException e) {
                return ControlsCheckResponse.deny(record.status().name(), RejectReason.DOMAIN_MISMATCH);
            }
            if (!record.matchesBinding(request.requestorId(), presented)) {
                return ControlsCheckResponse.deny(record.status().name(), RejectReason.DOMAIN_MISMATCH);
            }
            return ControlsCheckResponse.allow(record.status().name());
        }

        @Override
        public String describe() {
            return "INLINE (evaluated from the cached vault record; no network hop)";
        }
    }
}
