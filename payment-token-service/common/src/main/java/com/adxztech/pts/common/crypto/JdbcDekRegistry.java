package com.adxztech.pts.common.crypto;

import com.adxztech.pts.common.persistence.KeyRegistryRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * {@link DekRegistry} over {@code key_registry}, unwrapping through the {@link KeyService} (S7.2).
 *
 * <p>Unwrapped keys are cached in memory per version, because unwrapping is an HSM round trip and the
 * detokenization hot path cannot afford one per transaction. The cache is keyed by version, which is
 * what makes rotation cheap: after a rotation the new version is unwrapped once and every historical
 * row keeps decrypting under the version stored on it (S7.5) -- no re-encryption sweep required to
 * keep serving traffic.
 */
public class JdbcDekRegistry implements DekRegistry {

    private static final Logger log = LoggerFactory.getLogger(JdbcDekRegistry.class);

    private final KeyRegistryRepository repository;
    private final KeyService keyService;
    private final Map<Integer, DekVersion> unwrapped = new ConcurrentHashMap<>();

    private volatile Integer activeVersion;

    public JdbcDekRegistry(KeyRegistryRepository repository, KeyService keyService) {
        this.repository = repository;
        this.keyService = keyService;
    }

    /**
     * Ensures a usable ACTIVE key exists. Called at startup; safe to call concurrently from several
     * services against the same database -- a losing racer simply finds the row the winner inserted.
     *
     * @return the active version number
     */
    public synchronized int bootstrap() {
        Optional<KeyRegistryRepository.KeyRow> active = repository.findActive();
        if (active.isPresent()) {
            activeVersion = active.get().version();
            log.info("key_registry bootstrap: active key_version={} keyService={}",
                    activeVersion, keyService.describe());
            return activeVersion;
        }
        int version = repository.maxVersion() + 1;
        byte[] wrapped = keyService.wrapDek(keyService.generateDek());
        try {
            repository.insert(version, wrapped, DekState.ACTIVE);
        } catch (RuntimeException e) {
            // Another service bootstrapped first; adopt whatever is now ACTIVE.
            Optional<KeyRegistryRepository.KeyRow> raced = repository.findActive();
            if (raced.isEmpty()) {
                throw e;
            }
            activeVersion = raced.get().version();
            return activeVersion;
        }
        activeVersion = version;
        log.info("key_registry bootstrap: generated key_version={} (wrapped under {})",
                version, keyService.describe());
        return version;
    }

    /**
     * Introduces a new ACTIVE DEK and demotes the previous one to DECRYPT_ONLY (S7.5).
     *
     * <p>No rows are re-encrypted. Existing records keep their {@code key_version} and keep
     * decrypting; only new writes use the new key. That is what makes rotation a non-event
     * operationally -- and why {@code key_version} is a column rather than a global setting.
     *
     * @return the new active version
     */
    public synchronized int rotate() {
        repository.demoteActiveToDecryptOnly();
        int version = repository.maxVersion() + 1;
        repository.insert(version, keyService.wrapDek(keyService.generateDek()), DekState.ACTIVE);
        // Drop the cache so cached DekVersion states cannot claim ACTIVE after a demotion. Historical
        // keys are simply re-unwrapped on next use; rotation is rare enough that the cost is noise.
        unwrapped.clear();
        activeVersion = version;
        log.info("key rotation complete: new active key_version={}", version);
        return version;
    }

    /**
     * Resolves the active version from {@code key_registry} on every call.
     *
     * <p>Deliberately not cached. Any node in the cluster can rotate, and a stale cached pointer would
     * mean sealing new funding PANs under a key that has already been demoted to DECRYPT_ONLY -- a
     * quiet, hard-to-diagnose way to break the rotation invariant. This is the <em>write</em> path
     * (provisioning and card reissue), which already runs several statements per request, so one more
     * indexed read is not a cost worth trading correctness for. The hot read path
     * ({@link #byVersion(int)}) never touches this table.
     */
    @Override
    public DekVersion active() {
        KeyRegistryRepository.KeyRow row = repository.findActive()
                .orElseThrow(() -> new KeyServiceException(
                        "no ACTIVE key_version -- call bootstrap() before writing"));
        activeVersion = row.version();
        DekVersion cached = unwrapped.get(row.version());
        if (cached != null && cached.usableForWrites()) {
            return cached;
        }
        DekVersion dek = new DekVersion(row.version(),
                cached != null ? cached.key() : keyService.unwrapDek(row.wrappedDek()),
                DekState.ACTIVE);
        unwrapped.put(row.version(), dek);
        return dek;
    }

    @Override
    public DekVersion byVersion(int version) {
        DekVersion cached = unwrapped.get(version);
        if (cached != null) {
            return cached;
        }
        KeyRegistryRepository.KeyRow row = repository.findByVersion(version)
                .orElseThrow(() -> new KeyServiceException("unknown key_version " + version));
        if (row.state() == DekState.RETIRED) {
            throw new KeyServiceException("key_version " + version + " is RETIRED and cannot decrypt");
        }
        DekVersion dek = new DekVersion(row.version(), keyService.unwrapDek(row.wrappedDek()), row.state());
        unwrapped.put(version, dek);
        return dek;
    }

    /** Drops the in-memory key cache -- used by tests and after an out-of-band KEK rotation. */
    public void clearCache() {
        unwrapped.clear();
        activeVersion = null;
    }
}
