package com.adxztech.pts.authswitch;

import com.adxztech.pts.common.api.DetokenizeRequest;
import com.adxztech.pts.common.api.DetokenizeResponse;
import com.adxztech.pts.common.api.IssuerAuthRequest;
import com.adxztech.pts.common.api.IssuerAuthResponse;
import com.adxztech.pts.common.api.RejectReason;
import com.adxztech.pts.common.client.DetokenizeClient;
import com.adxztech.pts.common.client.IssuerSimClient;
import com.adxztech.pts.common.iso8583.AuthMessages;
import com.adxztech.pts.common.iso8583.De48Markers;
import com.adxztech.pts.common.iso8583.IsoFields;
import com.adxztech.pts.common.iso8583.TokenCryptogramTlv;
import com.adxztech.pts.common.pan.Pan;
import com.adxztech.pts.common.persistence.BinMapRepository;
import com.adxztech.pts.common.token.TokenBinRange;
import com.adxztech.pts.common.trace.TraceContext;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.jpos.iso.ISOMsg;
import org.jpos.iso.ISORequestListener;
import org.jpos.iso.ISOSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Field-level ISO 8583 token handling (S6.2).
 *
 * <p>The flow for a {@code 0100}:
 * <ol>
 *   <li>read the token from DE 2, the cryptogram TLV from DE 55 and the token markers from DE 48;</li>
 *   <li>call detokenization with the tuple those fields carry;</li>
 *   <li>on PROCEED, build the outbound message according to the issuer's capability flag;</li>
 *   <li>forward, then relay the issuer's response code in a {@code 0110}.</li>
 * </ol>
 *
 * <p><b>The backward-compatibility split.</b> {@code issuer_bin_map.token_aware} decides the outbound
 * shape, and the two shapes are genuinely different messages:
 *
 * <table border="1">
 *   <caption>Outbound message by issuer capability</caption>
 *   <tr><th></th><th>token-unaware</th><th>token-aware</th></tr>
 *   <tr><td>DE 2</td><td>funding PAN (swapped)</td><td>network token (unchanged)</td></tr>
 *   <tr><td>DE 14</td><td>funding expiry</td><td>token expiry</td></tr>
 *   <tr><td>DE 55</td><td>stripped</td><td>forwarded</td></tr>
 *   <tr><td>DE 48</td><td>stripped</td><td>forwarded</td></tr>
 * </table>
 *
 * <p>A legacy issuer therefore receives a message indistinguishable from a plain card transaction -- it
 * needs no changes at all to accept tokenized traffic, which is the whole point.
 *
 * <p><b>The response always echoes the token.</b> The {@code 0110} is built from the original request, so
 * the acquirer sees the DE 2 it sent. Returning the funding PAN to the acquirer would leak the very
 * thing tokenization exists to hide.
 */
public class TokenAuthRequestListener implements ISORequestListener {

    private static final Logger log = LoggerFactory.getLogger(TokenAuthRequestListener.class);

    private final DetokenizeClient detokenizeClient;
    private final IssuerSimClient issuerSimClient;
    private final BinMapRepository binMapRepository;
    private final ForwardedMessageRecorder recorder;
    private final Timer switchTimer;
    private final MeterRegistry meterRegistry;
    private final ConcurrentMap<String, Counter> responseCounters = new ConcurrentHashMap<>();

    public TokenAuthRequestListener(DetokenizeClient detokenizeClient,
                                    IssuerSimClient issuerSimClient,
                                    BinMapRepository binMapRepository,
                                    ForwardedMessageRecorder recorder,
                                    MeterRegistry meterRegistry) {
        this.detokenizeClient = detokenizeClient;
        this.issuerSimClient = issuerSimClient;
        this.binMapRepository = binMapRepository;
        this.recorder = recorder;
        this.meterRegistry = meterRegistry;
        this.switchTimer = Timer.builder("pts.switch.authorization")
                .description("end-to-end switch handling of an 0100")
                .publishPercentiles(0.5, 0.95, 0.99, 0.999)
                .register(meterRegistry);
    }

    @Override
    public boolean process(ISOSource source, ISOMsg request) {
        long start = System.nanoTime();
        // Each authorization gets its own trace id, propagated to detokenization and the issuer, so one
        // transaction is greppable across every service (S13).
        TraceContext.set(TraceContext.newId());
        try {
            ISOMsg response = handle(request);
            source.send(response);
            countResponse(response);
            return true;
        } catch (Exception e) {
            log.error("switch failure handling inbound message", e);
            trySendSystemError(source, request);
            return true;
        } finally {
            switchTimer.record(System.nanoTime() - start, java.util.concurrent.TimeUnit.NANOSECONDS);
            TraceContext.clear();
        }
    }

