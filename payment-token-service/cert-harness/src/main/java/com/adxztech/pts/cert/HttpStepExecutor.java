package com.adxztech.pts.cert;

import com.adxztech.pts.common.api.CardUpdateRequest;
import com.adxztech.pts.common.api.CardUpdateResponse;
import com.adxztech.pts.common.api.IdvVerifyRequest;
import com.adxztech.pts.common.api.ProvisionRequest;
import com.adxztech.pts.common.api.ProvisionResponse;
import com.adxztech.pts.common.api.TokenView;
import com.adxztech.pts.common.client.ProvisioningClient;
import com.adxztech.pts.common.crypto.CryptogramService;
import com.adxztech.pts.common.iso8583.AuthMessages;
import com.adxztech.pts.common.iso8583.De48Markers;
import com.adxztech.pts.common.iso8583.IsoAuthClient;
import com.adxztech.pts.common.iso8583.IsoFields;
import com.adxztech.pts.common.iso8583.TokenCryptogramTlv;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.util.Hex;
import com.adxztech.pts.common.vault.VaultRecord;
import org.jpos.iso.ISOMsg;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.RestClient;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Executes certification steps against a running stack (S10.5).
 *
 * <p><b>How the harness gets the token PAN.</b> The provisioning API never returns it -- that is a PCI
 * scope decision, not an oversight. A certification harness inside the network stands in for the token
 * requestor's device, which legitimately holds the token, so this one reads it from the vault. That is the
 * network-internal equivalent of what a wallet SDK would have on the handset. It is worth naming rather
 * than hiding, because "how did the harness get a token to authorize with?" is exactly the kind of detail
 * that reveals whether a demo is coherent.
 *
 * <p>Cryptograms are computed with the same {@link CryptogramService} the detokenization service verifies
 * with, both configured from the same key seed. If the harness and the service disagreed about the
 * canonical input, every certification run would fail for the wrong reason.
 */
public class HttpStepExecutor implements StepExecutor {

    private final ProvisioningClient provisioningClient;
    /** Provisioning service admin API: key rotation, issuer capability flags. */
    private final RestClient provisioningAdminClient;
    /** Auth switch admin API: the forwarded-message shape used by the S6.2 assertions. */
    private final RestClient switchAdminClient;
    private final VaultRepository vaultRepository;
    private final CryptogramService cryptogramService;
    private final String isoHost;
    private final int isoPort;
    private final AtomicInteger stan = new AtomicInteger(1);

    public HttpStepExecutor(ProvisioningClient provisioningClient,
                            RestClient provisioningAdminClient,
                            RestClient switchAdminClient,
                            VaultRepository vaultRepository,
                            CryptogramService cryptogramService,
                            String isoHost,
                            int isoPort) {
        this.provisioningClient = provisioningClient;
        this.provisioningAdminClient = provisioningAdminClient;
        this.switchAdminClient = switchAdminClient;
        this.vaultRepository = vaultRepository;
        this.cryptogramService = cryptogramService;
        this.isoHost = isoHost;
        this.isoPort = isoPort;
    }

    @Override
    public Map<String, Object> execute(String action, Map<String, Object> request) {
        return switch (action) {
            case "provision" -> provision(request);
            case "verify-otp" -> verifyOtp(request);
            case "suspend" -> lifecycle(request, "suspend");
            case "resume" -> lifecycle(request, "resume");
            case "delete" -> lifecycle(request, "delete");
            case "get-token" -> lifecycle(request, "get");
            case "card-update" -> cardUpdate(request);
            case "iso-authorize" -> isoAuthorize(request);
            case "set-token-aware" -> setTokenAware(request);
            default -> throw new IllegalArgumentException("unsupported certification action: " + action);
        };
    }

