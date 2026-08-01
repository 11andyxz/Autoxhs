package com.adxztech.pts.controls;

import com.adxztech.pts.common.config.CryptoConfig;
import com.adxztech.pts.common.config.PersistenceConfig;
import com.adxztech.pts.common.web.WebConfig;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Import;

/**
 * The service that exists in order to be removed (S8.2).
 *
 * <p>In the baseline architecture, token status and domain restrictions live here, so detokenization
 * has to make a second synchronous round trip per authorization to evaluate them. That models a real
 * and extremely common shape: controls were someone else's service, so the hot path called it.
 *
 * <p>The optimization denormalizes those fields onto the vault record, so the same check is answered
 * from the already-fetched cache entry and this hop disappears. Flipping
 * {@code detok.controls.inline} switches between the two live.
 *
 * <p>It is implemented properly -- its own connection pool, real error handling, the same repository
 * the vault owner uses -- because a straw-man baseline would make the improvement measure the straw man
 * rather than the removed round trip.
 */
@SpringBootApplication
@Import({CryptoConfig.class, PersistenceConfig.class, WebConfig.class})
public class TokenControlsApplication {

    public static void main(String[] args) {
        SpringApplication.run(TokenControlsApplication.class, args);
    }
}