    private ISOMsg handle(ISOMsg request) throws Exception {
        String mti = request.getMTI();
        if (!IsoFields.MTI_AUTH_REQUEST.equals(mti)) {
            log.warn("unsupported MTI {}", mti);
            return AuthMessages.newAuthResponse(request, IsoFields.RC_SYSTEM_ERROR, null);
        }

        String tokenPan = request.getString(IsoFields.DE_PAN);
        if (tokenPan == null || tokenPan.isBlank()) {
            return AuthMessages.newAuthResponse(request, IsoFields.RC_INVALID_CARD, null);
        }

        // DE 55: cryptogram, ATC, unpredictable number.
        TokenCryptogramTlv cryptogramData;
        try {
            cryptogramData = TokenCryptogramTlv.decodeHex(request.getString(IsoFields.DE_ICC_DATA));
        } catch (TokenCryptogramTlv.TlvException e) {
            log.warn("malformed DE 55 on token ...{}: {}", last4(tokenPan), e.getMessage());
            return AuthMessages.newAuthResponse(request, IsoFields.RC_SYSTEM_ERROR, null);
        }

        // DE 48: token requestor and usage domain. Required for the domain-restriction check, which is
        // the control that makes a stolen token useless outside its binding.
        De48Markers markers = De48Markers.parse(request.getString(IsoFields.DE_PRIVATE_USE));
        if (markers.requestorId() == null || markers.domainType() == null) {
            log.warn("DE 48 is missing TRID/DOM on token ...{}; cannot evaluate domain restriction",
                    last4(tokenPan));
            return AuthMessages.newAuthResponse(request, IsoFields.RC_SYSTEM_ERROR, null);
        }

        long amountMinor = parseAmount(request.getString(IsoFields.DE_AMOUNT));

        DetokenizeResponse detok = detokenizeClient.detokenize(new DetokenizeRequest(
                tokenPan,
                cryptogramData.cryptogramHex(),
                cryptogramData.atc(),
                cryptogramData.unpredictableNumberHex(),
                amountMinor,
                markers.requestorId(),
                markers.domainType()));

        if (!detok.isProceed()) {
            RejectReason reason = detok.reason() == null
                    ? RejectReason.VAULT_ERROR
                    : RejectReason.valueOf(detok.reason());
            log.info("declining at the switch: token ...{} rejected as {} -> DE 39 {}",
                    last4(tokenPan), reason, reason.isoResponseCode());
            return AuthMessages.newAuthResponse(request, reason.isoResponseCode(), null);
        }

        // Capability lookup by token BIN: the leading 8 digits of the token identify its issuer.
        long tokenBin = Long.parseLong(tokenPan.substring(0, 8));
        Optional<TokenBinRange> range = binMapRepository.findTokenRange(tokenBin);
        boolean tokenAware = range.map(TokenBinRange::tokenAware).orElse(false);
        String issuerId = range.map(TokenBinRange::issuerId).orElse(detok.issuerId());

        ISOMsg outbound = buildOutbound(request, detok, tokenAware, issuerId);

        IssuerAuthResponse issuerResponse = issuerSimClient.authorize(new IssuerAuthRequest(
                detok.fundingPan(),
                detok.fundingExpiry(),
                amountMinor,
                request.getString(IsoFields.DE_CURRENCY),
                request.getString(IsoFields.DE_STAN),
                issuerId,
                tokenAware));

        log.info("authorized token ...{} as card {} via issuer {} (tokenAware={}) -> DE 39 {}",
                last4(tokenPan), Pan.mask(detok.fundingPan()), issuerId, tokenAware,
                issuerResponse.responseCode());

        // The response to the acquirer is built from the original request, so DE 2 is the token again.
        return AuthMessages.newAuthResponse(request, issuerResponse.responseCode(),
                issuerResponse.authCode());
    }

    /** Applies the S6.2 capability split and records the resulting shape. */
    private ISOMsg buildOutbound(ISOMsg request, DetokenizeResponse detok, boolean tokenAware,
                                 String issuerId) throws Exception {
        ISOMsg outbound = (ISOMsg) request.clone();
        List<Integer> stripped = new ArrayList<>();

        if (tokenAware) {
            // Forward the token and its cryptogram: this issuer validates the cryptogram itself.
            // DE 2 and DE 14 stay as presented.
            recorder.record(outbound, true, stripped, true, issuerId);
            return outbound;
        }

        // Full detokenization for a legacy issuer.
        outbound.set(IsoFields.DE_PAN, detok.fundingPan());
        if (detok.fundingExpiry() != null) {
            outbound.set(IsoFields.DE_EXPIRY, detok.fundingExpiry());
        }
        if (outbound.hasField(IsoFields.DE_ICC_DATA)) {
            outbound.unset(IsoFields.DE_ICC_DATA);
            stripped.add(IsoFields.DE_ICC_DATA);
        }
        if (outbound.hasField(IsoFields.DE_PRIVATE_USE)) {
            outbound.unset(IsoFields.DE_PRIVATE_USE);
            stripped.add(IsoFields.DE_PRIVATE_USE);
        }
        recorder.record(outbound, false, stripped, false, issuerId);
        return outbound;
    }

    private void countResponse(ISOMsg response) {
        String code = AuthMessages.responseCode(response);
        if (code == null) {
            return;
        }
        responseCounters.computeIfAbsent(code, c -> Counter.builder("pts.switch.response")
                .tag("de39", c)
                .description("switch responses by DE 39")
                .register(meterRegistry)).increment();
    }

    private void trySendSystemError(ISOSource source, ISOMsg request) {
        try {
            source.send(AuthMessages.newAuthResponse(request, IsoFields.RC_SYSTEM_ERROR, null));
        } catch (Exception e) {
            // The socket is already gone; the acquirer will time out. Nothing further to do.
            log.warn("could not deliver system-error response: {}", e.toString());
        }
    }

    private long parseAmount(String de4) {
        if (de4 == null || de4.isBlank()) {
            return 0L;
        }
        return Long.parseLong(de4.trim());
    }

    private static String last4(String pan) {
        return pan == null || pan.length() < 4 ? "????" : pan.substring(pan.length() - 4);
    }
}
