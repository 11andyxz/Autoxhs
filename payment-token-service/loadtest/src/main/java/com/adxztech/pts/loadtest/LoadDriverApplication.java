package com.adxztech.pts.loadtest;

import com.adxztech.pts.common.config.CryptoConfig;
import com.adxztech.pts.common.config.PersistenceConfig;
import com.adxztech.pts.common.crypto.CryptogramService;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.token.TokenStatus;
import com.adxztech.pts.common.vault.VaultRecord;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

/**
 * The load driver behind the latency A/B (S11).
 *
 * <p>Console application, run per flag combination:
 * <pre>
 *   java -jar loadtest-exec.jar \
 *     --load.url=http://localhost:8082 \
 *     --load.profile="ramp:50-&gt;800/30s,constant:800/60s,spike:2000/10s" \
 *     --load.label=baseline
 * </pre>
 *
 * <p>It reads the token pool from the vault and computes valid cryptograms with the same key material the
 * detokenization service verifies against, so it exercises the <em>accept</em> path. A load test that only
 * ever produces rejections would measure the cheapest branch in the pipeline and prove nothing about the
 * budget.
 *
 * <p>Every run records the target's live flag configuration (from {@code /v1/detokenize/config}) into its
 * report, so a result can never be attributed to the wrong arm of the A/B after the fact.
 */
@SpringBootApplication
@Import({CryptoConfig.class, PersistenceConfig.class})
public class LoadDriverApplication {

    private static final Logger log = LoggerFactory.getLogger(LoadDriverApplication.class);

    public static void main(String[] args) {
        SpringApplication app = new SpringApplication(LoadDriverApplication.class);
        app.setWebApplicationType(org.springframework.boot.WebApplicationType.NONE);
        app.run(args);
    }

