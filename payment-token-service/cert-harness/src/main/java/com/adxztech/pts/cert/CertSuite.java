package com.adxztech.pts.cert;

import java.util.List;
import java.util.Map;

/**
 * A YAML-defined issuer certification suite (S10.5).
 *
 * <p>This is the artefact behind "onboarding a new issuer becomes fill in a capability profile and run
 * the harness". A suite is data, not code: a new issuer needs a BIN block, a {@code token_aware} flag and
 * a YAML file, rather than a round of manual test transactions negotiated over email.
 *
 * <p>{@code request} and {@code expect} are open maps on purpose. A closed schema per action would mean
 * every new certification scenario requires a code change, which defeats the point.
 */
public record CertSuite(String name,
                        String issuerId,
                        String description,
                        List<CertStep> steps) {

    public CertSuite {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("suite name is required");
        }
        steps = steps == null ? List.of() : List.copyOf(steps);
    }

    /**
     * One step.
     *
     * @param id      stable identifier, used in the report
     * @param action  what to do; see {@link HttpStepExecutor} for the supported set
     * @param request action inputs; {@code ${name}} placeholders are substituted from captured values
     * @param expect  assertions against the action's reported outcome; every entry must match
     * @param capture outcome keys to bind into the suite context for later steps, as {@code var: key}
     */
    public record CertStep(String id,
                           String action,
                           String description,
                           Map<String, Object> request,
                           Map<String, Object> expect,
                           Map<String, String> capture) {

        public CertStep {
            if (id == null || id.isBlank()) {
                throw new IllegalArgumentException("every step needs an id");
            }
            if (action == null || action.isBlank()) {
                throw new IllegalArgumentException("step " + id + " has no action");
            }
            request = request == null ? Map.of() : Map.copyOf(request);
            expect = expect == null ? Map.of() : Map.copyOf(expect);
            capture = capture == null ? Map.of() : Map.copyOf(capture);
        }
    }
}
