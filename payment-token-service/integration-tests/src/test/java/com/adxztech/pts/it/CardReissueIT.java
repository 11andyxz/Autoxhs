package com.adxztech.pts.it;

import com.adxztech.pts.common.api.CardUpdateResponse;
import com.adxztech.pts.common.demo.DemoCards;
import com.adxztech.pts.common.vault.VaultRecord;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The card reissue flow (S5.5) -- the one that removes a class of avoidable declines.
 *
 * <p>The beat being verified: authorize with token T; the issuer reissues the underlying card with a new
 * PAN and expiry; authorize with the <em>same</em> token T and it still works, now against the new card.
 * The merchant changed nothing and never learns that anything happened.
 */
class CardReissueIT extends IntegrationTestBase {

    @Test
    @DisplayName("the same token authorizes against the new funding card after a reissue")
    void tokenSurvivesAReissue() {
        client.setTokenAware("ISSA", false);
        String oldCard = ItCards.nextIssaApprove();
        String newCard = ItCards.nextIssaApprove();

        String tokenRef = client.provisionActiveToken(oldCard, DemoCards.WALLET_REQUESTOR, "ECOM");
        String tokenPanBefore = client.vault(tokenRef).tokenPan();

        // 1. the token authorizes against the original card
        assertThat(client.isoAuthorize(tokenRef, 1, 4999).approved()).isTrue();
        assertThat(client.lastIssuerAuthorization().get("fundingPan")).isEqualTo(oldCard);

        // 2. the issuer reissues the card
        ResponseEntity<CardUpdateResponse> update =
                client.updateCard(oldCard, newCard, DemoCards.REISSUED_EXPIRY);
        assertThat(update.getStatusCode().value()).isEqualTo(200);
        assertThat(update.getBody()).isNotNull();
        assertThat(update.getBody().tokensUpdated()).isEqualTo(1);
        assertThat(update.getBody().tokenRefs()).containsExactly(tokenRef);

        // 3. the token is unchanged; only what it resolves to has moved
        VaultRecord after = client.vault(tokenRef);
        assertThat(after.tokenPan()).isEqualTo(tokenPanBefore);
        assertThat(after.tokenRef()).isEqualTo(tokenRef);
        assertThat(after.fundingLast4()).isEqualTo(newCard.substring(newCard.length() - 4));
        assertThat(after.fundingExpiry()).isEqualTo(DemoCards.REISSUED_EXPIRY);
        assertThat(after.status().name()).isEqualTo("ACTIVE");

        // 4. the same token authorizes again, now against the new card
        assertThat(client.isoAuthorize(tokenRef, 2, 4999).approved()).isTrue();
        Map<String, Object> issuerSaw = client.lastIssuerAuthorization();
        assertThat(issuerSaw.get("fundingPan")).isEqualTo(newCard);
        assertThat(issuerSaw.get("fundingExpiry")).isEqualTo(DemoCards.REISSUED_EXPIRY);
    }

    @Test
    @DisplayName("every token on a reissued card is re-pointed, including across token BIN blocks")
    void allTokensForTheCardAreUpdated() {
        String oldCard = ItCards.nextIssaApprove();
        String newCard = ItCards.nextIssaApprove();

        // Three tokens for one card: a wallet, a merchant card-on-file, and a contactless binding.
        String walletToken = client.provisionActiveToken(oldCard, DemoCards.WALLET_REQUESTOR, "ECOM");
        String merchantToken =
                client.provisionActiveToken(oldCard, DemoCards.TRUSTED_MERCHANT_REQUESTOR, "ECOM");
        String contactlessToken =
                client.provisionActiveToken(oldCard, DemoCards.WALLET_REQUESTOR, "CONTACTLESS");

        ResponseEntity<CardUpdateResponse> update = client.updateCard(oldCard, newCard, "3012");
        assertThat(update.getBody()).isNotNull();
        assertThat(update.getBody().tokensUpdated()).isEqualTo(3);
        assertThat(update.getBody().tokenRefs())
                .containsExactlyInAnyOrder(walletToken, merchantToken, contactlessToken);

        for (String ref : new String[]{walletToken, merchantToken, contactlessToken}) {
            assertThat(client.vault(ref).fundingLast4())
                    .isEqualTo(newCard.substring(newCard.length() - 4));
        }
    }

    @Test
    @DisplayName("a tombstoned token is left out of a reissue")
    void deletedTokensAreNotRepointed() {
        String oldCard = ItCards.nextIssaApprove();
        String newCard = ItCards.nextIssaApprove();

        String liveToken = client.provisionActiveToken(oldCard, DemoCards.WALLET_REQUESTOR, "ECOM");
        String deletedToken =
                client.provisionActiveToken(oldCard, DemoCards.TRUSTED_MERCHANT_REQUESTOR, "ECOM");
        client.delete(deletedToken);

        ResponseEntity<CardUpdateResponse> update = client.updateCard(oldCard, newCard, "3012");
        assertThat(update.getBody()).isNotNull();
        assertThat(update.getBody().tokensUpdated()).isEqualTo(1);
        assertThat(update.getBody().tokenRefs()).containsExactly(liveToken);
    }

    @Test
    @DisplayName("reissuing a card that was never tokenized succeeds with zero tokens updated")
    void untokenizedCardIsNotAnError() {
        // An issuer reissues cards regardless of whether they have tokens. Answering 200 with zero is the
        // truthful response and keeps the operation safely repeatable.
        ResponseEntity<CardUpdateResponse> update = client.updateCard(
                ItCards.nextIssaApprove(), ItCards.nextIssaApprove(), "3012");
        assertThat(update.getStatusCode().value()).isEqualTo(200);
        assertThat(update.getBody()).isNotNull();
        assertThat(update.getBody().tokensUpdated()).isZero();
    }

    @Test
    @DisplayName("a reissue is rejected if the new card is invalid or already expired")
    void reissueValidatesItsInput() {
        String card = ItCards.nextIssaApprove();
        String tokenRef = client.provisionActiveToken(card, DemoCards.WALLET_REQUESTOR, "ECOM");
        String originalLast4 = card.substring(card.length() - 4);

        // Fails Luhn.
        assertThat(client.updateCard(card, "4111100000003126", "3012").getStatusCode().value())
                .isEqualTo(400);
        // Already expired.
        assertThat(client.updateCard(card, ItCards.nextIssaApprove(), "2001")
                .getStatusCode().value()).isEqualTo(400);

        // A rejected reissue must leave the token pointing at the original card, not half-migrated.
        VaultRecord unchanged = client.vault(tokenRef);
        assertThat(unchanged.fundingLast4()).isEqualTo(originalLast4);
        assertThat(unchanged.fundingExpiry()).isEqualTo("2812");
    }
}
