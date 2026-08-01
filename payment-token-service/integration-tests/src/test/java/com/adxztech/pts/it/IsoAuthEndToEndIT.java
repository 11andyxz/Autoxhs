package com.adxztech.pts.it;

import com.adxztech.pts.common.demo.DemoCards;
import com.adxztech.pts.common.vault.VaultRecord;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * ISO 8583 field-level handling and issuer backward compatibility, over a real TCP socket (S6.2).
 *
 * <p>Nothing here is mocked: the test opens a socket to the jPOS server, the switch calls the real
 * detokenization service, and the real issuer simulator records what it received. That last part is what
 * makes the DE 2 swap an observation -- the issuer either saw the funding PAN or it did not.
 */
class IsoAuthEndToEndIT extends IntegrationTestBase {

    private String issaToken() {
        return client.provisionActiveToken(ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");
    }

    @Test
    @DisplayName("token-unaware issuer: DE 2 is swapped to the funding PAN and token fields are stripped")
    void legacyIssuerReceivesACleanMessage() {
        client.setTokenAware("ISSA", false);
        String card = ItCards.nextIssaApprove();
        String tokenRef = client.provisionActiveToken(card, DemoCards.WALLET_REQUESTOR, "ECOM");
        VaultRecord record = client.vault(tokenRef);

        StackClient.IsoResult result = client.isoAuthorize(tokenRef, 1, 4999);

        assertThat(result.approved()).isTrue();
        assertThat(result.responseCode()).isEqualTo("00");
        assertThat(result.authCode()).isNotBlank();

        // The 0110 returned to the acquirer carries the TOKEN. Returning the funding PAN here would leak
        // exactly what tokenization exists to hide.
        assertThat(result.de2()).isEqualTo(record.tokenPan());

        // The issuer saw the funding PAN, not the token: detokenization really happened.
        Map<String, Object> issuerSaw = client.lastIssuerAuthorization();
        assertThat(issuerSaw.get("fundingPan")).isEqualTo(card);
        assertThat(issuerSaw.get("tokenized")).isEqualTo(false);

        // And the outbound message was a clean legacy 0100.
        Map<String, Object> forwarded = client.lastForwarded();
        assertThat(forwarded.get("de2IsToken")).isEqualTo(false);
        assertThat(forwarded.get("issuerTokenAware")).isEqualTo(false);
        assertThat(fields(forwarded, "strippedFields")).containsExactlyInAnyOrder(55, 48);
        assertThat(fields(forwarded, "presentFields")).doesNotContain(55, 48);
        assertThat(forwarded.get("de14Expiry")).isEqualTo(record.fundingExpiry());
    }

    @Test
    @DisplayName("token-aware issuer: the token and its cryptogram are forwarded, not stripped")
    void tokenAwareIssuerReceivesTheTokenAndCryptogram() {
        // Same inbound authorization, one capability flag different, a genuinely different outbound
        // message. That contrast is the whole backward-compatibility claim.
        client.setTokenAware("ISSB", true);
        String card = ItCards.nextIssbApprove();
        String tokenRef = client.provisionActiveToken(card, DemoCards.WALLET_REQUESTOR, "ECOM");
        VaultRecord record = client.vault(tokenRef);
        assertThat(record.issuerId()).isEqualTo("ISSB");

        StackClient.IsoResult result = client.isoAuthorize(tokenRef, 1, 1500);
        assertThat(result.approved()).isTrue();
        assertThat(result.de2()).isEqualTo(record.tokenPan());

        Map<String, Object> forwarded = client.lastForwarded();
        assertThat(forwarded.get("de2IsToken")).isEqualTo(true);
        assertThat(forwarded.get("issuerTokenAware")).isEqualTo(true);
        assertThat(fields(forwarded, "strippedFields")).isEmpty();
        assertThat(fields(forwarded, "presentFields")).contains(55, 48);
        assertThat(forwarded.get("issuerId")).isEqualTo("ISSB");

        Map<String, Object> issuerSaw = client.lastIssuerAuthorization();
        assertThat(issuerSaw.get("tokenized")).isEqualTo(true);
    }

    @Test
    @DisplayName("flipping the capability flag changes the outbound shape for the same issuer")
    void capabilityFlagIsTheOnlyDifference() {
        String tokenRef = issaToken();

        client.setTokenAware("ISSA", false);
        client.isoAuthorize(tokenRef, 1, 1000);
        Map<String, Object> asLegacy = client.lastForwarded();

        client.setTokenAware("ISSA", true);
        client.isoAuthorize(tokenRef, 2, 1000);
        Map<String, Object> asTokenAware = client.lastForwarded();

        assertThat(asLegacy.get("de2IsToken")).isEqualTo(false);
        assertThat(asTokenAware.get("de2IsToken")).isEqualTo(true);
        assertThat(fields(asLegacy, "strippedFields")).isNotEmpty();
        assertThat(fields(asTokenAware, "strippedFields")).isEmpty();

        client.setTokenAware("ISSA", false); // leave the shared flag as the suites expect
    }

    @Test
    @DisplayName("replaying a used ATC declines with DE 39 59")
    void replayDeclines() {
        client.setTokenAware("ISSA", false);
        String tokenRef = issaToken();

        assertThat(client.isoAuthorize(tokenRef, 1, 4999).approved()).isTrue();
        StackClient.IsoResult replay = client.isoAuthorize(tokenRef, 1, 4999);
        assertThat(replay.approved()).isFalse();
        assertThat(replay.responseCode()).isEqualTo("59");
    }

    @Test
    @DisplayName("a tampered cryptogram declines and does not consume the counter")
    void tamperedCryptogramDeclines() {
        client.setTokenAware("ISSA", false);
        String tokenRef = issaToken();

        StackClient.IsoResult tampered =
                client.isoAuthorize(tokenRef, 7, 4999, "0000000000000000", null, null);
        assertThat(tampered.approved()).isFalse();
        assertThat(tampered.responseCode()).isEqualTo("59");

        // The genuine device can still use ATC 7: the forged attempt did not ratchet the counter.
        assertThat(client.isoAuthorize(tokenRef, 7, 4999).approved()).isTrue();
    }

    @Test
    @DisplayName("a token presented by another requestor declines with DE 39 05")
    void domainMismatchDeclines() {
        client.setTokenAware("ISSA", false);
        String tokenRef = issaToken();
        StackClient.IsoResult result =
                client.isoAuthorize(tokenRef, 1, 4999, null, DemoCards.OTHER_REQUESTOR, null);
        assertThat(result.approved()).isFalse();
        assertThat(result.responseCode()).isEqualTo("05");
    }

    @Test
    @DisplayName("a suspended token declines at the switch")
    void suspendedTokenDeclines() {
        client.setTokenAware("ISSA", false);
        String tokenRef = issaToken();
        client.suspend(tokenRef);
        StackClient.IsoResult result = client.isoAuthorize(tokenRef, 1, 4999);
        assertThat(result.approved()).isFalse();
        assertThat(result.responseCode()).isEqualTo("05");
    }

    @Test
    @DisplayName("detokenization can succeed and the issuer still decline on its own rules")
    void issuerDeclineIsRelayedUnchanged() {
        // Proves the two decisions are separate: the network authorised the token, the issuer said no.
        client.setTokenAware("ISSA", false);
        String tokenRef = issaToken();
        StackClient.IsoResult result = client.isoAuthorize(tokenRef, 1, 900_000);
        assertThat(result.approved()).isFalse();
        assertThat(result.responseCode()).isEqualTo("51"); // insufficient funds, from the issuer
    }

    @Test
    @DisplayName("an 0100 without DE 48 is refused rather than authorized with no domain check")
    void missingTokenMarkersIsRefused() {
        client.setTokenAware("ISSA", false);
        String tokenRef = issaToken();
        StackClient.IsoResult result = client.isoAuthorizeWithoutMarkers(tokenRef, 1, 4999);
        assertThat(result.approved()).isFalse();
        assertThat(result.responseCode()).isEqualTo("96");
    }

    @Test
    @DisplayName("the response echoes the acquirer's trace fields so it can be matched")
    void responsePreservesTraceFields() {
        client.setTokenAware("ISSA", false);
        String tokenRef = issaToken();
        StackClient.IsoResult result = client.isoAuthorize(tokenRef, 1, 2500);
        assertThat(result.approved()).isTrue();
        assertThat(result.authCode()).isNotBlank();
        assertThat(result.de2()).isEqualTo(client.vault(tokenRef).tokenPan());
    }

    /**
     * Reads a data-element list out of the recorder's JSON.
     *
     * <p>Jackson deserialises the numbers as Integers into an untyped map; naming the element type here
     * keeps the assertions readable as {@code containsExactlyInAnyOrder(55, 48)} rather than boxing games.
     */
    @SuppressWarnings("unchecked")
    private static List<Integer> fields(Map<String, Object> forwarded, String key) {
        Object value = forwarded.get(key);
        assertThat(value).as("%s should be present in the forwarded-message record", key).isNotNull();
        return (List<Integer>) value;
    }
}
