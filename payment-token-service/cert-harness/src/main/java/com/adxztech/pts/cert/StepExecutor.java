package com.adxztech.pts.cert;

import java.util.Map;

/**
 * Executes one certification step and reports what happened.
 *
 * <p>An interface rather than a concrete class so the suite-running logic -- placeholder substitution,
 * expectation matching, capture, reporting -- can be tested without a running stack. The runner's own
 * correctness matters: a harness that reports PASS for a step it did not really assert is worse than no
 * harness at all.
 */
public interface StepExecutor {

    /**
     * @param action  the step's action name
     * @param request the step's inputs, with placeholders already substituted
     * @return observed outcome values, which the runner matches against the step's expectations
     */
    Map<String, Object> execute(String action, Map<String, Object> request);

    String describe();
}
