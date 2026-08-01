package com.adxztech.pts.common.persistence;

import com.adxztech.pts.common.token.FundingBinRange;
import com.adxztech.pts.common.token.TokenBinRange;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SupportingRepositoriesTest {

    private EmbeddedDatabase db;
    private JdbcTemplate jdbc;

    @BeforeEach
    void setUp() {
        db = TestDb.create();
        jdbc = TestDb.template(db);
    }

    @AfterEach
    void tearDown() {
        db.shutdown();
    }

    @Nested
    class Outbox {

        @Test
        @DisplayName("pending events are returned oldest first and disappear once published")
        void pendingLifecycle() {
            OutboxRepository outbox = new OutboxRepository(jdbc);
            outbox.insert("e1", "ref-1", "PROVISIONED", "{\"eventId\":\"e1\"}");
            outbox.insert("e2", "ref-1", "ACTIVATED", "{\"eventId\":\"e2\"}");

            assertThat(outbox.countPending()).isEqualTo(2);
            List<OutboxRepository.OutboxRow> pending = outbox.fetchPending(10);
            assertThat(pending).hasSize(2);
            assertThat(pending).allMatch(OutboxRepository.OutboxRow::pending);

            assertThat(outbox.markPublished("e1")).isEqualTo(1);
            assertThat(outbox.countPending()).isEqualTo(1);
            assertThat(outbox.fetchPending(10)).extracting(OutboxRepository.OutboxRow::eventId)
                    .containsExactly("e2");
        }

        @Test
        @DisplayName("the batch limit is honoured and clamped to something sane")
        void batchLimit() {
            OutboxRepository outbox = new OutboxRepository(jdbc);
            for (int i = 0; i < 25; i++) {
                outbox.insert("e" + i, "ref-1", "PROVISIONED", "{}");
            }
            assertThat(outbox.fetchPending(10)).hasSize(10);
            assertThat(outbox.fetchPending(0)).hasSize(1);      // clamped up to 1
            assertThat(outbox.fetchPending(10_000)).hasSize(25); // clamped down, still returns all
        }

        @Test
        @DisplayName("events are queryable per token, which is how ordering is asserted")
        void perTokenHistory() {
            OutboxRepository outbox = new OutboxRepository(jdbc);
            outbox.insert("e1", "ref-1", "PROVISIONED", "{}");
            outbox.insert("e2", "ref-1", "ACTIVATED", "{}");
            outbox.insert("e3", "ref-2", "PROVISIONED", "{}");
            assertThat(outbox.findByTokenRef("ref-1"))
                    .extracting(OutboxRepository.OutboxRow::eventType)
                    .containsExactly("PROVISIONED", "ACTIVATED");
        }

        @Test
        @DisplayName("a CLOB payload round trips unchanged")
        void clobPayload() {
            OutboxRepository outbox = new OutboxRepository(jdbc);
            String payload = "{\"eventId\":\"e1\",\"note\":\"" + "x".repeat(5000) + "\"}";
            outbox.insert("e1", "ref-1", "PROVISIONED", payload);
            assertThat(outbox.fetchPending(1).get(0).payload()).isEqualTo(payload);
        }
    }

    @Nested
    class Idempotency {

        @Test
        @DisplayName("a key can be claimed once; a concurrent retry loses the race")
        void claimIsExclusive() {
            IdempotencyRepository repo = new IdempotencyRepository(jdbc);
            byte[] hash = "request-hash-32-bytes-of-content".getBytes();

            assertThat(repo.tryClaim("key-1", hash)).isTrue();
            assertThat(repo.tryClaim("key-1", hash)).isFalse();
        }

        @Test
        @DisplayName("the stored response is what a retry replays")
        void storesResponse() {
            IdempotencyRepository repo = new IdempotencyRepository(jdbc);
            byte[] hash = "request-hash-32-bytes-of-content".getBytes();
            repo.tryClaim("key-1", hash);
            assertThat(repo.find("key-1").orElseThrow().response()).isNull();

            repo.storeResponse("key-1", "{\"tokenRef\":\"ref-1\"}");
            IdempotencyRepository.IdemRow row = repo.find("key-1").orElseThrow();
            assertThat(row.response()).isEqualTo("{\"tokenRef\":\"ref-1\"}");
            assertThat(row.requestHash()).isEqualTo(hash);
        }

        @Test
        @DisplayName("releasing an unanswered claim frees the key, but a completed one is kept")
        void releaseOnlyFreesUnanswered() {
            IdempotencyRepository repo = new IdempotencyRepository(jdbc);
            byte[] hash = "request-hash-32-bytes-of-content".getBytes();

            repo.tryClaim("failed", hash);
            assertThat(repo.release("failed")).isEqualTo(1);
            assertThat(repo.find("failed")).isEmpty();
            assertThat(repo.tryClaim("failed", hash)).isTrue(); // genuine retry not blocked forever

            repo.tryClaim("done", hash);
            repo.storeResponse("done", "{}");
            assertThat(repo.release("done")).isZero();
            assertThat(repo.find("done")).isPresent();
        }

        @Test
        @DisplayName("expired keys are purged")
        void purge() {
            IdempotencyRepository repo = new IdempotencyRepository(jdbc);
            repo.tryClaim("old", "request-hash-32-bytes-of-content".getBytes());
            assertThat(repo.deleteOlderThan(Instant.now().minus(1, ChronoUnit.DAYS))).isZero();
            assertThat(repo.deleteOlderThan(Instant.now().plusSeconds(60))).isEqualTo(1);
        }
    }

    @Nested
    class BinMap {

        @Test
        @DisplayName("token BIN lookup resolves the owning issuer and its token capability")
        void tokenRangeLookup() {
            BinMapRepository repo = new BinMapRepository(jdbc);
            repo.upsertTokenRange(new TokenBinRange(49996000L, 49996100L, "ISSA", false));
            repo.upsertTokenRange(new TokenBinRange(49996100L, 49996200L, "ISSB", true));

            assertThat(repo.findTokenRange(49996000L).orElseThrow().issuerId()).isEqualTo("ISSA");
            assertThat(repo.findTokenRange(49996099L).orElseThrow().issuerId()).isEqualTo("ISSA");
            assertThat(repo.findTokenRange(49996100L).orElseThrow().issuerId()).isEqualTo("ISSB");
            assertThat(repo.findTokenRange(49996100L).orElseThrow().tokenAware()).isTrue();
            assertThat(repo.findTokenRange(49999999L)).isEmpty();
        }

        @Test
        @DisplayName("seeding is idempotent, so several services can each seed at start-up")
        void upsertIsIdempotent() {
            BinMapRepository repo = new BinMapRepository(jdbc);
            repo.upsertTokenRange(new TokenBinRange(49996000L, 49996100L, "ISSA", false));
            repo.upsertTokenRange(new TokenBinRange(49996000L, 49996100L, "ISSA", false));
            repo.upsertTokenRange(new TokenBinRange(49996000L, 49996100L, "ISSA", true));

            assertThat(repo.findAllTokenRanges()).hasSize(1);
            assertThat(repo.findTokenRange(49996000L).orElseThrow().tokenAware()).isTrue();
        }

        @Test
        @DisplayName("the token_aware flag can be flipped per issuer for the backward-compat demo")
        void toggleTokenAware() {
            BinMapRepository repo = new BinMapRepository(jdbc);
            repo.upsertTokenRange(new TokenBinRange(49996000L, 49996100L, "ISSA", false));
            assertThat(repo.setTokenAware("ISSA", true)).isEqualTo(1);
            assertThat(repo.findTokenRangeByIssuer("ISSA").orElseThrow().tokenAware()).isTrue();
            assertThat(repo.setTokenAware("ISSA", false)).isEqualTo(1);
            assertThat(repo.findTokenRangeByIssuer("ISSA").orElseThrow().tokenAware()).isFalse();
        }

        @Test
        @DisplayName("funding BIN lookup resolves the issuer and the blocklist flag")
        void fundingRangeLookup() {
            BinMapRepository repo = new BinMapRepository(jdbc);
            repo.upsertFundingRange(new FundingBinRange(41111000L, 41112000L, "ISSA", false));
            repo.upsertFundingRange(new FundingBinRange(43333000L, 43334000L, "ISSX", true));

            assertThat(repo.findFundingRange(41111000L).orElseThrow().issuerId()).isEqualTo("ISSA");
            assertThat(repo.findFundingRange(41111000L).orElseThrow().blocked()).isFalse();
            assertThat(repo.findFundingRange(43333000L).orElseThrow().blocked()).isTrue();
            assertThat(repo.findFundingRange(49999999L)).isEmpty();
            assertThat(repo.findAllFundingRanges()).hasSize(2);
        }
    }

    @Nested
    class IdvSessions {

        @Test
        @DisplayName("a session round trips, counts attempts and can be deleted")
        void lifecycle() {
            IdvSessionRepository repo = new IdvSessionRepository(jdbc);
            Instant expiry = Instant.now().plusSeconds(300).truncatedTo(ChronoUnit.MILLIS);
            repo.insert(new IdvSessionRepository.IdvSession("s1", "ref-1",
                    "otp-hash-value-32-bytes-of-data!".getBytes(), 0, expiry));

            IdvSessionRepository.IdvSession loaded = repo.find("s1").orElseThrow();
            assertThat(loaded.tokenRef()).isEqualTo("ref-1");
            assertThat(loaded.attempts()).isZero();
            assertThat(loaded.expired(Instant.now())).isFalse();
            assertThat(loaded.expired(Instant.now().plusSeconds(600))).isTrue();

            repo.incrementAttempts("s1");
            repo.incrementAttempts("s1");
            assertThat(repo.find("s1").orElseThrow().attempts()).isEqualTo(2);

            assertThat(repo.delete("s1")).isEqualTo(1);
            assertThat(repo.find("s1")).isEmpty();
        }

        @Test
        @DisplayName("expired sessions are purged by the scheduled cleanup")
        void purgeExpired() {
            IdvSessionRepository repo = new IdvSessionRepository(jdbc);
            repo.insert(new IdvSessionRepository.IdvSession("stale", "ref-1",
                    "otp-hash-value-32-bytes-of-data!".getBytes(), 3,
                    Instant.now().minusSeconds(60)));
            repo.insert(new IdvSessionRepository.IdvSession("fresh", "ref-2",
                    "otp-hash-value-32-bytes-of-data!".getBytes(), 0,
                    Instant.now().plusSeconds(300)));

            assertThat(repo.deleteExpired(Instant.now())).isEqualTo(1);
            assertThat(repo.find("stale")).isEmpty();
            assertThat(repo.find("fresh")).isPresent();
        }
    }

    @Nested
    class NotificationDedupe {

        @Test
        @DisplayName("the first delivery is acted on and every repeat is suppressed")
        void dedupe() {
            NotificationDedupeRepository repo = new NotificationDedupeRepository(jdbc);
            assertThat(repo.markSeen("e1", "SUSPENDED", "ref-1")).isTrue();
            assertThat(repo.markSeen("e1", "SUSPENDED", "ref-1")).isFalse();
            assertThat(repo.markSeen("e1", "SUSPENDED", "ref-1")).isFalse();
            assertThat(repo.seen("e1")).isTrue();
            assertThat(repo.seen("e2")).isFalse();
            assertThat(repo.count()).isEqualTo(1);
        }

        @Test
        @DisplayName("dedupe is durable, so a consumer restart does not re-notify")
        void durableAcrossInstances() {
            new NotificationDedupeRepository(jdbc).markSeen("e1", "SUSPENDED", "ref-1");
            // A fresh repository instance stands in for a restarted consumer process.
            assertThat(new NotificationDedupeRepository(jdbc).markSeen("e1", "SUSPENDED", "ref-1"))
                    .isFalse();
        }
    }
}
