package com.adxztech.pts.it;

import com.adxztech.pts.common.cache.HazelcastVaultCache;
import com.adxztech.pts.common.cluster.VaultClusterConfig;
import com.adxztech.pts.common.demo.DemoCards;
import com.adxztech.pts.common.token.TokenStatus;
import com.adxztech.pts.common.vault.VaultRecord;
import com.hazelcast.client.HazelcastClient;
import com.hazelcast.core.HazelcastInstance;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The proof that caching does not weaken the security-relevant state (S8.4, S16).
 *
 * <p>This is the direct answer to the obvious objection: "doesn't caching risk authorizing a token that
 * was just suspended for fraud?" The scripted sequence -- authorize, suspend, authorize again -- has to
 * reject on the very next request, not at the end of a 300-second TTL. Write-through plus cluster-wide
 * near-cache invalidation is what makes that true, and this test is what makes it a fact rather than an
 * assurance.
 *
 * <p>It then goes further and tests the failure mode honestly: {@link #reconciliationRepairsDivergence()}
 * <em>manufactures</em> the divergence a crash between commit and cache-push would cause, shows that a
 * stale cache really does authorize a suspended token, and shows the reconciliation sweep catching it. A
 * mitigation nobody has watched work is not a mitigation.
 */
class CacheSafetyIT extends IntegrationTestBase {

    private static HazelcastInstance directClient;

    /** A cache handle with no near-cache, so writes from the test are seen by the cluster immediately. */
    private static synchronized HazelcastVaultCache directCache() {
        if (directClient == null) {
            VaultClusterConfig.ClientSettings settings = new VaultClusterConfig.ClientSettings(
                    "pts-cluster", java.util.List.of("127.0.0.1:" + fixture.hazelcastPort()),
                    false, 0, 0, 15_000);
            directClient = HazelcastClient.newHazelcastClient(VaultClusterConfig.client(settings));
        }
        return new HazelcastVaultCache(directClient);
    }

    @AfterAll
    static void closeDirectClient() {
        if (directClient != null) {
            directClient.shutdown();
            directClient = null;
        }
    }

    @ParameterizedTest
    @EnumSource(value = StackFixture.Flavour.class, names = {"CACHE_ONLY", "OPTIMIZED"})
    @DisplayName("suspending a token stops authorization on the very next request, not after the TTL")
    void suspendIsVisibleImmediately(StackFixture.Flavour flavour) {
        String tokenRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");

        // 1. warm the cache under load-like traffic: several authorizations succeed
        for (int atc = 1; atc <= 5; atc++) {
            assertThat(client.detokenize(flavour, client.validRequest(tokenRef, atc, 4999))
                    .getBody().isProceed()).isTrue();
        }

        // 2. the issuer suspends the token
        assertThat(client.suspend(tokenRef).getStatusCode().value()).isEqualTo(200);

        // 3. the very next authorization is rejected -- no sleep, no TTL expiry, no retry loop
        var rejected = client.detokenize(flavour, client.validRequest(tokenRef, 6, 4999));
        assertThat(rejected.getStatusCode().value()).isEqualTo(422);
        assertThat(rejected.getBody()).isNotNull();
        assertThat(rejected.getBody().reason()).isEqualTo("TOKEN_NOT_ACTIVE");

        // 4. resume restores service just as promptly
        assertThat(client.resume(tokenRef).getStatusCode().value()).isEqualTo(200);
        assertThat(client.detokenize(flavour, client.validRequest(tokenRef, 7, 4999))
                .getBody().isProceed()).isTrue();
    }

    @Test
    @DisplayName("a cold cache serves correctly and read-through populates it from the vault")
    void coldCacheIsCorrect() {
        // Provisioned with write-through, then evicted to simulate a fresh deployment or a failover to a
        // member that never held this entry. Correctness must not depend on the cache being warm.
        String tokenRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");
        VaultRecord record = client.vault(tokenRef);

        directCache().invalidate(record.tokenPan());
        assertThat(directCache().get(record.tokenPan())).isPresent(); // read-through MapLoader

        assertThat(client.detokenize(StackFixture.Flavour.OPTIMIZED,
                client.validRequest(tokenRef, 1, 4999)).getBody().isProceed()).isTrue();
    }

    @Test
    @DisplayName("manufactured cache/vault divergence is detected and repaired by the reconciliation sweep")
    void reconciliationRepairsDivergence() {
        String tokenRef = client.provisionActiveToken(
                ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");
        VaultRecord active = client.vault(tokenRef);

        // Suspend through the API: vault and cache now agree that the token is SUSPENDED.
        client.suspend(tokenRef);
        assertThat(client.detokenize(StackFixture.Flavour.OPTIMIZED,
                client.validRequest(tokenRef, 1, 4999)).getStatusCode().value()).isEqualTo(422);

        // Now force the divergence a crash between the database commit and the cache push would leave:
        // an ACTIVE copy in the cache for a token the vault says is SUSPENDED.
        directCache().put(active.withStatus(TokenStatus.ACTIVE, Instant.now()));

        // The risk is real: the stale cache authorizes a suspended token. This is the failure mode the
        // sweep exists for, demonstrated rather than asserted away.
        assertThat(client.detokenize(StackFixture.Flavour.OPTIMIZED,
                client.validRequest(tokenRef, 2, 4999)).getBody().isProceed())
                .withFailMessage("expected the manufactured stale entry to be served")
                .isTrue();

        // The sweep compares cache against vault, repairs the entry and reports the drift.
        Map<String, Object> reconciled = client.reconcileCache();
        assertThat(((Number) reconciled.get("repaired")).intValue()).isGreaterThanOrEqualTo(1);

        // ...and the authorization path is correct again.
        var afterRepair = client.detokenize(StackFixture.Flavour.OPTIMIZED,
                client.validRequest(tokenRef, 3, 4999));
        assertThat(afterRepair.getStatusCode().value()).isEqualTo(422);
        assertThat(afterRepair.getBody().reason()).isEqualTo("TOKEN_NOT_ACTIVE");
    }

    @Test
    @DisplayName("a healthy stack reports no drift, so a non-zero count is a real signal")
    void healthyStackHasNoDrift() {
        client.provisionActiveToken(ItCards.nextIssaApprove(), DemoCards.WALLET_REQUESTOR, "ECOM");
        // Repair anything a previous test manufactured, then confirm a clean sweep finds nothing.
        client.reconcileCache();
        Map<String, Object> reconciled = client.reconcileCache();
        assertThat(((Number) reconciled.get("repaired")).intValue()).isZero();
    }
}
