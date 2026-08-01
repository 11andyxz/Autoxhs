package com.adxztech.pts.loadtest.gatling;

import com.adxztech.pts.common.crypto.CryptogramService;
import com.adxztech.pts.common.crypto.JceKeyService;
import com.adxztech.pts.common.demo.DemoCards;
import io.gatling.javaapi.core.ScenarioBuilder;
import io.gatling.javaapi.core.Simulation;
import io.gatling.javaapi.http.HttpProtocolBuilder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

import static io.gatling.javaapi.core.CoreDsl.StringBody;
import static io.gatling.javaapi.core.CoreDsl.constantUsersPerSec;
import static io.gatling.javaapi.core.CoreDsl.details;
import static io.gatling.javaapi.core.CoreDsl.global;
import static io.gatling.javaapi.core.CoreDsl.rampUsersPerSec;
import static io.gatling.javaapi.core.CoreDsl.scenario;
import static io.gatling.javaapi.http.HttpDsl.http;
import static io.gatling.javaapi.http.HttpDsl.status;

/**
 * Gatling simulation for the detokenization hot path (S11).
 *
 * <p><b>Not part of the build.</b> Shipped as reviewable source; see {@code loadtest/GATLING.md} and
 * {@code docs/DESIGN_DEVIATIONS.md} §5. The measured numbers in {@code docs/RESULTS.md} come from the
 * dependency-free driver in {@code src/main/java}, which implements the same methodology.
 *
 * <p>Three methodology choices carry the whole claim, and they are the reason this file is worth
 * reading even though it does not run here:
 *
 * <ol>
 *   <li><b>{@code injectOpen}, not {@code injectClosed}.</b> Authorization traffic arrives at a rate
 *       set by cardholders, independent of how fast the network responds. A closed model with a fixed
 *       number of looping users throttles itself when the system slows: fewer requests are offered,
 *       so measured latency <em>improves</em> as the system degrades. That is coordinated omission,
 *       and it is how a load test comes to report a healthy p99 for a service that is failing.</li>
 *   <li><b>A Zipfian feeder.</b> Card usage is heavily skewed -- a small set of cards drives most
 *       volume. A uniform feeder would spread traffic across the whole token pool, make a near-cache
 *       of any realistic size miss most of the time, and understate the optimization by a wide
 *       margin. This is not making the numbers look good; it is the only way to make them mean
 *       anything.</li>
 *   <li><b>A monotonically increasing ATC per token.</b> The ATC is a replay counter, so re-presenting
 *       one is correctly rejected. Without this the simulation would drift into measuring the
 *       replay-rejection path, which short-circuits before decryption and is far cheaper than a real
 *       authorization. The JDK driver enforces the same property and additionally fails a run whose
 *       accept rate drops below 95%.</li>
 * </ol>
 */
public class PaymentTokenSimulation extends Simulation {

    private static final String BASE_URL =
            System.getProperty("pts.url", "http://localhost:8082");

    /**
     * Must match every service's {@code pts.hsm.dev-seed}: the simulation computes cryptograms that
     * the detokenization service recomputes and compares. A mismatch would make every request fail
     * verification, and the run would silently measure the rejection path.
     */
    private static final String HSM_SEED =
            System.getProperty("pts.hsm.seed", "local-stack-shared-hsm-seed-01");

    /**
     * One line per token PAN. Produced by {@code ops/seed-tokens.py} plus a vault query -- the
     * provisioning API deliberately never returns token PANs, and a load generator stands in for the
     * requestor's device, which legitimately holds them.
     */
    private static final Path TOKEN_FILE =
            Path.of(System.getProperty("pts.tokens", "target/bench/tokens.txt"));

    private static final double ZIPF_EXPONENT =
            Double.parseDouble(System.getProperty("pts.zipf", "1.0"));

    private final CryptogramService cryptogramService =
            new CryptogramService(new JceKeyService(HSM_SEED));

    private final HttpProtocolBuilder httpProtocol = http
            .baseUrl(BASE_URL)
            .contentTypeHeader("application/json")
            .acceptHeader("application/json")
            // Connections are reused: a fresh TCP (and in production TLS) handshake per authorization
            // would put several millisecond of avoidable work inside the latency budget being measured.
            .shareConnections();

