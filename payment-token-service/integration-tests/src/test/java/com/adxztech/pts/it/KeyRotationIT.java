package com.adxztech.pts.it;

import com.adxztech.pts.common.demo.DemoCards;
import com.adxztech.pts.common.vault.VaultRecord;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Key rotation against live traffic (S7.5).
 *
 * <p>The property that makes rotation operationally boring: a new ACTIVE DEK is introduced, new writes use
 * it, and every existing row keeps decrypting under the {@code key_version} stored on it. No re-encryption
 * sweep has to complete before the vault is readable again -- which is the difference between a rotation you
 * can run on a Tuesday afternoon and one that needs a maintenance window.
 */
class KeyRotationIT extends IntegrationTestBase {

    @Test
    @DisplayName("tokens sealed before and after a rotation both authorize, with no re-encryption")
    @SuppressWarnings("unchecked")
    void rotationDoesNotBreakHistoricalRows() {
        client.setTokenAware("ISSA", false);

        // A token sealed under whatever version is currently active.
        String beforeRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");
        VaultRecord before = client.vault(beforeRef);
        int versionBefore = before.keyVersion();

        assertThat(client.isoAuthorize(beforeRef, 1, 4999).approved()).isTrue();

        // Rotate.
        Map<String, Object> rotation = client.rotateKey();
        int newVersion = ((Number) rotation.get("activeVersion")).intValue();
        assertThat(newVersion).isGreaterThan(versionBefore);

        // A token provisioned after the rotation is sealed under the new version.
        String afterRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");
        assertThat(client.vault(afterRef).keyVersion()).isEqualTo(newVersion);

        // The pre-rotation row is untouched: same version on the row, and it still decrypts.
        assertThat(client.vault(beforeRef).keyVersion()).isEqualTo(versionBefore);
        assertThat(client.isoAuthorize(beforeRef, 2, 4999).approved())
                .withFailMessage("a token sealed under v%d stopped authorizing after rotating to v%d",
                        versionBefore, newVersion)
                .isTrue();

        // And the new one authorizes too.
        assertThat(client.isoAuthorize(afterRef, 1, 4999).approved()).isTrue();

        // The registry reflects the rotation: exactly one ACTIVE, the previous one DECRYPT_ONLY.
        Map<String, Object> keys = client.keys();
        assertThat(((Number) keys.get("activeVersion")).intValue()).isEqualTo(newVersion);
        List<Map<String, Object>> versions = (List<Map<String, Object>>) keys.get("versions");
        assertThat(versions).anySatisfy(v -> {
            assertThat(((Number) v.get("version")).intValue()).isEqualTo(newVersion);
            assertThat(v.get("state")).isEqualTo("ACTIVE");
        });
        assertThat(versions).anySatisfy(v -> {
            assertThat(((Number) v.get("version")).intValue()).isEqualTo(versionBefore);
            assertThat(v.get("state")).isEqualTo("DECRYPT_ONLY");
        });
        assertThat(versions.stream().filter(v -> "ACTIVE".equals(v.get("state"))).count()).isEqualTo(1);
    }

    @Test
    @DisplayName("a card reissue after rotation re-seals the row under the new active key")
    void reissueAdoptsTheActiveKeyVersion() {
        String oldCard = ItCards.nextIssaApprove();
        String newCard = ItCards.nextIssaApprove();
        String tokenRef = client.provisionActiveToken(oldCard, DemoCards.WALLET_REQUESTOR, "ECOM");
        int versionAtProvisioning = client.vault(tokenRef).keyVersion();

        int rotatedTo = ((Number) client.rotateKey().get("activeVersion")).intValue();
        client.updateCard(oldCard, newCard, "3012");

        // Re-sealing during a reissue is a natural, incremental way for rows to migrate forward.
        VaultRecord after = client.vault(tokenRef);
        assertThat(versionAtProvisioning).isLessThan(rotatedTo);
        assertThat(after.keyVersion()).isEqualTo(rotatedTo);
        assertThat(after.fundingLast4()).isEqualTo(newCard.substring(newCard.length() - 4));

        client.setTokenAware("ISSA", false);
        assertThat(client.isoAuthorize(tokenRef, 1, 4999).approved()).isTrue();
    }

    @Test
    @DisplayName("only the wrapped form of a key is ever persisted")
    @SuppressWarnings("unchecked")
    void onlyWrappedKeysArePersisted() {
        Map<String, Object> keys = client.keys();
        assertThat((String) keys.get("keyService")).contains("JCE-DEV");
        List<Map<String, Object>> versions = (List<Map<String, Object>>) keys.get("versions");
        assertThat(versions).isNotEmpty();
        for (Map<String, Object> version : versions) {
            // An AES-256 key is 32 bytes; AESWrap output is 40. Anything 32 bytes long would mean the
            // raw key had been stored.
            assertThat(((Number) version.get("wrappedLength")).intValue()).isNotEqualTo(32);
            assertThat(((Number) version.get("wrappedLength")).intValue()).isGreaterThan(32);
        }
    }
}
