package com.adxztech.pts.it;

import com.adxztech.pts.common.api.CardUpdateRequest;
import com.adxztech.pts.common.api.CardUpdateResponse;
import com.adxztech.pts.common.api.DetokenizeRequest;
import com.adxztech.pts.common.api.DetokenizeResponse;
import com.adxztech.pts.common.api.IdvVerifyRequest;
import com.adxztech.pts.common.api.LifecycleEvent;
import com.adxztech.pts.common.api.ProvisionRequest;
import com.adxztech.pts.common.api.ProvisionResponse;
import com.adxztech.pts.common.api.TokenView;
import com.adxztech.pts.common.client.ProvisioningClient;
import com.adxztech.pts.common.client.RestClients;
import com.adxztech.pts.common.crypto.CryptogramService;
import com.adxztech.pts.common.crypto.JceKeyService;
import com.adxztech.pts.common.iso8583.AuthMessages;
import com.adxztech.pts.common.iso8583.De48Markers;
import com.adxztech.pts.common.iso8583.IsoAuthClient;
import com.adxztech.pts.common.iso8583.IsoFields;
import com.adxztech.pts.common.iso8583.TokenCryptogramTlv;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.sim.LatencyInjector;
import com.adxztech.pts.common.util.Hex;
import com.adxztech.pts.common.vault.VaultRecord;
import org.jpos.iso.ISOMsg;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Test-side client for the running stack.
 *
 * <p>Stands in for the parties that surround a real deployment: a token requestor calling the
 * provisioning API, an acquirer putting an {@code 0100} on the wire, and a network operator reading the
 * vault. It holds the token PANs the API deliberately never returns, which is exactly what a wallet SDK
 * holds -- see {@link com.adxztech.pts.cert.HttpStepExecutor} for the same reasoning.
 */
public final class StackClient {

    private final StackFixture fixture;
    private final ProvisioningClient provisioning;
    private final RestClient provisioningRaw;
    private final RestClient authSwitchRaw;
    private final RestClient notificationRaw;
    private final RestClient issuerSimRaw;
    private final Map<StackFixture.Flavour, RestClient> detokClients;
    private final VaultRepository vaultRepository;
    private final CryptogramService cryptogramService;
    private final AtomicInteger stan = new AtomicInteger(1);

    public StackClient(StackFixture fixture) {
        this.fixture = fixture;
        this.provisioning = new ProvisioningClient(
                RestClients.controlPlane(fixture.provisioningUrl(), null));
        this.provisioningRaw = RestClients.controlPlane(fixture.provisioningUrl(), null);
        this.authSwitchRaw = RestClients.controlPlane(fixture.authSwitchUrl(), null);
        this.notificationRaw = RestClients.controlPlane(fixture.notificationUrl(), null);
        this.issuerSimRaw = RestClients.controlPlane(fixture.issuerSimUrl(), null);

        java.util.Map<StackFixture.Flavour, RestClient> clients = new java.util.LinkedHashMap<>();
        for (StackFixture.Flavour flavour : StackFixture.Flavour.values()) {
            clients.put(flavour, RestClients.controlPlane(fixture.detokUrl(flavour), null));
        }
        this.detokClients = Map.copyOf(clients);

        DriverManagerDataSource dataSource = new DriverManagerDataSource(fixture.jdbcUrl(), "sa", "");
        dataSource.setDriverClassName("org.h2.Driver");
        this.vaultRepository = new VaultRepository(new JdbcTemplate(dataSource),
                LatencyInjector.disabled());
        // Same seed as every service, so cryptograms this client computes are the ones the service
        // recomputes. A mismatch here would make every accept-path test fail for the wrong reason.
        this.cryptogramService = new CryptogramService(new JceKeyService(fixture.sharedHsmSeed()));
    }

    // ------------------------------------------------------------------ provisioning

    public ResponseEntity<ProvisionResponse> provision(ProvisionRequest request) {
        return provisioning.provision(request, null);
    }

    public ResponseEntity<ProvisionResponse> provision(ProvisionRequest request, String idempotencyKey) {
        return provisioning.provision(request, idempotencyKey);
    }

    /** Provisions a green-path token and returns its reference, failing loudly if it did not activate. */
    public String provisionActiveToken(String fundingPan, String requestorId, String domainType) {
        ResponseEntity<ProvisionResponse> response = provision(new ProvisionRequest(
                fundingPan, "2812", "IT TEST", requestorId, domainType,
                "it-device-" + UUID.randomUUID(), "SMS"));
        if (response.getStatusCode().value() != 201 || response.getBody() == null) {
            throw new IllegalStateException("expected an ACTIVE token but got HTTP "
                    + response.getStatusCode() + " body " + response.getBody());
        }
        return response.getBody().tokenRef();
    }

