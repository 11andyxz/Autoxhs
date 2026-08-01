package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.api.CardUpdateRequest;
import com.adxztech.pts.common.api.CardUpdateResponse;
import com.adxztech.pts.common.crypto.DekVersion;
import com.adxztech.pts.common.crypto.EnvelopeCipher;
import com.adxztech.pts.common.crypto.JdbcDekRegistry;
import com.adxztech.pts.common.crypto.PanFingerprint;
import com.adxztech.pts.common.pan.Pan;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.vault.VaultRecord;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.YearMonth;
import java.util.ArrayList;
import java.util.List;

/**
 * Card reissue / expiry refresh -- the flow that keeps tokens valid when the plastic changes (S5.5).
 *
 * <p>This is the most commercially interesting lifecycle operation in the whole design: it removes a
 * class of avoidable declines. A cardholder loses their card, the issuer sends a new one with a new PAN
 * and expiry, and every wallet and card-on-file merchant keeps working, because the <b>token PAN never
 * changes</b> -- only what it resolves to underneath.
 *
 * <p>Mechanically: fingerprint the old card, find its tokens through the global index (they may span
 * several token-BIN partitions, which is exactly why that index is global -- S4.1), then re-seal each
 * one against the new funding PAN under the current DEK. One transaction per token, so a partial
 * failure leaves each token either fully updated or untouched, never half-migrated.
 */
@Service
public class CardUpdateService {

    private static final Logger log = LoggerFactory.getLogger(CardUpdateService.class);

    private final VaultRepository vaultRepository;
    private final VaultWriter vaultWriter;
    private final PanFingerprint panFingerprint;
    private final EnvelopeCipher envelopeCipher;
    private final JdbcDekRegistry dekRegistry;
    private final Counter tokensRepointed;

    public CardUpdateService(VaultRepository vaultRepository,
                             VaultWriter vaultWriter,
                             PanFingerprint panFingerprint,
                             EnvelopeCipher envelopeCipher,
                             JdbcDekRegistry dekRegistry,
                             MeterRegistry meterRegistry) {
        this.vaultRepository = vaultRepository;
        this.vaultWriter = vaultWriter;
        this.panFingerprint = panFingerprint;
        this.envelopeCipher = envelopeCipher;
        this.dekRegistry = dekRegistry;
        this.tokensRepointed = Counter.builder("pts.provisioning.card_update.tokens")
                .description("tokens re-pointed at a new funding PAN by a card reissue")
                .register(meterRegistry);
    }

    public CardUpdateResponse update(CardUpdateRequest request) {
        Pan oldPan = Pan.of(request.oldFundingPan());
        Pan newPan = Pan.of(request.newFundingPan());
        requireFutureExpiry(request.newExpiry());

        byte[] oldFingerprint = panFingerprint.compute(oldPan);
        List<VaultRecord> affected = vaultRepository.findByFundingFingerprint(oldFingerprint);

        if (affected.isEmpty()) {
            // Not an error: an issuer may reissue a card that was never tokenized. Answering 200 with
            // zero tokens is the truthful response and keeps the operation idempotent.
            log.info("card update for {}: no tokens reference this card", oldPan.masked());
            return new CardUpdateResponse(0, List.of());
        }

        DekVersion dek = dekRegistry.active();
        byte[] newFingerprint = panFingerprint.compute(newPan);
        List<String> updatedRefs = new ArrayList<>(affected.size());

        for (VaultRecord record : affected) {
            // AAD is the token PAN, which is unchanged -- so the new ciphertext stays bound to this row.
            byte[] sealed = envelopeCipher.seal(dek.key(), newPan.value(), record.tokenPan());
            vaultWriter.applyFundingUpdate(record, sealed, newFingerprint, newPan.last4(),
                    request.newExpiry(), dek.version());
            updatedRefs.add(record.tokenRef());
            tokensRepointed.increment();
        }

        log.info("card update {} -> {}: {} token(s) re-pointed, token PANs unchanged",
                oldPan.masked(), newPan.masked(), updatedRefs.size());
        return new CardUpdateResponse(updatedRefs.size(), updatedRefs);
    }

    private void requireFutureExpiry(String yymm) {
        int year = 2000 + Integer.parseInt(yymm.substring(0, 2));
        int month = Integer.parseInt(yymm.substring(2, 4));
        if (month < 1 || month > 12) {
            throw new IllegalArgumentException("expiry month out of range: " + yymm);
        }
        if (YearMonth.of(year, month).isBefore(YearMonth.now())) {
            throw new IllegalArgumentException("new expiry " + yymm + " is already in the past");
        }
    }
}
