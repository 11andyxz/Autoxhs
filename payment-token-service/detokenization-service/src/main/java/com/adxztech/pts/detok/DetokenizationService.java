package com.adxztech.pts.detok;

import com.adxztech.pts.common.api.ControlsCheckResponse;
import com.adxztech.pts.common.api.DetokenizeRequest;
import com.adxztech.pts.common.api.DetokenizeResponse;
import com.adxztech.pts.common.api.RejectReason;
import com.adxztech.pts.common.cache.AtcGuard;
import com.adxztech.pts.common.crypto.CryptogramService;
import com.adxztech.pts.common.crypto.DekRegistry;
import com.adxztech.pts.common.crypto.EnvelopeCipher;
import com.adxztech.pts.common.crypto.KeyServiceException;
import com.adxztech.pts.common.vault.VaultRecord;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.YearMonth;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.function.Supplier;

/**
 * The authorization-path pipeline (S6.1). Everything about this class is shaped by a p99 budget of
 * roughly 22 ms.
 *
 * <p><b>Stage order: cheapest and safest rejects first.</b>
 * <ol>
 *   <li><b>resolve</b> -- token to vault record. The single biggest latency lever (S8).</li>
 *   <li><b>status</b> -- must be ACTIVE.</li>
 *   <li><b>domain</b> -- requestor and usage domain must match the binding.</li>
 *   <li><b>token expiry</b> -- an expired token cannot authorize.</li>
 *   <li><b>cryptogram</b> -- recomputed against the HSM-resident key, constant-time compared.</li>
 *   <li><b>ATC</b> -- monotonic advance, atomically.</li>
 *   <li><b>decrypt</b> -- the funding PAN, in memory only, never logged.</li>
 * </ol>
 *
 * <p><b>Deliberate deviation from S6.1.</b> The design document orders the ATC advance (its step 4)
 * before cryptogram verification (its step 5). This implementation defaults to the reverse, because
 * advancing a counter on an <em>unauthenticated</em> request is exploitable: anyone who learns a token
 * PAN can submit garbage cryptograms with a high ATC, ratchet the stored counter, and cause the genuine
 * device's subsequent authorizations to be rejected as replays. That is a denial-of-service against a
 * live card, achievable without any key material.
 *
 * <p>Verifying first costs 1-2 ms of in-process HMAC before rejecting a replay, which is negligible
 * against a hop, and it preserves both documented demo outcomes exactly: replaying a captured
 * transaction still returns {@code REPLAY_SUSPECTED} (its cryptogram is valid for that ATC, so it
 * reaches the ATC gate), and a tampered cryptogram still returns {@code CRYPTOGRAM_INVALID}. Set
 * {@code detok.atc-order=BEFORE_CRYPTOGRAM} to reproduce the document's ordering; the integration suite
 * covers both and demonstrates the counter-burning behaviour under the original order.
 *
 * <p>Every stage is separately timed, which is what makes the latency budget in S8.1 an observation
 * rather than an estimate -- and is the mechanical basis for latency-regression RCA on call (S13).
 */
@Service
public class DetokenizationService {

    private static final Logger log = LoggerFactory.getLogger(DetokenizationService.class);

    private final VaultReader vaultReader;
    private final ControlsGate controlsGate;
    private final AtcGuard atcGuard;
    private final CryptogramService cryptogramService;
    private final EnvelopeCipher envelopeCipher;
    private final DekRegistry dekRegistry;
    private final DetokProperties properties;

    private final Timer totalTimer;
    private final Timer resolveTimer;
    private final Timer controlsTimer;
    private final Timer cryptoTimer;
    private final Timer atcTimer;
    private final Timer decryptTimer;
    private final MeterRegistry meterRegistry;
    private final ConcurrentMap<String, Counter> rejectCounters = new ConcurrentHashMap<>();

    public DetokenizationService(VaultReader vaultReader,
                                 ControlsGate controlsGate,
                                 AtcGuard atcGuard,
                                 CryptogramService cryptogramService,
                                 EnvelopeCipher envelopeCipher,
                                 DekRegistry dekRegistry,
                                 DetokProperties properties,
                                 MeterRegistry meterRegistry) {
        this.vaultReader = vaultReader;
        this.controlsGate = controlsGate;
        this.atcGuard = atcGuard;
        this.cryptogramService = cryptogramService;
        this.envelopeCipher = envelopeCipher;
        this.dekRegistry = dekRegistry;
        this.properties = properties;
        this.meterRegistry = meterRegistry;

        this.totalTimer = stageTimer(meterRegistry, "total");
        this.resolveTimer = stageTimer(meterRegistry, "resolve");
        this.controlsTimer = stageTimer(meterRegistry, "controls");
        this.cryptoTimer = stageTimer(meterRegistry, "cryptogram");
        this.atcTimer = stageTimer(meterRegistry, "atc");
        this.decryptTimer = stageTimer(meterRegistry, "decrypt");

        log.info("detokenization pipeline configured: cache={} controls={} atc={} order={}",
                vaultReader.describe(), controlsGate.describe(), atcGuard.describe(),
                properties.getAtcOrder());
    }

    private static Timer stageTimer(MeterRegistry registry, String stage) {
        return Timer.builder("pts.detok.stage")
                .tag("stage", stage)
                .description("detokenization stage latency; the S8.1 budget made observable")
                .publishPercentiles(0.5, 0.95, 0.99, 0.999)
                .register(registry);
    }

    public DetokenizeResponse detokenize(DetokenizeRequest request) {
        long start = System.nanoTime();
        try {
            return run(request);
        } finally {
            totalTimer.record(System.nanoTime() - start, java.util.concurrent.TimeUnit.NANOSECONDS);
        }
    }

