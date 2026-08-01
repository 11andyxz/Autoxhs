package com.adxztech.pts.common.config;

import com.adxztech.pts.common.crypto.CryptogramService;
import com.adxztech.pts.common.crypto.EnvelopeCipher;
import com.adxztech.pts.common.crypto.JceKeyService;
import com.adxztech.pts.common.crypto.KeyService;
import com.adxztech.pts.common.crypto.PanFingerprint;
import com.adxztech.pts.common.crypto.Pkcs11KeyService;
import com.adxztech.pts.common.sim.LatencyInjector;
import com.adxztech.pts.common.token.TokenPanAllocator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Cryptography and calibration beans. Imported by every service, including the ones with neither a
 * database nor a web tier -- the cert harness and the load driver both need to compute valid cryptograms.
 *
 * <p>Deliberately free of any {@code spring-web} reference: {@code spring-boot-starter-web} is optional in
 * the common library, and declaring a web type here would drag the whole web stack into the non-web load
 * driver (and fail at class-loading time when it is absent). Trace propagation therefore lives in
 * {@link com.adxztech.pts.common.web.WebConfig}.
 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties({HsmProperties.class, SimProperties.class})
public class CryptoConfig {

    private static final Logger log = LoggerFactory.getLogger(CryptoConfig.class);

    @Bean
    public KeyService keyService(HsmProperties properties) {
        KeyService service = switch (properties.getMode()) {
            case PKCS11 -> {
                HsmProperties.Pkcs11 p = properties.getPkcs11();
                yield new Pkcs11KeyService(p.getConfigPath(), p.getPin().toCharArray(),
                        p.getKekAlias(), p.getCryptogramAlias(), p.getFingerprintAlias());
            }
            case JCE -> new JceKeyService(properties.getDevSeed());
        };
        log.info("key service: {}", service.describe());
        return service;
    }

    @Bean
    public EnvelopeCipher envelopeCipher() {
        return new EnvelopeCipher();
    }

    @Bean
    public PanFingerprint panFingerprint(KeyService keyService) {
        return new PanFingerprint(keyService);
    }

    @Bean
    public CryptogramService cryptogramService(KeyService keyService) {
        return new CryptogramService(keyService);
    }

    @Bean
    public TokenPanAllocator tokenPanAllocator() {
        return new TokenPanAllocator();
    }

    @Bean
    public LatencyInjector latencyInjector(SimProperties properties) {
        LatencyInjector injector = new LatencyInjector(properties.getHopLatencyMs());
        if (injector.enabled()) {
            log.warn("SIMULATED NETWORK LATENCY ACTIVE: {} -- this is the Toxiproxy stand-in for "
                    + "laptop latency A/B runs and must not be enabled in a correctness run", injector);
        }
        return injector;
    }
}
