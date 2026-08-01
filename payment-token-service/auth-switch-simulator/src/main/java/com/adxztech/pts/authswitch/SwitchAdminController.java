package com.adxztech.pts.authswitch;

import com.adxztech.pts.common.iso8583.AuthMessages;
import com.adxztech.pts.common.iso8583.De48Markers;
import com.adxztech.pts.common.iso8583.IsoAuthClient;
import com.adxztech.pts.common.iso8583.IsoFields;
import com.adxztech.pts.common.iso8583.TokenCryptogramTlv;
import com.adxztech.pts.common.util.Hex;
import com.adxztech.pts.common.web.ApiExceptions;
import org.jpos.iso.ISOMsg;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Switch observability and a curl-friendly way to inject an authorization.
 *
 * <p>{@link #authorize} deliberately goes out over the <em>real</em> TCP socket rather than calling the
 * listener directly: a shortcut past the wire would leave the packager and the framing untested, which
 * is exactly the part the ISO 8583 claim rests on.
 */
@RestController
@RequestMapping(path = "/sim", produces = MediaType.APPLICATION_JSON_VALUE)
public class SwitchAdminController {

    private final IsoServerRunner serverRunner;
    private final ForwardedMessageRecorder recorder;

    public SwitchAdminController(IsoServerRunner serverRunner, ForwardedMessageRecorder recorder) {
        this.serverRunner = serverRunner;
        this.recorder = recorder;
    }

    /** Everything an acquirer would have put on the wire. */
    public record IsoAuthorizeRequest(String tokenPan,
                                      String tokenExpiry,
                                      long amountMinor,
                                      int atc,
                                      String unpredictableNumber,
                                      String cryptogram,
                                      String requestorId,
                                      String domainType,
                                      String stan,
                                      String currencyCode) {
    }

    @PostMapping(path = "/iso/authorize", consumes = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> authorize(@RequestBody IsoAuthorizeRequest request) {
        try (IsoAuthClient client = new IsoAuthClient("127.0.0.1", serverRunner.port(), 10_000)) {
            TokenCryptogramTlv tlv = new TokenCryptogramTlv(
                    Hex.decode(request.cryptogram()),
                    request.atc(),
                    Hex.decode(request.unpredictableNumber()));
            De48Markers markers = De48Markers.builder()
                    .requestorId(request.requestorId())
                    .domainType(request.domainType())
                    .build();

            ISOMsg response = client.authorize(new AuthMessages.AuthRequest(
                    request.tokenPan(),
                    request.tokenExpiry(),
                    request.amountMinor(),
                    request.stan() == null ? "1" : request.stan(),
                    request.currencyCode() == null ? "840" : request.currencyCode(),
                    "TERM0001",
                    "12345678901",
                    "000000",
                    tlv,
                    markers));

            Map<String, Object> out = new LinkedHashMap<>();
            out.put("mti", response.getMTI());
            out.put("de39", AuthMessages.responseCode(response));
            out.put("de38AuthCode", response.getString(38));
            out.put("de11Stan", response.getString(IsoFields.DE_STAN));
            out.put("approved", IsoFields.RC_APPROVED.equals(AuthMessages.responseCode(response)));
            return out;
        } catch (Exception e) {
            throw new ApiExceptions.DependencyUnavailableException(
                    "ISO 8583 authorization failed: " + e.getMessage(), e);
        }
    }

    /** The shape of the last message forwarded to an issuer -- the S6.2 assertion hook. */
    @GetMapping("/last-forwarded")
    public ForwardedMessageRecorder.Forwarded lastForwarded() {
        ForwardedMessageRecorder.Forwarded last = recorder.last();
        if (last == null) {
            throw new ApiExceptions.NotFoundException("no message has been forwarded yet");
        }
        return last;
    }

    @PostMapping("/last-forwarded/clear")
    public Map<String, String> clear() {
        recorder.clear();
        return Map.of("status", "cleared");
    }

    @GetMapping("/status")
    public Map<String, Object> status() {
        return Map.of("isoPort", serverRunner.port(),
                "listening", serverRunner.isRunning(),
                "connections", serverRunner.connectionCount());
    }
}
