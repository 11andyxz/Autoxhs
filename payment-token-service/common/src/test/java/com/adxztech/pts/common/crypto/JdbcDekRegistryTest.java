package com.adxztech.pts.common.crypto;

import com.adxztech.pts.common.demo.DemoCards;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import com.adxztech.pts.common.persistence.KeyRegistryRepository;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Key rotation (S7.5): the property that matters is that rotating does not break historical rows.
 * A rotation scheme that requires a synchronous re-encrypt sweep before old data can be read is not a
 * rotation scheme you can run on a live vault.
 */
class JdbcDekRegistryTest {

    private EmbeddedDatabase db;
    private KeyRegistryRepository repository;
    private KeyService keyService;
    private JdbcDekRegistry registry;
    private final EnvelopeCipher cipher = new EnvelopeCipher();

    @BeforeEach
    void setUp() {
        db = new EmbeddedDatabaseBuilder()
                .setType(EmbeddedDatabaseType.H2)
                .generateUniqueName(true)
                .addScript("classpath:db/h2/schema.sql")
                .build();
        repository = new KeyRegistryRepository(new JdbcTemplate(db));
        keyService = new JceKeyService("rotation-test-seed-0123456789");
        registry = new JdbcDekRegistry(repository, keyService);
    }

    @AfterEach
    void tearDown() {
        db.shutdown();
    }

    @Test
    @DisplayName("bootstrap creates version 1 and is idempotent")
    void bootstrapIsIdempotent() {
        assertThat(registry.bootstrap()).isEqualTo(1);
        assertThat(registry.bootstrap()).isEqualTo(1);
        assertThat(repository.findAll()).hasSize(1);
        assertThat(registry.active().version()).isEqualTo(1);
        assertThat(registry.active().state()).isEqualTo(DekState.ACTIVE);
    }

    @Test
    @DisplayName("only the wrapped DEK is persisted -- the registry table alone is useless")
    void onlyWrappedKeyIsStored() {
        registry.bootstrap();
        KeyRegistryRepository.KeyRow row = repository.findActive().orElseThrow();
        byte[] plaintextKey = registry.active().key().getEncoded();
        assertThat(row.wrappedDek()).isNotEqualTo(plaintextKey);
        assertThat(new String(row.wrappedDek())).doesNotContain(new String(plaintextKey));
    }

    @Test
    @DisplayName("rotation makes a new version active and demotes the old one to DECRYPT_ONLY")
    void rotationDemotesPrevious() {
        registry.bootstrap();
        int v2 = registry.rotate();

        assertThat(v2).isEqualTo(2);
        assertThat(registry.active().version()).isEqualTo(2);
        assertThat(repository.findByVersion(1).orElseThrow().state()).isEqualTo(DekState.DECRYPT_ONLY);
        assertThat(repository.findByVersion(2).orElseThrow().state()).isEqualTo(DekState.ACTIVE);
        assertThat(registry.byVersion(1).state()).isEqualTo(DekState.DECRYPT_ONLY);
    }

    @Test
    @DisplayName("data sealed before a rotation still decrypts afterwards, with no re-encryption")
    void oldCiphertextStillDecryptsAfterRotation() {
        registry.bootstrap();
        DekVersion v1 = registry.active();
        String tokenPan = "4999600000004822";
        byte[] sealedUnderV1 = cipher.seal(v1.key(), DemoCards.ISSA_APPROVE, tokenPan);

        registry.rotate();
        registry.clearCache(); // force a re-read from the registry, as a restarted service would

        // The row remembers key_version=1; the registry can still supply that key.
        assertThat(cipher.open(registry.byVersion(1).key(), sealedUnderV1, tokenPan))
                .isEqualTo(DemoCards.ISSA_APPROVE);

        // and new writes use v2, which cannot open the v1 blob
        DekVersion v2 = registry.active();
        assertThat(v2.version()).isEqualTo(2);
        assertThatThrownBy(() -> cipher.open(v2.key(), sealedUnderV1, tokenPan))
                .isInstanceOf(EnvelopeCipher.TamperedCiphertextException.class);
    }

    @Test
    @DisplayName("several rotations keep every prior version readable")
    void manyRotations() {
        registry.bootstrap();
        String tokenPan = "4999600000004822";
        java.util.Map<Integer, byte[]> sealedByVersion = new java.util.HashMap<>();

        for (int i = 0; i < 5; i++) {
            DekVersion active = registry.active();
            sealedByVersion.put(active.version(), cipher.seal(active.key(), DemoCards.ISSA_APPROVE, tokenPan));
            registry.rotate();
        }
        registry.clearCache();

        sealedByVersion.forEach((version, blob) ->
                assertThat(cipher.open(registry.byVersion(version).key(), blob, tokenPan))
                        .isEqualTo(DemoCards.ISSA_APPROVE));
        assertThat(registry.active().version()).isEqualTo(6);
    }

    @Test
    @DisplayName("a RETIRED version refuses to decrypt, and an unknown version is an error")
    void retiredAndUnknownVersions() {
        registry.bootstrap();
        registry.rotate();
        registry.clearCache();
        repository.updateState(1, DekState.RETIRED);

        assertThatThrownBy(() -> registry.byVersion(1))
                .isInstanceOf(KeyServiceException.class)
                .hasMessageContaining("RETIRED");
        assertThatThrownBy(() -> registry.byVersion(99))
                .isInstanceOf(KeyServiceException.class)
                .hasMessageContaining("unknown key_version");
    }

    @Test
    @DisplayName("asking for the active key before bootstrap fails loudly rather than sealing with nothing")
    void activeBeforeBootstrapFails() {
        assertThatThrownBy(() -> registry.active())
                .isInstanceOf(KeyServiceException.class)
                .hasMessageContaining("no ACTIVE key_version");
    }

    @Test
    @DisplayName("a second service adopts the version the first one bootstrapped")
    void secondServiceAdoptsExistingVersion() {
        registry.bootstrap();
        JdbcDekRegistry peer = new JdbcDekRegistry(repository, new JceKeyService("rotation-test-seed-0123456789"));
        assertThat(peer.bootstrap()).isEqualTo(1);
        assertThat(repository.findAll()).hasSize(1);
        // and it derives the same key material, so it can read what the first one wrote
        assertThat(peer.active().key().getEncoded()).isEqualTo(registry.active().key().getEncoded());
    }

    @Test
    @DisplayName("a stale active pointer recovers when another node rotated")
    void staleActivePointerRecovers() {
        registry.bootstrap();
        assertThat(registry.active().version()).isEqualTo(1);

        // Another node rotates behind our back.
        JdbcDekRegistry otherNode = new JdbcDekRegistry(repository, keyService);
        otherNode.bootstrap();
        otherNode.rotate();

        // Our cached pointer says v1, but v1 is now DECRYPT_ONLY: active() must re-resolve.
        assertThat(registry.active().version()).isEqualTo(2);
        assertThat(registry.active().state()).isEqualTo(DekState.ACTIVE);
    }
}