    private Map<String, Object> provision(Map<String, Object> request) {
        ProvisionRequest body = new ProvisionRequest(
                str(request, "fundingPan"),
                str(request, "expiry"),
                str(request, "cardholderName"),
                str(request, "requestorId"),
                str(request, "domainType"),
                str(request, "deviceId"),
                str(request, "idvChannel"));

        ResponseEntity<ProvisionResponse> response =
                provisioningClient.provision(body, str(request, "idempotencyKey"));

        Map<String, Object> actual = new LinkedHashMap<>();
        actual.put("status", response.getStatusCode().value());
        ProvisionResponse payload = response.getBody();
        if (payload != null) {
            actual.put("decision", payload.decision());
            actual.put("tokenStatus", payload.status());
            actual.put("tokenRef", payload.tokenRef());
            actual.put("tokenLast4", payload.tokenLast4());
            actual.put("tokenExpiry", payload.tokenExpiry());
            actual.put("idvSessionId", payload.idvSessionId());
            actual.put("reason", payload.reason());
        }
        actual.put("idempotentReplay", response.getHeaders().containsKey("Idempotent-Replay"));
        return actual;
    }

    private Map<String, Object> verifyOtp(Map<String, Object> request) {
        String tokenRef = str(request, "tokenRef");
        String sessionId = str(request, "idvSessionId");
        String otp = str(request, "otp");
        if (otp == null || otp.isBlank()) {
            // The certification suite is not given the code out of band; it reads what the simulated SMS
            // channel delivered, which is why that endpoint exists in the simulator.
            otp = provisioningClient.peekOtp(sessionId);
        }
        ResponseEntity<ProvisionResponse> response =
                provisioningClient.verifyOtp(tokenRef, new IdvVerifyRequest(sessionId, otp));

        Map<String, Object> actual = new LinkedHashMap<>();
        actual.put("status", response.getStatusCode().value());
        if (response.getBody() != null) {
            actual.put("tokenStatus", response.getBody().status());
            actual.put("decision", response.getBody().decision());
        }
        return actual;
    }

    private Map<String, Object> lifecycle(Map<String, Object> request, String operation) {
        String tokenRef = str(request, "tokenRef");
        ResponseEntity<TokenView> response = switch (operation) {
            case "suspend" -> provisioningClient.suspend(tokenRef);
            case "resume" -> provisioningClient.resume(tokenRef);
            case "delete" -> provisioningClient.delete(tokenRef);
            default -> provisioningClient.get(tokenRef);
        };
        Map<String, Object> actual = new LinkedHashMap<>();
        actual.put("status", response.getStatusCode().value());
        TokenView view = response.getBody();
        if (view != null) {
            actual.put("tokenStatus", view.status());
            actual.put("fundingLast4", view.fundingLast4());
            actual.put("fundingExpiry", view.fundingExpiry());
            actual.put("lastAtc", view.lastAtc());
            actual.put("keyVersion", view.keyVersion());
            actual.put("tokenLast4", view.tokenLast4());
        }
        return actual;
    }

    private Map<String, Object> cardUpdate(Map<String, Object> request) {
        ResponseEntity<CardUpdateResponse> response = provisioningClient.updateCard(
                new CardUpdateRequest(str(request, "oldFundingPan"), str(request, "newFundingPan"),
                        str(request, "newExpiry")));
        Map<String, Object> actual = new LinkedHashMap<>();
        actual.put("status", response.getStatusCode().value());
        if (response.getBody() != null) {
            actual.put("tokensUpdated", response.getBody().tokensUpdated());
        }
        return actual;
    }

    private Map<String, Object> setTokenAware(Map<String, Object> request) {
        String issuerId = str(request, "issuerId");
        boolean enabled = bool(request, "enabled", true);
        ResponseEntity<String> response = provisioningAdminClient.post()
                .uri("/admin/issuers/{id}/token-aware?enabled={enabled}", issuerId, enabled)
                .retrieve()
                .onStatus(HttpStatusCode::isError, (req, res) -> { })
                .toEntity(String.class);
        return Map.of("status", response.getStatusCode().value(), "tokenAware", enabled);
    }

