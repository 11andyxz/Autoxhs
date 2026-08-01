package com.adxztech.pts.common.persistence;

import com.adxztech.pts.common.sim.LatencyInjector;
import com.adxztech.pts.common.token.DomainType;
import com.adxztech.pts.common.token.TokenStatus;
import com.adxztech.pts.common.vault.VaultRecord;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class VaultRepositoryTest {

    private EmbeddedDatabase db;
    private JdbcTemplate jdbc;
    private VaultRepository repository;

    @BeforeEach
    void setUp() {
        db = TestDb.create();
        jdbc = TestDb.template(db);
        repository = new VaultRepository(jdbc, LatencyInjector.disabled());
    }

    @AfterEach
    void tearDown() {
        db.shutdown();
    }

    private static final byte[] FINGERPRINT_A = "fingerprint-card-a-32-bytes-here".getBytes();
    private static final byte[] FINGERPRINT_B = "fingerprint-card-b-32-bytes-here".getBytes();

    private VaultRecord record(String tokenPan, long bin, String tokenRef, TokenStatus status,
                               byte[] fingerprint) {
        Instant now = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        return new VaultRecord(tokenPan, tokenRef, bin,
                new byte[]{10, 20, 30}, fingerprint, "0725", "2812", "3112",
                status, "40010030001", DomainType.ECOM, "ISSA", "device-1", 0, 1, now, now);
    }

    @Test
    @DisplayName("a vault record survives insert and read with every field intact")
    void insertAndRead() {
        VaultRecord original = record("4999600000004822", 49996000L, "ref-1", TokenStatus.ACTIVE,
                FINGERPRINT_A);
        repository.insert(original);

        VaultRecord loaded = repository.findByTokenPan("4999600000004822").orElseThrow();
        assertThat(loaded.tokenRef()).isEqualTo("ref-1");
        assertThat(loaded.tokenBin()).isEqualTo(49996000L);
        assertThat(loaded.fundingPanEnc()).isEqualTo(original.fundingPanEnc());
        assertThat(loaded.fundingPanFingerprint()).isEqualTo(FINGERPRINT_A);
        assertThat(loaded.status()).isEqualTo(TokenStatus.ACTIVE);
        assertThat(loaded.domainType()).isEqualTo(DomainType.ECOM);
        assertThat(loaded.issuerId()).isEqualTo("ISSA");
        assertThat(loaded.deviceId()).isEqualTo("device-1");
        assertThat(loaded.keyVersion()).isEqualTo(1);
        assertThat(loaded.createdAt()).isNotNull();
    }

    @Test
    @DisplayName("lookup by tokenRef finds the same row as lookup by token PAN")
    void lookupByRef() {
        repository.insert(record("4999600000004822", 49996000L, "ref-1", TokenStatus.ACTIVE, FINGERPRINT_A));
        assertThat(repository.findByTokenRef("ref-1").orElseThrow().tokenPan())
                .isEqualTo("4999600000004822");
        assertThat(repository.findByTokenRef("nope")).isEmpty();
        assertThat(repository.findByTokenPan("4999609999999999")).isEmpty();
    }

    @Test
    @DisplayName("the token PAN is unique -- the primary key is what makes allocation retry-safe")
    void tokenPanIsUnique() {
        repository.insert(record("4999600000004822", 49996000L, "ref-1", TokenStatus.ACTIVE, FINGERPRINT_A));
        assertThatThrownBy(() -> repository.insert(
                record("4999600000004822", 49996000L, "ref-2", TokenStatus.ACTIVE, FINGERPRINT_A)))
                .isInstanceOf(DuplicateKeyException.class);
    }

    @Test
    @DisplayName("fingerprint lookup finds every live token for a card and skips tombstones")
    void fingerprintLookupSpansTokensAndSkipsDeleted() {
        // The reissue query (S5.5). Two tokens on card A in different BIN blocks -- in Oracle these
        // are different partitions, which is exactly why that index has to be global.
        repository.insert(record("4999600000004822", 49996000L, "ref-1", TokenStatus.ACTIVE, FINGERPRINT_A));
        repository.insert(record("4999610000004820", 49996100L, "ref-2", TokenStatus.ACTIVE, FINGERPRINT_A));
        repository.insert(record("4999620000004828", 49996200L, "ref-3", TokenStatus.DELETED, FINGERPRINT_A));
        repository.insert(record("4999600000001117", 49996000L, "ref-4", TokenStatus.ACTIVE, FINGERPRINT_B));

        List<VaultRecord> forCardA = repository.findByFundingFingerprint(FINGERPRINT_A);
        assertThat(forCardA).hasSize(2);
        assertThat(forCardA).extracting(VaultRecord::tokenRef).containsExactlyInAnyOrder("ref-1", "ref-2");

        assertThat(repository.findByFundingFingerprint(FINGERPRINT_B)).hasSize(1);
        assertThat(repository.findByFundingFingerprint("unknown".getBytes())).isEmpty();
    }

    @Test
    @DisplayName("status update touches only the addressed token and bumps updated_at")
    void statusUpdate() {
        repository.insert(record("4999600000004822", 49996000L, "ref-1", TokenStatus.ACTIVE, FINGERPRINT_A));
        repository.insert(record("4999600000001117", 49996000L, "ref-2", TokenStatus.ACTIVE, FINGERPRINT_B));
        Instant later = Instant.now().plusSeconds(5).truncatedTo(ChronoUnit.MILLIS);

        assertThat(repository.updateStatus("ref-1", TokenStatus.SUSPENDED, later)).isEqualTo(1);
        assertThat(repository.findByTokenRef("ref-1").orElseThrow().status())
                .isEqualTo(TokenStatus.SUSPENDED);
        assertThat(repository.findByTokenRef("ref-2").orElseThrow().status())
                .isEqualTo(TokenStatus.ACTIVE);
        assertThat(repository.updateStatus("missing", TokenStatus.SUSPENDED, later)).isZero();
    }

    @Test
    @DisplayName("funding update re-points the token without changing the token PAN")
    void fundingUpdate() {
        repository.insert(record("4999600000004822", 49996000L, "ref-1", TokenStatus.ACTIVE, FINGERPRINT_A));
        Instant later = Instant.now().plusSeconds(5).truncatedTo(ChronoUnit.MILLIS);

        int updated = repository.updateFunding("4999600000004822", new byte[]{99}, FINGERPRINT_B,
                "2325", "3012", 2, later);
        assertThat(updated).isEqualTo(1);

        VaultRecord after = repository.findByTokenPan("4999600000004822").orElseThrow();
        assertThat(after.tokenPan()).isEqualTo("4999600000004822");
        assertThat(after.tokenRef()).isEqualTo("ref-1");
        assertThat(after.fundingLast4()).isEqualTo("2325");
        assertThat(after.fundingExpiry()).isEqualTo("3012");
        assertThat(after.keyVersion()).isEqualTo(2);
        assertThat(after.fundingPanFingerprint()).isEqualTo(FINGERPRINT_B);
        // and the token is now discoverable under the new card
        assertThat(repository.findByFundingFingerprint(FINGERPRINT_B)).hasSize(1);
        assertThat(repository.findByFundingFingerprint(FINGERPRINT_A)).isEmpty();
    }

    @Test
    @DisplayName("ATC advances monotonically and rejects replay of the same or a lower counter")
    void atcCompareAndAdvance() {
        repository.insert(record("4999600000004822", 49996000L, "ref-1", TokenStatus.ACTIVE, FINGERPRINT_A));

        assertThat(repository.compareAndAdvanceAtc("4999600000004822", 5)).isTrue();
        assertThat(repository.findLastAtc("4999600000004822")).contains(5);

        assertThat(repository.compareAndAdvanceAtc("4999600000004822", 5)).isFalse();  // replay
        assertThat(repository.compareAndAdvanceAtc("4999600000004822", 4)).isFalse();  // rollback
        assertThat(repository.findLastAtc("4999600000004822")).contains(5);

        assertThat(repository.compareAndAdvanceAtc("4999600000004822", 6)).isTrue();
        assertThat(repository.findLastAtc("4999600000004822")).contains(6);

        assertThat(repository.compareAndAdvanceAtc("4999609999999999", 1)).isFalse(); // unknown token
    }

    @Test
    @DisplayName("concurrent authorizations with the same ATC: exactly one wins")
    void atcAdvanceIsAtomicUnderConcurrency() throws Exception {
        // A read-then-write implementation passes the sequential test above and fails this one.
        repository.insert(record("4999600000004822", 49996000L, "ref-1", TokenStatus.ACTIVE, FINGERPRINT_A));

        int threads = 16;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            AtomicInteger winners = new AtomicInteger();
            List<Future<?>> futures = new java.util.ArrayList<>();
            for (int i = 0; i < threads; i++) {
                futures.add(pool.submit(() -> {
                    if (repository.compareAndAdvanceAtc("4999600000004822", 7)) {
                        winners.incrementAndGet();
                    }
                }));
            }
            for (Future<?> f : futures) {
                f.get(20, TimeUnit.SECONDS);
            }
            assertThat(winners.get()).isEqualTo(1);
            assertThat(repository.findLastAtc("4999600000004822")).contains(7);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    @DisplayName("write-behind flush never moves the stored counter backwards")
    void writeBehindIsMonotonic() {
        // An out-of-order MapStore flush must not undo a later advance, or the replay window would
        // silently widen beyond the write-behind interval.
        repository.insert(record("4999600000004822", 49996000L, "ref-1", TokenStatus.ACTIVE, FINGERPRINT_A));
        repository.writeLastAtc("4999600000004822", 10);
        repository.writeLastAtc("4999600000004822", 4);
        assertThat(repository.findLastAtc("4999600000004822")).contains(10);
    }

    @Test
    @DisplayName("key-version query supports the rotation re-encrypt sweep")
    void findByKeyVersion() {
        repository.insert(record("4999600000004822", 49996000L, "ref-1", TokenStatus.ACTIVE, FINGERPRINT_A));
        repository.insert(record("4999600000001117", 49996000L, "ref-2", TokenStatus.ACTIVE, FINGERPRINT_B));
        repository.updateFunding("4999600000001117", new byte[]{1}, FINGERPRINT_B, "0725", "2812", 2,
                Instant.now());

        assertThat(repository.findByKeyVersion(1)).hasSize(1);
        assertThat(repository.findByKeyVersion(2)).hasSize(1);
        assertThat(repository.count()).isEqualTo(2);
        assertThat(repository.findAll()).hasSize(2);
    }

    @Test
    @DisplayName("an absent ATC on an unknown token is empty, not zero")
    void absentAtc() {
        Optional<Integer> atc = repository.findLastAtc("4999609999999999");
        assertThat(atc).isEmpty();
    }
}
