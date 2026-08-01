package com.adxztech.pts.issuersim;

import com.adxztech.pts.common.web.WebConfig;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.context.annotation.Import;

/**
 * Issuer stand-in with two roles (S3.1):
 *
 * <ol>
 *   <li><b>ID&amp;V risk decisioning</b> during provisioning -- returns a risk signal the token service
 *       combines with its own rules to reach APPROVE / STEP_UP / DECLINE (S5.2).</li>
 *   <li><b>Authorization decisioning</b> on the <em>detokenized</em> funding PAN, which is what the
 *       switch forwards after swapping DE 2 (S6.2).</li>
 * </ol>
 *
 * <p>Rule-based and deterministic on purpose: a demo whose outcome depends on a random risk model
 * cannot be scripted, and a certification suite that is not reproducible is not a certification suite.
 */
// The simulator holds no vault data, so the DataSource auto-configuration it inherits transitively
// from the common library is switched off rather than pointed at an unused database.
@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)
@Import(WebConfig.class)
public class IssuerSimulatorApplication {

    public static void main(String[] args) {
        SpringApplication.run(IssuerSimulatorApplication.class, args);
    }
}
