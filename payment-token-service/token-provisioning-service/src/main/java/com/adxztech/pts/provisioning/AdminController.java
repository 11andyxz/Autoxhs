package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.crypto.JdbcDekRegistry;
import com.adxztech.pts.common.crypto.KeyService;
import com.adxztech.pts.common.persistence.BinMapRepository;
import com.adxztech.pts.common.persistence.KeyRegistryRepository;
import com.adxztech.pts.common.persistence.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Operational endpoints: key rotation, cache reconciliation, outbox visibility, issuer capability flags.
 *
 * <p>Unauthenticated in the demo, which is a deliberate scope decision rather than an oversight: this
 * stack has no identity provider and mTLS between services is the design's stated transport (S5). In
 * production these sit behind admin authentication with dual approval, exactly like the change-management
 * story in S10.5.
 */
@RestController
@RequestMapping(path = "/admin", produces = MediaType.APPLICATION_JSON_VALUE)
public class AdminController {

    private static final Logger log = LoggerFactory.getLogger(AdminController.class);

    private final JdbcDekRegistry dekRegistry;
    private final KeyRegistryRepository keyRegistryRepository;
    private final KeyService keyService;
    private final OutboxRepository outboxRepository;
    private final OutboxPoller outboxPoller;
    private final CacheReconciliationJob reconciliationJob;
    private final BinMapRepository binMapRepository;
    private final OtpService otpService;
    private final IdempotencyService idempotencyService;

    public AdminController(JdbcDekRegistry dekRegistry,
                           KeyRegistryRepository keyRegistryRepository,
                           KeyService keyService,
                           OutboxRepository outboxRepository,
                           OutboxPoller outboxPoller,
                           CacheReconciliationJob reconciliationJob,
                           BinMapRepository binMapRepository,
                           OtpService otpService,
                           IdempotencyService idempotencyService) {
        this.dekRegistry = dekRegistry;
        this.keyRegistryRepository = keyRegistryRepository;
        this.keyService = keyService;
        this.outboxRepository = outboxRepository;
        this.outboxPoller = outboxPoller;
        this.reconciliationJob = reconciliationJob;
        this.binMapRepository = binMapRepository;
        this.otpService = otpService;
        this.idempotencyService = idempotencyService;
    }

    /** Introduces a new ACTIVE DEK; historical rows keep decrypting under their own version (S7.5). */
    @PostMapping("/keys/rotate")
    public Map<String, Object> rotateKey() {
        int previous = dekRegistry.active().version();
        int next = dekRegistry.rotate();
        log.info("DEK rotation: v{} -> v{} (KEK custody: {})", previous, next, keyService.describe());
        return Map.of("previousVersion", previous, "activeVersion", next,
                "keyService", keyService.describe());
    }

    @GetMapping("/keys")
    public Map<String, Object> keys() {
        List<Map<String, Object>> versions = keyRegistryRepository.findAll().stream()
                .map(row -> Map.<String, Object>of(
                        "version", row.version(),
                        "state", row.state().name(),
                        "wrappedLength", row.wrappedDek().length))
                .toList();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("keyService", keyService.describe());
        out.put("activeVersion", dekRegistry.active().version());
        out.put("versions", versions);
        return out;
    }

    @GetMapping("/outbox")
    public Map<String, Object> outbox() {
        return Map.of("pending", outboxRepository.countPending());
    }

    /** Drains the outbox synchronously -- lets a demo or test avoid waiting on the scheduler. */
    @PostMapping("/outbox/drain")
    public Map<String, Object> drainOutbox() {
        return Map.of("published", outboxPoller.drainOnce(),
                "stillPending", outboxRepository.countPending());
    }

    @PostMapping("/cache/reconcile")
    public Map<String, Object> reconcile() {
        return Map.of("repaired", reconciliationJob.sweep());
    }

    /** Flips an issuer's token capability for the ISO 8583 backward-compatibility demo (S6.2). */
    @PostMapping("/issuers/{issuerId}/token-aware")
    public Map<String, Object> setTokenAware(@org.springframework.web.bind.annotation.PathVariable String issuerId,
                                             @RequestParam boolean enabled) {
        int updated = binMapRepository.setTokenAware(issuerId, enabled);
        log.info("issuer {} token_aware set to {} ({} BIN range(s) updated)", issuerId, enabled, updated);
        return Map.of("issuerId", issuerId, "tokenAware", enabled, "rangesUpdated", updated);
    }

    @GetMapping("/issuers")
    public List<Map<String, Object>> issuers() {
        return binMapRepository.findAllTokenRanges().stream()
                .map(r -> Map.<String, Object>of(
                        "issuerId", r.issuerId(),
                        "tokenBinStart", r.binStart(),
                        "tokenBinEnd", r.binEnd(),
                        "tokenAware", r.tokenAware()))
                .toList();
    }

    /** Housekeeping the scheduler also runs; exposed so a demo can show it explicitly. */
    @PostMapping("/housekeeping")
    public Map<String, Object> housekeeping() {
        return Map.of(
                "expiredIdvSessionsPurged", otpService.purgeExpired(),
                "expiredIdempotencyKeysPurged", idempotencyService.purgeExpired());
    }
}
