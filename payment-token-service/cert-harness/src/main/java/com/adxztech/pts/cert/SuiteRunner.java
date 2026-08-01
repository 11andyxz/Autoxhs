package com.adxztech.pts.cert;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Replays a certification suite and reports pass/fail per step (S10.5).
 *
 * <p>Three behaviours are deliberate:
 *
 * <ul>
 *   <li><b>A failed step stops the suite.</b> Certification steps are sequential and stateful -- step 4
 *       authorizes the token step 1 provisioned. Continuing past a failure produces a cascade of
 *       meaningless failures that buries the real one.</li>
 *   <li><b>An unmatched expectation is a failure, not a warning.</b> Including an expectation key the
 *       action never reports is itself a defect in the suite, so it is surfaced rather than skipped.</li>
 *   <li><b>Comparison is on string form.</b> YAML gives {@code 201} as an Integer and {@code "00"} as a
 *       String; DE 39 is genuinely the string {@code "00"} and must not be compared as the number zero.
 *       Normalising both sides to text avoids an entire class of false passes.</li>
 * </ul>
 */
public class SuiteRunner {

    private static final Logger log = LoggerFactory.getLogger(SuiteRunner.class);
    private static final Pattern PLACEHOLDER = Pattern.compile("\\$\\{([A-Za-z0-9_.-]+)}");

    private final StepExecutor executor;

    public SuiteRunner(StepExecutor executor) {
        this.executor = executor;
    }

    public record StepResult(String id, String action, String description, boolean passed,
                             List<String> failures, long durationMs, Map<String, Object> actual,
                             Map<String, Object> request) {
    }

    public record SuiteResult(String suiteName, String issuerId, String description,
                              List<StepResult> steps, long durationMs, String executor,
                              int passed, int failed, int skipped) {

        public boolean allPassed() {
            return failed == 0 && skipped == 0;
        }
    }

    public SuiteResult run(CertSuite suite) {
        long suiteStart = System.nanoTime();
        Map<String, String> context = new LinkedHashMap<>();
        List<StepResult> results = new ArrayList<>();
        boolean aborted = false;
        int passed = 0;
        int failed = 0;
        int skipped = 0;

        for (CertSuite.CertStep step : suite.steps()) {
            if (aborted) {
                results.add(new StepResult(step.id(), step.action(), step.description(), false,
                        List.of("skipped: an earlier step failed"), 0, Map.of(), Map.of()));
                skipped++;
                continue;
            }

            Map<String, Object> request = substitute(step.request(), context);
            long stepStart = System.nanoTime();
            Map<String, Object> actual;
            List<String> failures = new ArrayList<>();

            try {
                actual = executor.execute(step.action(), request);
            } catch (Exception e) {
                actual = Map.of("error", e.getClass().getSimpleName() + ": " + e.getMessage());
                failures.add("action threw " + e.getClass().getSimpleName() + ": " + e.getMessage());
            }

            failures.addAll(match(step.expect(), actual));

            long durationMs = (System.nanoTime() - stepStart) / 1_000_000;
            boolean stepPassed = failures.isEmpty();

            if (stepPassed) {
                Map<String, Object> observed = actual;
                step.capture().forEach((variable, key) -> {
                    Object value = observed.get(key);
                    if (value != null) {
                        context.put(variable, String.valueOf(value));
                    }
                });
                passed++;
                log.info("PASS {} [{}] ({} ms)", step.id(), step.action(), durationMs);
            } else {
                failed++;
                aborted = true;
                log.error("FAIL {} [{}]: {}", step.id(), step.action(), failures);
            }

            results.add(new StepResult(step.id(), step.action(), step.description(), stepPassed,
                    List.copyOf(failures), durationMs, actual, request));
        }

        long durationMs = (System.nanoTime() - suiteStart) / 1_000_000;
        SuiteResult result = new SuiteResult(suite.name(), suite.issuerId(), suite.description(),
                List.copyOf(results), durationMs, executor.describe(), passed, failed, skipped);
        log.info("suite '{}': {} passed, {} failed, {} skipped in {} ms",
                suite.name(), passed, failed, skipped, durationMs);
        return result;
    }

    /** Substitutes {@code ${var}} placeholders, including inside nested maps and lists. */
    @SuppressWarnings("unchecked")
    private Object substituteValue(Object value, Map<String, String> context) {
        if (value instanceof String text) {
            Matcher m = PLACEHOLDER.matcher(text);
            StringBuilder out = new StringBuilder();
            int last = 0;
            while (m.find()) {
                out.append(text, last, m.start());
                String key = m.group(1);
                String replacement = context.get(key);
                if (replacement == null) {
                    // Leave it visible rather than substituting empty: an unbound placeholder should
                    // fail the step loudly instead of quietly sending a malformed request.
                    out.append("${").append(key).append('}');
                } else {
                    out.append(replacement);
                }
                last = m.end();
            }
            out.append(text.substring(last));
            return out.toString();
        }
        if (value instanceof Map<?, ?> map) {
            return substitute((Map<String, Object>) map, context);
        }
        if (value instanceof Collection<?> collection) {
            List<Object> out = new ArrayList<>(collection.size());
            collection.forEach(item -> out.add(substituteValue(item, context)));
            return out;
        }
        return value;
    }

    private Map<String, Object> substitute(Map<String, Object> source, Map<String, String> context) {
        Map<String, Object> out = new LinkedHashMap<>();
        source.forEach((key, value) -> out.put(key, substituteValue(value, context)));
        return out;
    }

    /** @return one message per unmet expectation; empty means the step passed */
    private List<String> match(Map<String, Object> expect, Map<String, Object> actual) {
        List<String> failures = new ArrayList<>();
        expect.forEach((key, expected) -> {
            if (!actual.containsKey(key)) {
                failures.add("expected '" + key + "' but the action reported no such value "
                        + "(reported: " + actual.keySet() + ")");
                return;
            }
            String expectedText = normalise(expected);
            String actualText = normalise(actual.get(key));
            if (!expectedText.equals(actualText)) {
                failures.add(key + ": expected " + expectedText + " but was " + actualText);
            }
        });
        return failures;
    }

    /** Normalises scalars and collections to a comparable text form. */
    private String normalise(Object value) {
        if (value == null) {
            return "null";
        }
        if (value instanceof Collection<?> collection) {
            List<String> parts = new ArrayList<>();
            collection.forEach(item -> parts.add(normalise(item)));
            return parts.toString();
        }
        if (value instanceof Boolean b) {
            return b.toString();
        }
        if (value instanceof Number n) {
            // 201 and 201.0 must compare equal; DE 39 "00" stays "00" because it arrives as a String.
            double d = n.doubleValue();
            return d == Math.rint(d) ? String.valueOf((long) d) : String.valueOf(d);
        }
        return String.valueOf(value);
    }
}