    /** Drives a real 0100 over TCP and reports both the response and the forwarded message shape. */
    private Map<String, Object> isoAuthorize(Map<String, Object> request) {
        String tokenRef = str(request, "tokenRef");
        VaultRecord record = vaultRepository.findByTokenRef(tokenRef)
                .orElseThrow(() -> new IllegalStateException(
                        "no vault record for tokenRef " + tokenRef + "; cannot build an authorization"));

        long amountMinor = num(request, "amountMinor", 4999L);
        int atc = (int) num(request, "atc", 1L);
        String un = str(request, "unpredictableNumber") == null
                ? "A1B2C3D4" : str(request, "unpredictableNumber");
        String requestorId = str(request, "requestorId") == null
                ? record.requestorId() : str(request, "requestorId");
        String domainType = str(request, "domainType") == null
                ? record.domainType().name() : str(request, "domainType");

        String cryptogram = str(request, "cryptogram");
        if (cryptogram == null || cryptogram.isBlank()) {
            cryptogram = cryptogramService.computeHex(record.tokenPan(), atc, un, amountMinor);
        }

        Map<String, Object> actual = new LinkedHashMap<>();
        try (IsoAuthClient client = new IsoAuthClient(isoHost, isoPort, 15_000)) {
            TokenCryptogramTlv tlv = new TokenCryptogramTlv(Hex.decode(cryptogram), atc, Hex.decode(un));
            De48Markers markers = De48Markers.builder()
                    .requestorId(requestorId).domainType(domainType).build();

            ISOMsg response = client.authorize(new AuthMessages.AuthRequest(
                    record.tokenPan(), record.tokenExpiry(), amountMinor,
                    String.valueOf(stan.getAndIncrement()), "840", "CERTTERM", "12345678901",
                    "000000", tlv, markers));

            String de39 = AuthMessages.responseCode(response);
            actual.put("de39", de39);
            actual.put("approved", IsoFields.RC_APPROVED.equals(de39));
            // The 0110 must echo the token, never the funding PAN.
            actual.put("responseDe2IsToken", record.tokenPan().equals(response.getString(IsoFields.DE_PAN)));
        } catch (Exception e) {
            throw new IllegalStateException("ISO 8583 authorization failed: " + e.getMessage(), e);
        }

        appendForwardedShape(actual);
        return actual;
    }

    /** Pulls the switch's record of what it forwarded, so S6.2 becomes an assertion. */
    @SuppressWarnings("unchecked")
    private void appendForwardedShape(Map<String, Object> actual) {
        try {
            Map<String, Object> forwarded = switchAdminClient.get()
                    .uri("/sim/last-forwarded")
                    .retrieve()
                    .onStatus(HttpStatusCode::isError, (req, res) -> { })
                    .body(Map.class);
            if (forwarded == null) {
                return;
            }
            actual.put("forwardedDe2IsToken", forwarded.get("de2IsToken"));
            actual.put("forwardedStripped", forwarded.get("strippedFields"));
            actual.put("issuerTokenAware", forwarded.get("issuerTokenAware"));
            actual.put("forwardedFields", forwarded.get("presentFields"));
        } catch (Exception e) {
            // The switch's recorder is a demo affordance; its absence must not fail a certification step
            // that did not assert on it.
            actual.put("forwardedShapeUnavailable", e.getMessage());
        }
    }

    private static String str(Map<String, Object> request, String key) {
        Object value = request.get(key);
        return value == null ? null : String.valueOf(value);
    }

    private static long num(Map<String, Object> request, String key, long fallback) {
        Object value = request.get(key);
        if (value == null) {
            return fallback;
        }
        if (value instanceof Number n) {
            return n.longValue();
        }
        return Long.parseLong(String.valueOf(value).trim());
    }

    private static boolean bool(Map<String, Object> request, String key, boolean fallback) {
        Object value = request.get(key);
        if (value == null) {
            return fallback;
        }
        if (value instanceof Boolean b) {
            return b;
        }
        return Boolean.parseBoolean(String.valueOf(value));
    }

    @Override
    public String describe() {
        return "HTTP + ISO 8583 against the live stack (iso=" + isoHost + ":" + isoPort + ")";
    }

    /** Supported actions, for documentation and the report header. */
    public static List<String> supportedActions() {
        return List.of("provision", "verify-otp", "suspend", "resume", "delete", "get-token",
                "card-update", "iso-authorize", "set-token-aware");
    }
}
