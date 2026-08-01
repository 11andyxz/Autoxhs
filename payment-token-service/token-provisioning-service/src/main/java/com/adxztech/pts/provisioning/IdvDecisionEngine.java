package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.api.IdvDecision;
import com.adxztech.pts.common.api.IdvRiskRequest;
import com.adxztech.pts.common.api.IdvRiskResponse;
import com.adxztech.pts.common.api.ProvisionRequest;
import com.adxztech.pts.common.client.IssuerSimClient;
import com.adxztech.pts.common.pan.Pan;
import com.adxztech.pts.common.token.FundingBinRange;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Combines the issuer's risk signal with local rules to reach APPROVE / STEP_UP / DECLINE (S5.2).
 *
 * <p>The rule table, in evaluation order:
 * <table border="1">
 *   <caption>ID&amp;V rules</caption>
 *   <tr><th>Condition</th><th>Decision</th></tr>
 *   <tr><td>funding BIN on the local blocklist</td><td>DECLINE</td></tr>
 *   <tr><td>issuer hard block</td><td>DECLINE</td></tr>
 *   <tr><td>{@code score >= declineAtScore}</td><td>DECLINE</td></tr>
 *   <tr><td>{@code score < approveBelowScore}</td><td>APPROVE</td></tr>
 *   <tr><td>yellow band, trusted requestor</td><td>APPROVE</td></tr>
 *   <tr><td>yellow band, anyone else (e.g. a wallet)</td><td>STEP_UP</td></tr>
 * </table>
 *
 * <p>Local rules are evaluated <em>before</em> the score so a blocklist cannot be overridden by a
 * favourable issuer signal. What is being modelled is the decision contract and its state
 * consequences, not risk scoring -- that distinction is the point, and it is worth saying out loud.
 */
@Component
public class IdvDecisionEngine {

    private static final Logger log = LoggerFactory.getLogger(IdvDecisionEngine.class);

    private final IssuerSimClient issuerSimClient;
    private final ProvisioningProperties properties;

    public IdvDecisionEngine(IssuerSimClient issuerSimClient, ProvisioningProperties properties) {
        this.issuerSimClient = issuerSimClient;
        this.properties = properties;
    }

    /** The decision plus the reason, so a DECLINE can tell the caller why. */
    public record Outcome(IdvDecision decision, String reason, int riskScore) {
    }

    public Outcome decide(ProvisionRequest request, Pan fundingPan, FundingBinRange fundingRange) {
        ProvisioningProperties.Idv rules = properties.getIdv();

        if (fundingRange.blocked()) {
            log.info("ID&V DECLINE: funding BIN block {} is on the local blocklist",
                    fundingRange.binStart());
            return new Outcome(IdvDecision.DECLINE, "FUNDING_BIN_BLOCKED", -1);
        }

        IdvRiskResponse risk = issuerSimClient.risk(new IdvRiskRequest(
                fundingPan.bin(8), fundingPan.last4(), request.requestorId(),
                request.deviceId(), request.domainType(), request.isDeviceBound()));

        if (risk.blocked()) {
            return new Outcome(IdvDecision.DECLINE, "ISSUER_BLOCKED", risk.riskScore());
        }
        if (risk.riskScore() >= rules.getDeclineAtScore()) {
            return new Outcome(IdvDecision.DECLINE,
                    "RISK_SCORE_" + risk.riskScore() + "_AT_OR_ABOVE_" + rules.getDeclineAtScore(),
                    risk.riskScore());
        }
        if (risk.riskScore() < rules.getApproveBelowScore()) {
            return new Outcome(IdvDecision.APPROVE, "RISK_SCORE_" + risk.riskScore() + "_GREEN",
                    risk.riskScore());
        }
        if (rules.getTrustedRequestors().contains(request.requestorId())) {
            return new Outcome(IdvDecision.APPROVE,
                    "RISK_SCORE_" + risk.riskScore() + "_YELLOW_TRUSTED_REQUESTOR", risk.riskScore());
        }
        return new Outcome(IdvDecision.STEP_UP, "RISK_SCORE_" + risk.riskScore() + "_YELLOW_STEP_UP",
                risk.riskScore());
    }
}