    @Bean
    ApplicationRunner loadRunner(VaultRepository vaultRepository,
                                 CryptogramService cryptogramService) {
        // Constructed rather than injected: Boot's ObjectMapper auto-configuration needs
        // Jackson2ObjectMapperBuilder from spring-web, and this application deliberately has no web
        // stack. One plain mapper for one small response body is the right amount of machinery.
        ObjectMapper objectMapper = new ObjectMapper()
                .configure(com.fasterxml.jackson.databind.DeserializationFeature
                        .FAIL_ON_UNKNOWN_PROPERTIES, false);
        return (ApplicationArguments args) -> {
            String baseUrl = option(args, "load.url", "http://localhost:8082");
            String profileSpec = option(args, "load.profile",
                    "ramp:50->500/20s,constant:500/40s,spike:1200/10s");
            String label = option(args, "load.label", "run");
            double zipfExponent = Double.parseDouble(option(args, "load.zipf-exponent", "1.0"));
            int workers = Integer.parseInt(option(args, "load.workers", "256"));
            int poolLimit = Integer.parseInt(option(args, "load.token-pool", "2000"));
            int poolOffset = Integer.parseInt(option(args, "load.token-offset", "0"));
            Path outputDir = Path.of(option(args, "load.out", "target/load-reports"));

            List<String> tokens = loadTokenPool(vaultRepository, poolOffset, poolLimit);
            if (tokens.isEmpty()) {
                log.error("no ACTIVE tokens in the vault. Provision some first "
                        + "(ops/seed-tokens.sh) -- a load run against an empty pool measures nothing.");
                return;
            }

            ZipfianFeeder feeder = new ZipfianFeeder(tokens, zipfExponent);
            InjectionProfile profile = InjectionProfile.parse(profileSpec);
            HttpClient httpClient = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(2))
                    .version(HttpClient.Version.HTTP_1_1)
                    .build();

            Map<String, String> targetConfig = fetchTargetConfig(httpClient, baseUrl, objectMapper);

            log.info("load run '{}' against {}", label, baseUrl);
            log.info("  target flags : {}", targetConfig);
            log.info("  profile      : {}", profile.describe());
            log.info("  token pool   : {} tokens, zipf exponent {} (hottest 1% take {}% of traffic)",
                    feeder.poolSize(), feeder.exponent(),
                    Math.round(feeder.topShare(Math.max(1, feeder.poolSize() / 100)) * 100));

            OpenModelDriver driver = new OpenModelDriver(workers);
            OpenModelDriver.Result result = driver.run(profile,
                    id -> sendOne(httpClient, baseUrl, feeder, cryptogramService, id));

            LoadReport report = new LoadReport(label, baseUrl, targetConfig, feeder, result);
            report.printToConsole();
            report.write(outputDir);
        };
    }

    /**
     * Sends one detokenization request.
     *
     * <p>The ATC is derived from the request sequence so it advances monotonically per run. Repeated hits
     * on the same hot token would otherwise be rejected as replays, and the driver would end up measuring
     * the replay-rejection path rather than the full pipeline.
     */
    private OpenModelDriver.Outcome sendOne(HttpClient httpClient, String baseUrl, ZipfianFeeder feeder,
                                            CryptogramService cryptogramService, int sequence) {
        String tokenPan = feeder.next();
        int atc = 1 + (sequence % 60_000);
        long amountMinor = 100 + ThreadLocalRandom.current().nextInt(4_900);
        String un = String.format("%08X", ThreadLocalRandom.current().nextInt());
        String cryptogram = cryptogramService.computeHex(tokenPan, atc, un, amountMinor);

        String body = "{"
                + "\"tokenPan\":\"" + tokenPan + "\","
                + "\"cryptogram\":\"" + cryptogram + "\","
                + "\"atc\":" + atc + ","
                + "\"unpredictableNumber\":\"" + un + "\","
                + "\"amountMinor\":" + amountMinor + ","
                + "\"requestorId\":\"" + com.adxztech.pts.common.demo.DemoCards.WALLET_REQUESTOR + "\","
                + "\"domainType\":\"ECOM\"}";

        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/v1/detokenize"))
                .timeout(Duration.ofSeconds(5))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();
        try {
            HttpResponse<Void> response =
                    httpClient.send(request, HttpResponse.BodyHandlers.discarding());
            if (response.statusCode() == 200) {
                return OpenModelDriver.Outcome.SUCCESS;
            }
            // 422 is a business rejection: recorded separately so it cannot be mistaken for an error,
            // and so a run that accidentally rejects everything is obvious in the report.
            return response.statusCode() == 422
                    ? OpenModelDriver.Outcome.REJECTED_BY_SERVICE
                    : OpenModelDriver.Outcome.ERROR;
        } catch (IOException e) {
            return OpenModelDriver.Outcome.ERROR;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return OpenModelDriver.Outcome.ERROR;
        }
    }

    /**
     * Selects a slice of the ACTIVE token pool.
     *
     * <p><b>Why the offset exists.</b> The ATC is a monotonic per-token counter, so a token used by one
     * load run cannot be reused by the next: the second run would present counters the first already
     * consumed and every request would be rejected as a replay. An A/B done that way measures the
     * replay-rejection path in its later arms -- which short-circuits before decryption -- and reports a
     * far better improvement than the code actually delivers. Giving each arm a disjoint slice keeps every
     * arm on the accept path, which is the only comparison worth making.
     *
     * <p>The ordering is sorted rather than whatever the database returns, so a slice is stable across
     * runs and processes.
     */
    private List<String> loadTokenPool(VaultRepository vaultRepository, int offset, int limit) {
        List<String> all = new ArrayList<>();
        for (VaultRecord record : vaultRepository.findAll()) {
            if (record.status() == TokenStatus.ACTIVE) {
                all.add(record.tokenPan());
            }
        }
        all.sort(String::compareTo);
        if (offset >= all.size()) {
            log.error("token offset {} is beyond the {} ACTIVE tokens in the vault", offset, all.size());
            return List.of();
        }
        List<String> slice = all.subList(offset, Math.min(all.size(), offset + limit));
        log.info("token pool slice [{}, {}) of {} ACTIVE tokens", offset, offset + slice.size(), all.size());
        return List.copyOf(slice);
    }

    @SuppressWarnings("unchecked")
    private Map<String, String> fetchTargetConfig(HttpClient httpClient, String baseUrl,
                                                  ObjectMapper objectMapper) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/v1/detokenize/config"))
                    .timeout(Duration.ofSeconds(5)).GET().build();
            HttpResponse<String> response =
                    httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 200) {
                return objectMapper.readValue(response.body(), Map.class);
            }
        } catch (Exception e) {
            log.warn("could not read the target's flag configuration: {}", e.toString());
        }
        return Map.of("configuration", "unavailable");
    }

    private static String option(ApplicationArguments args, String name, String fallback) {
        List<String> values = args.getOptionValues(name);
        return values == null || values.isEmpty() ? fallback : values.get(0);
    }

    /** Writes a run report to disk alongside the console summary. */
    record LoadReport(String label, String targetUrl, Map<String, String> targetConfig,
                      ZipfianFeeder feeder, OpenModelDriver.Result result) {

        void printToConsole() {
            LatencyHistogram.Snapshot latency = result.latency();
            System.out.printf("%n=== load run: %s =====================================%n", label);
            System.out.printf("target        : %s%n", targetUrl);
            System.out.printf("flags         : %s%n", targetConfig);
            System.out.printf("profile       : %s%n", result.profile());
            System.out.printf("offered rate  : %.0f/s   achieved: %.0f/s%n",
                    result.offeredRate(), result.achievedRate());
            System.out.printf("requests      : %d attempted, %d ok, %d rejected(422), %d errors, %d dropped%n",
                    result.attempted(), result.succeeded(), result.serviceRejected(),
                    result.errors(), result.dropped());
            System.out.printf("latency (ms)  : p50=%.2f  p95=%.2f  p99=%.2f  p99.9=%.2f  max=%.2f%n",
                    latency.p50(), latency.p95(), latency.p99(), latency.p999(), latency.max());
            System.out.printf("error rate    : %.3f%%%n", result.errorPercent());
            System.out.println("NOTE: latency is measured from each request's SCHEDULED arrival time,");
            System.out.println("      so queueing delay is included (no coordinated omission).");
            double acceptRate = result.attempted() == 0 ? 0
                    : 100.0 * result.succeeded() / result.attempted();
            System.out.printf("accept rate   : %.1f%%%n", acceptRate);
            if (acceptRate < 95.0) {
                // A run that mostly rejects has measured a short-circuited path and is NOT comparable
                // to one that mostly accepts. Saying so loudly is what stops a bad number being quoted.
                System.out.println("!! WARNING: most requests were REJECTED, so this run measured the");
                System.out.println("!! rejection path, not full detokenization. The usual cause is reusing");
                System.out.println("!! tokens whose ATC a previous run already advanced -- give each run a");
                System.out.println("!! disjoint --load.token-offset. These numbers are NOT comparable.");
            }
            System.out.println("=========================================================");
        }

        void write(Path directory) throws IOException {
            Files.createDirectories(directory);
            LatencyHistogram.Snapshot latency = result.latency();
            String csv = "label,target,profile,offeredRate,achievedRate,attempted,ok,rejected422,"
                    + "errors,dropped,p50ms,p95ms,p99ms,p999ms,maxms,errorPercent,acceptPercent,flags\n"
                    + String.join(",",
                    label, targetUrl, '"' + result.profile() + '"',
                    String.format("%.0f", result.offeredRate()),
                    String.format("%.0f", result.achievedRate()),
                    String.valueOf(result.attempted()), String.valueOf(result.succeeded()),
                    String.valueOf(result.serviceRejected()), String.valueOf(result.errors()),
                    String.valueOf(result.dropped()),
                    String.format("%.2f", latency.p50()), String.format("%.2f", latency.p95()),
                    String.format("%.2f", latency.p99()), String.format("%.2f", latency.p999()),
                    String.format("%.2f", latency.max()),
                    String.format("%.3f", result.errorPercent()),
                    String.format("%.1f", result.attempted() == 0 ? 0
                            : 100.0 * result.succeeded() / result.attempted()),
                    '"' + targetConfig.toString().replace('"', '\'') + '"') + "\n";
            Path target = directory.resolve("load-" + label + ".csv");
            Files.writeString(target, csv, StandardCharsets.UTF_8);
            log.info("load report written to {}", target.toAbsolutePath());
        }
    }
}
