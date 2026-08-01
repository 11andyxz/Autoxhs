package com.adxztech.pts.common.vault;

import com.adxztech.pts.common.demo.DemoCards;
import com.adxztech.pts.common.token.DomainType;
import com.adxztech.pts.common.token.TokenStatus;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

class VaultRecordTest {

    private static final Instant NOW = Instant.parse("2026-01-15T10:32:00Z");

    private VaultRecord record(TokenStatus status, String requestorId, DomainType domain) {
        return new VaultRecord("4999600000004822", "ref-1", 49996000L,
                new byte[]{1, 2, 3}, new byte[]{4, 5, 6}, "0725", "2812", "3112",
                status, requestorId, domain, "ISSA", "device-1", 40, 1, NOW, NOW);
    }

    @Test
    @DisplayName("only an ACTIVE token may authorize")
    void authorizationGate() {
        assertThat(record(TokenStatus.ACTIVE, "R1", DomainType.ECOM).canAuthorize()).isTrue();
        assertThat(record(TokenStatus.SUSPENDED, "R1", DomainType.ECOM).canAuthorize()).isFalse();
        assertThat(record(TokenStatus.PENDING_IDV, "R1", DomainType.ECOM).canAuthorize()).isFalse();
        assertThat(record(TokenStatus.DELETED, "R1", DomainType.ECOM).canAuthorize()).isFalse();
    }

    @Test
    @DisplayName("domain restriction requires both the requestor and the usage domain to match")
    void domainRestriction() {
        VaultRecord r = record(TokenStatus.ACTIVE, DemoCards.WALLET_REQUESTOR, DomainType.ECOM);
        assertThat(r.matchesBinding(DemoCards.WALLET_REQUESTOR, DomainType.ECOM)).isTrue();
        assertThat(r.matchesBinding(DemoCards.OTHER_REQUESTOR, DomainType.ECOM)).isFalse();
        assertThat(r.matchesBinding(DemoCards.WALLET_REQUESTOR, DomainType.CONTACTLESS)).isFalse();
    }

    @Test
    @DisplayName("a card reissue keeps the token PAN and replaces only the funding data")
    void reissueKeepsToken() {
        VaultRecord before = record(TokenStatus.ACTIVE, "R1", DomainType.ECOM);
        VaultRecord after = before.withFunding(new byte[]{9}, new byte[]{8}, "2325", "3012", 2,
                NOW.plusSeconds(60));

        assertThat(after.tokenPan()).isEqualTo(before.tokenPan());
        assertThat(after.tokenRef()).isEqualTo(before.tokenRef());
        assertThat(after.tokenExpiry()).isEqualTo(before.tokenExpiry());
        assertThat(after.status()).isEqualTo(before.status());
        assertThat(after.fundingLast4()).isEqualTo("2325");
        assertThat(after.fundingExpiry()).isEqualTo("3012");
        assertThat(after.keyVersion()).isEqualTo(2);
        assertThat(after.updatedAt()).isAfter(before.updatedAt());
    }

    @Test
    @DisplayName("status and ATC transitions leave everything else alone")
    void narrowMutations() {
        VaultRecord active = record(TokenStatus.ACTIVE, "R1", DomainType.ECOM);
        VaultRecord suspended = active.withStatus(TokenStatus.SUSPENDED, NOW.plusSeconds(1));
        assertThat(suspended.status()).isEqualTo(TokenStatus.SUSPENDED);
        assertThat(suspended.fundingPanEnc()).isEqualTo(active.fundingPanEnc());
        assertThat(active.withLastAtc(99).lastAtc()).isEqualTo(99);
    }

    @Test
    @DisplayName("toString reveals no token PAN and no ciphertext")
    void toStringIsSafe() {
        String rendered = record(TokenStatus.ACTIVE, "R1", DomainType.ECOM).toString();
        assertThat(rendered).doesNotContain("4999600000004822");
        assertThat(rendered).contains("4822").contains("ACTIVE").contains("ISSA");
    }

    @Test
    @DisplayName("survives Java serialization, which is how Hazelcast replicates it")
    void isSerializable() throws Exception {
        VaultRecord original = record(TokenStatus.ACTIVE, "R1", DomainType.CONTACTLESS);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ObjectOutputStream out = new ObjectOutputStream(bytes)) {
            out.writeObject(original);
        }
        VaultRecord restored;
        try (ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(bytes.toByteArray()))) {
            restored = (VaultRecord) in.readObject();
        }
        assertThat(restored.tokenPan()).isEqualTo(original.tokenPan());
        assertThat(restored.status()).isEqualTo(original.status());
        assertThat(restored.domainType()).isEqualTo(original.domainType());
        assertThat(restored.fundingPanEnc()).isEqualTo(original.fundingPanEnc());
        assertThat(restored.createdAt()).isEqualTo(original.createdAt());
    }

    @Test
    @DisplayName("exposes the token last4, which is the only token detail an API may show")
    void tokenLast4() {
        assertThat(record(TokenStatus.ACTIVE, "R1", DomainType.ECOM).tokenLast4()).isEqualTo("4822");
    }
}
