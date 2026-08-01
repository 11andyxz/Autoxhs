package com.adxztech.pts.issuersim;

import com.adxztech.pts.common.api.IdvRiskRequest;
import com.adxztech.pts.common.api.IdvRiskResponse;
import com.adxztech.pts.common.api.IssuerAuthRequest;
import com.adxztech.pts.common.api.IssuerAuthResponse;
import com.adxztech.pts.common.iso8583.IsoFields;
import com.adxztech.pts.common.pan.Pan;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.YearMonth;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The issuer's two endpoints (S5.2, S6.2).
 *
 * <p><b>Deterministic risk.</b> The score is {@code last4 mod 100}, so a card's last two digits
 * <em>are</em> its ID&amp;V outcome. That makes every demo beat and every certification step
 * reproducible without a fraud model, and it is honest about what is being modelled: the decision
 * contract and its state consequences, not risk scoring itself.
 */
@RestController
@RequestMapping(produces = MediaType.APPLICATION_JSON_VALUE)
@EnableConfigurationProperties(IssuerRules.class)
public class IssuerSimController {

    private static final Logger log = LoggerFactory.getLogger(IssuerSimController.class);

    private final IssuerRules rules;

    /**
     * The last authorization the issuer saw. This is the assertion hook that proves the switch really
     * swapped DE 2 to the funding PAN -- without it, "detokenization happened" is only inferable.
     */
    private final AtomicReference<IssuerAuthRequest> lastAuthorization = new AtomicReference<>();
    private final AtomicLong authorizationCount = new AtomicLong();
    private final AtomicLong riskCallCount = new AtomicLong();

    public IssuerSimController(IssuerRules rules) {
        this.rules = rules;
    }

    @PostMapping(path = "/sim/idv/risk", consumes = MediaType.APPLICATION_JSON_VALUE)
    public IdvRiskResponse risk(@Valid @RequestBody IdvRiskRequest request) {
        riskCallCount.incrementAndGet();
        int score = scoreOf(request.fundingLast4());
        boolean blocked = rules.getIdvBlockedPans().stream()
                .anyMatch(pan -> pan.endsWith(request.fundingLast4()));
        String reason = blocked ? "ISSUER_HARD_BLOCK" : "SCORED";
        log.info("ID&V risk: bin={} last4={} requestor={} deviceBound={} -> score={} blocked={}",
                request.fundingBin(), request.fundingLast4(), request.requestorId(),
                request.deviceBound(), score, blocked);
        return new IdvRiskResponse(score, blocked, reason);
    }

    /** Risk score derived from the last four digits; see the class comment. */
    private int scoreOf(String last4) {
        if (last4 == null || !last4.matches("\\d{4}")) {
            return 99; // unparseable card data is maximally suspicious
        }
        return Integer.parseInt(last4) % 100;
    }

    @PostMapping(path = "/sim/authorize", consumes = MediaType.APPLICATION_JSON_VALUE)
    public IssuerAuthResponse authorize(@Valid @RequestBody IssuerAuthRequest request) {
        lastAuthorization.set(request);
        long n = authorizationCount.incrementAndGet();

        IssuerAuthResponse response = decide(request);
        log.info("authorization #{}: card={} amount={} tokenized={} -> {} ({})",
                n, maskedPan(request.fundingPan()), request.amountMinor(), request.tokenized(),
                response.responseCode(), response.reason());
        return response;
    }

    private IssuerAuthResponse decide(IssuerAuthRequest request) {
        if (rules.isApproveEverything()) {
            return new IssuerAuthResponse(IsoFields.RC_APPROVED, authCode(request), "APPROVE_ALL_MODE");
        }
        if (request.fundingPan() == null || request.fundingPan().isBlank()) {
            return new IssuerAuthResponse(IsoFields.RC_INVALID_CARD, null, "NO_CARD_PRESENTED");
        }
        if (rules.getHardDeclinePans().contains(request.fundingPan())) {
            return new IssuerAuthResponse(IsoFields.RC_DO_NOT_HONOR, null, "CARD_ON_ISSUER_DECLINE_LIST");
        }
        if (isExpired(request.fundingExpiry())) {
            // This is the decline that the card-reissue flow exists to prevent (S5.5): before the
            // reissue is applied the issuer sees a stale expiry and declines 54.
            return new IssuerAuthResponse(IsoFields.RC_EXPIRED_CARD, null,
                    "FUNDING_CARD_EXPIRED_" + request.fundingExpiry());
        }
        if (request.amountMinor() > rules.getDeclineAboveAmountMinor()) {
            return new IssuerAuthResponse(IsoFields.RC_INSUFFICIENT_FUNDS, null,
                    "AMOUNT_ABOVE_" + rules.getDeclineAboveAmountMinor());
        }
        return new IssuerAuthResponse(IsoFields.RC_APPROVED, authCode(request), "APPROVED");
    }

    /** @param yymm 4-digit expiry; a card is good through the last day of its expiry month */
    private boolean isExpired(String yymm) {
        if (yymm == null || !yymm.matches("\\d{4}")) {
            return true;
        }
        int year = 2000 + Integer.parseInt(yymm.substring(0, 2));
        int month = Integer.parseInt(yymm.substring(2, 4));
        if (month < 1 || month > 12) {
            return true;
        }
        return YearMonth.of(year, month).isBefore(YearMonth.now());
    }

    private String authCode(IssuerAuthRequest request) {
        String stan = request.stan() == null ? "000000" : request.stan();
        return "A" + stan.substring(Math.max(0, stan.length() - 5));
    }

    private String maskedPan(String pan) {
        return pan == null ? "none" : Pan.mask(pan);
    }

    // ------------------------------------------------------------------ demo / test hooks

    /**
     * Reveals the last authorization request as the issuer received it.
     *
     * <p>Explicitly a test and demo hook, and the reason it is safe: this is a simulator, and the value
     * of being able to assert "the issuer saw the funding PAN, not the token" outweighs the tidiness of
     * not having the endpoint. It is not present in any real service in this repository.
     */
    @GetMapping("/sim/last-authorization")
    public IssuerAuthRequest lastAuthorization() {
        return lastAuthorization.get();
    }

    @GetMapping("/sim/counters")
    public Map<String, Long> counters() {
        return Map.of(
                "authorizations", authorizationCount.get(),
                "riskCalls", riskCallCount.get());
    }

    @PostMapping("/sim/reset")
    public Map<String, String> reset() {
        lastAuthorization.set(null);
        authorizationCount.set(0);
        riskCallCount.set(0);
        return Map.of("status", "reset");
    }
}