    private final ScenarioBuilder detokenize = scenario("detokenize-peak")
            .feed(zipfianTokenFeeder())
            .exec(http("detokenize")
                    .post("/v1/detokenize")
                    .body(StringBody(session -> buildDetokJson(session.getString("tokenPan"),
                            session.getInt("atc"))))
                    // 200 only. A 422 is a business rejection and, if it dominates, the run measured a
                    // short-circuited path -- so it must fail the assertion rather than be tolerated.
                    .check(status().is(200)));

    {
        setUp(detokenize.injectOpen(
                        rampUsersPerSec(50).to(2000).during(Duration.ofMinutes(2)),
                        constantUsersPerSec(2000).during(Duration.ofMinutes(5)),
                        constantUsersPerSec(6000).during(Duration.ofSeconds(30))))  // holiday spike
                .protocols(httpProtocol)
                .assertions(
                        // percentile4 is p99.9 by default in Gatling; percentile3 is p99.
                        global().responseTime().percentile3().lt(25),
                        global().failedRequests().percent().lt(0.1),
                        details("detokenize").successfulRequests().percent().gt(95.0));
    }

    /** Zipfian selection over the token pool, with a precomputed CDF so the feeder is not the bottleneck. */
    private Iterator<Map<String, Object>> zipfianTokenFeeder() {
        List<String> tokens = readTokens();
        double[] cumulative = new double[tokens.size()];
        double sum = 0;
        for (int i = 0; i < tokens.size(); i++) {
            sum += 1.0 / Math.pow(i + 1, ZIPF_EXPONENT);
            cumulative[i] = sum;
        }
        for (int i = 0; i < cumulative.length; i++) {
            cumulative[i] /= sum;
        }

        // Per-token ATC counters, so a hot token's counter always advances (see the class comment).
        Map<String, Integer> atcByToken = new HashMap<>();

        return new Iterator<>() {
            @Override
            public boolean hasNext() {
                return true;
            }

            @Override
            public Map<String, Object> next() {
                double u = ThreadLocalRandom.current().nextDouble();
                int low = 0;
                int high = cumulative.length - 1;
                while (low < high) {
                    int mid = (low + high) >>> 1;
                    if (cumulative[mid] < u) {
                        low = mid + 1;
                    } else {
                        high = mid;
                    }
                }
                String tokenPan = tokens.get(low);
                // The ATC field is two bytes, so it wraps at 0xFFFF. A long run needs a fresh token
                // pool rather than a wrapped counter, which would be rejected as a replay.
                int atc;
                synchronized (atcByToken) {
                    atc = atcByToken.merge(tokenPan, 1, (a, b) -> Math.min(0xFFFF, a + b));
                }
                return Map.of("tokenPan", tokenPan, "atc", atc);
            }
        };
    }

    private List<String> readTokens() {
        try {
            List<String> tokens = new ArrayList<>();
            for (String line : Files.readAllLines(TOKEN_FILE, StandardCharsets.UTF_8)) {
                String trimmed = line.trim();
                if (!trimmed.isEmpty() && trimmed.matches("\\d{12,19}")) {
                    tokens.add(trimmed);
                }
            }
            if (tokens.isEmpty()) {
                throw new IllegalStateException(TOKEN_FILE + " contains no token PANs");
            }
            return tokens;
        } catch (Exception e) {
            throw new IllegalStateException("cannot read the token pool from " + TOKEN_FILE
                    + ". Seed one first: ops/seed-tokens.py --count 2000", e);
        }
    }

    private String buildDetokJson(String tokenPan, int atc) {
        long amountMinor = 100 + ThreadLocalRandom.current().nextInt(4_900);
        String un = String.format("%08X", ThreadLocalRandom.current().nextInt());
        String cryptogram = cryptogramService.computeHex(tokenPan, atc, un, amountMinor);
        return "{"
                + "\"tokenPan\":\"" + tokenPan + "\","
                + "\"cryptogram\":\"" + cryptogram + "\","
                + "\"atc\":" + atc + ","
                + "\"unpredictableNumber\":\"" + un + "\","
                + "\"amountMinor\":" + amountMinor + ","
                + "\"requestorId\":\"" + DemoCards.WALLET_REQUESTOR + "\","
                + "\"domainType\":\"ECOM\"}";
    }
}