    public ResponseEntity<ProvisionResponse> verifyOtp(String tokenRef, String sessionId, String otp) {
        return provisioning.verifyOtp(tokenRef, new IdvVerifyRequest(sessionId, otp));
    }

    public String peekOtp(String sessionId) {
        return provisioning.peekOtp(sessionId);
    }

    public ResponseEntity<TokenView> suspend(String tokenRef) {
        return provisioning.suspend(tokenRef);
    }

    public ResponseEntity<TokenView> resume(String tokenRef) {
        return provisioning.resume(tokenRef);
    }

    public ResponseEntity<TokenView> delete(String tokenRef) {
        return provisioning.delete(tokenRef);
    }

    public ResponseEntity<TokenView> token(String tokenRef) {
        return provisioning.get(tokenRef);
    }

    public ResponseEntity<CardUpdateResponse> updateCard(String oldPan, String newPan, String newExpiry) {
        return provisioning.updateCard(new CardUpdateRequest(oldPan, newPan, newExpiry));
    }

    // ------------------------------------------------------------------ admin

    @SuppressWarnings("unchecked")
    public Map<String, Object> drainOutbox() {
        return provisioningRaw.post().uri("/admin/outbox/drain").retrieve().body(Map.class);
    }

    /**
     * Drains until the outbox is empty.
     *
     * <p>A single drain publishes one batch, oldest first. By the time an event-focused test runs, earlier
     * tests have left plenty of pending rows, so one batch would not reach this test's events at all. This
     * is not a workaround for a defect: batching is the correct behaviour, and the test simply has to
     * account for it.
     *
     * @return the total number of events published
     */
    public int drainOutboxFully() {
        int total = 0;
        for (int pass = 0; pass < 100; pass++) {
            Map<String, Object> result = drainOutbox();
            int published = ((Number) result.get("published")).intValue();
            total += published;
            if (published == 0) {
                return total;
            }
        }
        throw new IllegalStateException("the outbox is still not empty after 100 drain passes");
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> rotateKey() {
        return provisioningRaw.post().uri("/admin/keys/rotate").retrieve().body(Map.class);
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> keys() {
        return provisioningRaw.get().uri("/admin/keys").retrieve().body(Map.class);
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> reconcileCache() {
        return provisioningRaw.post().uri("/admin/cache/reconcile").retrieve().body(Map.class);
    }

    public void setTokenAware(String issuerId, boolean enabled) {
        provisioningRaw.post()
                .uri("/admin/issuers/{id}/token-aware?enabled={enabled}", issuerId, enabled)
                .retrieve()
                .toBodilessEntity();
    }

    // ------------------------------------------------------------------ detokenization

    public ResponseEntity<DetokenizeResponse> detokenize(StackFixture.Flavour flavour,
                                                         DetokenizeRequest request) {
        return detokClients.get(flavour).post()
                .uri("/v1/detokenize")
                .contentType(MediaType.APPLICATION_JSON)
                .body(request)
                .retrieve()
                .onStatus(HttpStatusCode::isError, (req, res) -> { })
                .toEntity(DetokenizeResponse.class);
    }

    /** Builds a fully valid request for a token: correct cryptogram, matching binding. */
    public DetokenizeRequest validRequest(String tokenRef, int atc, long amountMinor) {
        VaultRecord record = vault(tokenRef);
        String un = "A1B2C3D4";
        return new DetokenizeRequest(record.tokenPan(),
                cryptogramService.computeHex(record.tokenPan(), atc, un, amountMinor),
                atc, un, amountMinor, record.requestorId(), record.domainType().name());
    }

    @SuppressWarnings("unchecked")
    public Map<String, String> detokConfig(StackFixture.Flavour flavour) {
        return detokClients.get(flavour).get().uri("/v1/detokenize/config")
                .retrieve().body(Map.class);
    }

    // ------------------------------------------------------------------ ISO 8583

    /** Result of an authorization driven over the real TCP socket. */
    public record IsoResult(String responseCode, boolean approved, String de2, String authCode) {
    }

    public IsoResult isoAuthorize(String tokenRef, int atc, long amountMinor) {
        return isoAuthorize(tokenRef, atc, amountMinor, null, null, null);
    }

    /**
     * @param cryptogramOverride pass a wrong value to exercise cryptogram rejection
     * @param requestorOverride  pass another requestor to exercise domain restriction
     */
    public IsoResult isoAuthorize(String tokenRef, int atc, long amountMinor,
                                  String cryptogramOverride, String requestorOverride,
                                  String domainOverride) {
        VaultRecord record = vault(tokenRef);
        String un = "A1B2C3D4";
        String cryptogram = cryptogramOverride != null ? cryptogramOverride
                : cryptogramService.computeHex(record.tokenPan(), atc, un, amountMinor);
        String requestorId = requestorOverride != null ? requestorOverride : record.requestorId();
        String domainType = domainOverride != null ? domainOverride : record.domainType().name();

        try (IsoAuthClient client = new IsoAuthClient("127.0.0.1", fixture.isoPort(), 15_000)) {
            ISOMsg response = client.authorize(new AuthMessages.AuthRequest(
                    record.tokenPan(), record.tokenExpiry(), amountMinor,
                    String.valueOf(stan.getAndIncrement()), "840", "ITTERM01", "12345678901",
                    "000000",
                    new TokenCryptogramTlv(Hex.decode(cryptogram), atc, Hex.decode(un)),
                    De48Markers.builder().requestorId(requestorId).domainType(domainType).build()));
            String code = AuthMessages.responseCode(response);
            return new IsoResult(code, IsoFields.RC_APPROVED.equals(code),
                    response.getString(IsoFields.DE_PAN), response.getString(38));
        } catch (Exception e) {
            throw new IllegalStateException("ISO authorization failed", e);
        }
    }

    /**
     * Sends an {@code 0100} with DE 48 absent.
     *
     * <p>Without the requestor and domain markers the switch cannot evaluate the domain restriction, and
     * it must refuse rather than authorize with the check silently skipped.
     */
    public IsoResult isoAuthorizeWithoutMarkers(String tokenRef, int atc, long amountMinor) {
        VaultRecord record = vault(tokenRef);
        String un = "A1B2C3D4";
        String cryptogram = cryptogramService.computeHex(record.tokenPan(), atc, un, amountMinor);
        try (IsoAuthClient client = new IsoAuthClient("127.0.0.1", fixture.isoPort(), 15_000)) {
            ISOMsg response = client.authorize(new AuthMessages.AuthRequest(
                    record.tokenPan(), record.tokenExpiry(), amountMinor,
                    String.valueOf(stan.getAndIncrement()), "840", "ITTERM01", "12345678901",
                    "000000",
                    new TokenCryptogramTlv(Hex.decode(cryptogram), atc, Hex.decode(un)),
                    null));
            String code = AuthMessages.responseCode(response);
            return new IsoResult(code, IsoFields.RC_APPROVED.equals(code),
                    response.getString(IsoFields.DE_PAN), response.getString(38));
        } catch (Exception e) {
            throw new IllegalStateException("ISO authorization failed", e);
        }
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> lastForwarded() {
        return authSwitchRaw.get().uri("/sim/last-forwarded")
                .retrieve()
                .onStatus(HttpStatusCode::isError, (req, res) -> { })
                .body(Map.class);
    }

    // ------------------------------------------------------------------ issuer / notifications

    @SuppressWarnings("unchecked")
    public Map<String, Object> lastIssuerAuthorization() {
        return issuerSimRaw.get().uri("/sim/last-authorization")
                .retrieve()
                .onStatus(HttpStatusCode::isError, (req, res) -> { })
                .body(Map.class);
    }

    public List<LifecycleEvent> notificationsFor(String tokenRef) {
        LifecycleEvent[] events = notificationRaw.get()
                .uri("/sim/notifications/{ref}", tokenRef)
                .retrieve()
                .body(LifecycleEvent[].class);
        return events == null ? List.of() : List.of(events);
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> notificationCounters() {
        return notificationRaw.get().uri("/sim/counters").retrieve().body(Map.class);
    }

    // ------------------------------------------------------------------ vault access

    public VaultRecord vault(String tokenRef) {
        return vaultRepository.findByTokenRef(tokenRef)
                .orElseThrow(() -> new IllegalStateException("no vault row for tokenRef " + tokenRef));
    }

    public VaultRepository vaultRepository() {
        return vaultRepository;
    }

    public CryptogramService cryptogramService() {
        return cryptogramService;
    }
}