    private DetokenizeResponse run(DetokenizeRequest request) {
        // ---- 1. resolve -------------------------------------------------------------------
        Optional<VaultRecord> found = timed(resolveTimer, () -> vaultReader.read(request.tokenPan()));
        if (found.isEmpty()) {
            return reject(RejectReason.TOKEN_NOT_FOUND, request, null);
        }
        VaultRecord record = found.get();

        // ---- 2/3. status and domain restriction --------------------------------------------
        ControlsCheckResponse verdict = timed(controlsTimer, () -> controlsGate.evaluate(record, request));
        if (!verdict.allowed()) {
            RejectReason reason = verdict.reason() == null
                    ? RejectReason.TOKEN_NOT_ACTIVE
                    : RejectReason.valueOf(verdict.reason());
            return reject(reason, request, record);
        }

        // ---- 4. token expiry ---------------------------------------------------------------
        if (isExpired(record.tokenExpiry())) {
            return reject(RejectReason.TOKEN_EXPIRED, request, record);
        }

        // ---- 5/6. cryptogram and ATC, in the configured order ------------------------------
        if (properties.getAtcOrder() == DetokProperties.AtcOrder.BEFORE_CRYPTOGRAM) {
            DetokenizeResponse atcRejection = checkAtc(request, record);
            if (atcRejection != null) {
                return atcRejection;
            }
            DetokenizeResponse cryptoRejection = checkCryptogram(request, record);
            if (cryptoRejection != null) {
                return cryptoRejection;
            }
        } else {
            DetokenizeResponse cryptoRejection = checkCryptogram(request, record);
            if (cryptoRejection != null) {
                return cryptoRejection;
            }
            DetokenizeResponse atcRejection = checkAtc(request, record);
            if (atcRejection != null) {
                return atcRejection;
            }
        }

        // ---- 7. decrypt and return ---------------------------------------------------------
        String fundingPan;
        try {
            fundingPan = timed(decryptTimer, () -> envelopeCipher.open(
                    dekRegistry.byVersion(record.keyVersion()).key(),
                    record.fundingPanEnc(),
                    record.tokenPan()));
        } catch (EnvelopeCipher.TamperedCiphertextException | KeyServiceException e) {
            log.error("vault decryption failed for tokenRef={} keyVersion={}: {}",
                    record.tokenRef(), record.keyVersion(), e.getClass().getSimpleName());
            return reject(RejectReason.VAULT_ERROR, request, record);
        }

        // The funding PAN exists in memory from here to the DE 2 swap and is never logged.
        return DetokenizeResponse.proceed(fundingPan, record.fundingExpiry(), record.tokenRef(),
                record.issuerId());
    }

    private DetokenizeResponse checkCryptogram(DetokenizeRequest request, VaultRecord record) {
        boolean valid = timed(cryptoTimer, () -> cryptogramService.verifyHex(
                request.tokenPan(), request.atc(), request.unpredictableNumber(),
                request.amountMinor(), request.cryptogram()));
        return valid ? null : reject(RejectReason.CRYPTOGRAM_INVALID, request, record);
    }

    private DetokenizeResponse checkAtc(DetokenizeRequest request, VaultRecord record) {
        boolean advanced = timed(atcTimer,
                () -> atcGuard.checkAndAdvance(request.tokenPan(), request.atc()));
        return advanced ? null : reject(RejectReason.REPLAY_SUSPECTED, request, record);
    }

    /** @param yymm token expiry; a token is valid through the last day of its expiry month */
    private boolean isExpired(String yymm) {
        if (yymm == null || !yymm.matches("\\d{4}")) {
            return true;
        }
        int month = Integer.parseInt(yymm.substring(2, 4));
        if (month < 1 || month > 12) {
            return true;
        }
        return YearMonth.of(2000 + Integer.parseInt(yymm.substring(0, 2)), month)
                .isBefore(YearMonth.now());
    }

    private DetokenizeResponse reject(RejectReason reason, DetokenizeRequest request, VaultRecord record) {
        rejectCounters.computeIfAbsent(reason.name(), name -> Counter.builder("pts.detok.reject")
                        .tag("reason", name)
                        .description("detokenization rejections by reason; a Grafana dimension, not log text")
                        .register(meterRegistry))
                .increment();
        // tokenRef and last4 only: the token PAN itself must not reach a log line.
        log.info("detokenization REJECT {} tokenLast4={} tokenRef={} requestor={} atc={}",
                reason, last4(request.tokenPan()),
                record == null ? "unknown" : record.tokenRef(),
                request.requestorId(), request.atc());
        return DetokenizeResponse.reject(reason);
    }

    private static String last4(String pan) {
        return pan == null || pan.length() < 4 ? "????" : pan.substring(pan.length() - 4);
    }

    private static <T> T timed(Timer timer, Supplier<T> work) {
        long start = System.nanoTime();
        try {
            return work.get();
        } finally {
            timer.record(System.nanoTime() - start, java.util.concurrent.TimeUnit.NANOSECONDS);
        }
    }

    /** Reports the active flag combination -- the A/B demo reads this to label its runs. */
    public java.util.Map<String, String> activeConfiguration() {
        return java.util.Map.of(
                "cacheMode", properties.getCacheMode().name(),
                "controlsInline", String.valueOf(properties.getControls().isInline()),
                "atcMode", properties.getAtcMode().name(),
                "atcOrder", properties.getAtcOrder().name(),
                "vaultReader", vaultReader.describe(),
                "controlsGate", controlsGate.describe(),
                "atcGuard", atcGuard.describe());
    }
}
