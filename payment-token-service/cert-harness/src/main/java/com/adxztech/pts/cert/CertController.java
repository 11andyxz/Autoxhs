package com.adxztech.pts.cert;

import com.adxztech.pts.common.web.ApiExceptions;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Runs suites on demand ({@code POST /cert/run}) or on start-up in CLI mode (S10.5). */
@RestController
public class CertController {

    private static final Logger log = LoggerFactory.getLogger(CertController.class);

    private final SuiteLoader suiteLoader;
    private final SuiteRunner suiteRunner;
    private final HtmlReportWriter reportWriter;
    private final CertProperties properties;

    public CertController(SuiteLoader suiteLoader, SuiteRunner suiteRunner,
                          HtmlReportWriter reportWriter, CertProperties properties) {
        this.suiteLoader = suiteLoader;
        this.suiteRunner = suiteRunner;
        this.reportWriter = reportWriter;
        this.properties = properties;
    }

    @PostMapping(path = "/cert/run", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> run(@RequestParam String suite) {
        SuiteRunner.SuiteResult result = suiteRunner.run(suiteLoader.load(suite));
        String reportPath = writeReport(result);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("suite", result.suiteName());
        out.put("issuerId", result.issuerId());
        out.put("passed", result.passed());
        out.put("failed", result.failed());
        out.put("skipped", result.skipped());
        out.put("durationMs", result.durationMs());
        out.put("allPassed", result.allPassed());
        out.put("report", reportPath);
        out.put("steps", result.steps().stream().map(step -> Map.of(
                "id", step.id(),
                "action", step.action(),
                "passed", step.passed(),
                "failures", step.failures())).toList());
        return out;
    }

    @GetMapping(path = "/cert/actions", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<String> actions() {
        return HttpStepExecutor.supportedActions();
    }

    private String writeReport(SuiteRunner.SuiteResult result) {
        try {
            Path path = reportWriter.write(result, Path.of(properties.getReportDirectory()));
            return path.toAbsolutePath().toString();
        } catch (IOException e) {
            throw new ApiExceptions.DependencyUnavailableException(
                    "cannot write the certification report", e);
        }
    }

    /**
     * CLI mode, invoked by the Jenkins {@code cert-suite} stage.
     *
     * <p>Exits non-zero on failure when {@code cert.exit-on-completion} is set, which is what makes the
     * pipeline stage go red rather than logging a failure and continuing to the release gate.
     */
    @Bean
    ApplicationRunner certSuiteRunner(SuiteLoader loader, SuiteRunner runner,
                                      HtmlReportWriter writer, CertProperties props) {
        return (ApplicationArguments args) -> {
            List<String> suites = new ArrayList<>(props.getSuites());
            suites.addAll(args.getOptionValues("cert.suite") == null
                    ? List.of() : args.getOptionValues("cert.suite"));
            if (suites.isEmpty()) {
                log.info("no certification suites requested; serving POST /cert/run");
                return;
            }
            boolean allPassed = true;
            for (String location : suites) {
                SuiteRunner.SuiteResult result = runner.run(loader.load(location));
                writer.write(result, Path.of(props.getReportDirectory()));
                allPassed &= result.allPassed();
            }
            if (props.isExitOnCompletion()) {
                System.exit(allPassed ? 0 : 1);
            }
        };
    }
}
