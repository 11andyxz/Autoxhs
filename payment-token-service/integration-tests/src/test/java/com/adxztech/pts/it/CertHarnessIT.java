package com.adxztech.pts.it;

import com.adxztech.pts.cert.CertSuite;
import com.adxztech.pts.cert.HtmlReportWriter;
import com.adxztech.pts.cert.SuiteLoader;
import com.adxztech.pts.cert.SuiteRunner;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Runs the shipped certification suites against the live stack (S10.5).
 *
 * <p>This is the test that makes the onboarding claim real. The suites are not fixtures written for this
 * test -- they are the artefacts an issuer's integration team would be handed, replayed end to end through
 * REST and a TCP socket. If a change breaks the ISO 8583 field handling, these go red before any human
 * looks at a message trace.
 */
class CertHarnessIT extends IntegrationTestBase {

    private SuiteRunner runner() {
        return fixture.certContext().getBean(SuiteRunner.class);
    }

    private SuiteLoader loader() {
        return fixture.certContext().getBean(SuiteLoader.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"suites/issuer-a-legacy.yml", "suites/issuer-b-token-aware.yml"})
    @DisplayName("the shipped certification suites pass end to end")
    void shippedSuitesPass(String location) {
        CertSuite suite = loader().load(location);
        assertThat(suite.steps()).isNotEmpty();

        SuiteRunner.SuiteResult result = runner().run(suite);

        // Name the failures rather than just asserting a boolean: a red certification run should tell you
        // which data element was wrong without opening a log.
        List<String> failures = result.steps().stream()
                .filter(step -> !step.passed())
                .map(step -> step.id() + " -> " + step.failures())
                .toList();
        assertThat(failures).as("failed steps in %s", location).isEmpty();
        assertThat(result.allPassed()).isTrue();
        assertThat(result.failed()).isZero();
        assertThat(result.skipped()).isZero();
        assertThat(result.passed()).isEqualTo(suite.steps().size());
    }

    @Test
    @DisplayName("a suite run produces a readable HTML report")
    void writesAnHtmlReport() throws Exception {
        SuiteRunner.SuiteResult result = runner().run(loader().load("suites/issuer-a-legacy.yml"));
        Path directory = Path.of("target/cert-reports");
        Path report = new HtmlReportWriter().write(result, directory);

        assertThat(Files.exists(report)).isTrue();
        String html = Files.readString(report);
        assertThat(html).contains("Certification report").contains("ISSA");
        assertThat(html).contains(result.allPassed() ? "PASS" : "FAIL");
        // The report is an emailed artefact: it must not carry a full card number.
        assertThat(html).doesNotContain("4111100000000725");
    }

    @Test
    @DisplayName("the runner reports a genuine failure instead of passing it")
    void aBrokenExpectationFails() {
        // The harness's own correctness matters: a runner that silently passes an unmatched expectation
        // would make every green report meaningless.
        CertSuite broken = new CertSuite("deliberately broken", "ISSA", "self-test", List.of(
                new CertSuite.CertStep("provision", "provision", "green path provisioning",
                        Map.of("fundingPan", ItCards.nextIssaApprove(),
                                "expiry", "2812",
                                "requestorId", com.adxztech.pts.common.demo.DemoCards.WALLET_REQUESTOR,
                                "domainType", "ECOM"),
                        Map.of("status", 201, "decision", "DECLINE"), // wrong on purpose
                        Map.of()),
                new CertSuite.CertStep("never-runs", "get-token", "should be skipped",
                        Map.of("tokenRef", "whatever"), Map.of("status", 200), Map.of())));

        SuiteRunner.SuiteResult result = runner().run(broken);

        assertThat(result.allPassed()).isFalse();
        assertThat(result.failed()).isEqualTo(1);
        assertThat(result.steps().get(0).failures())
                .anyMatch(message -> message.contains("decision") && message.contains("DECLINE"));
        // A failed step aborts the suite: later steps depend on it and would fail meaninglessly.
        assertThat(result.skipped()).isEqualTo(1);
        assertThat(result.steps().get(1).failures()).anyMatch(m -> m.startsWith("skipped"));
    }

    @Test
    @DisplayName("an expectation on a value the action never reports is a failure, not a silent skip")
    void unknownExpectationKeyFails() {
        CertSuite suite = new CertSuite("unknown key", "ISSA", "self-test", List.of(
                new CertSuite.CertStep("provision", "provision", null,
                        Map.of("fundingPan", ItCards.nextIssaApprove(),
                                "expiry", "2812",
                                "requestorId", com.adxztech.pts.common.demo.DemoCards.WALLET_REQUESTOR,
                                "domainType", "ECOM"),
                        Map.of("thisFieldDoesNotExist", "anything"),
                        Map.of())));

        SuiteRunner.SuiteResult result = runner().run(suite);
        assertThat(result.allPassed()).isFalse();
        assertThat(result.steps().get(0).failures())
                .anyMatch(message -> message.contains("thisFieldDoesNotExist"));
    }

    @Test
    @DisplayName("an unbound placeholder fails the step rather than sending a malformed request")
    void unboundPlaceholderFails() {
        CertSuite suite = new CertSuite("unbound placeholder", "ISSA", "self-test", List.of(
                new CertSuite.CertStep("lookup", "get-token", null,
                        Map.of("tokenRef", "${neverCaptured}"),
                        Map.of("status", 200),
                        Map.of())));

        SuiteRunner.SuiteResult result = runner().run(suite);
        assertThat(result.allPassed()).isFalse();
    }
}
