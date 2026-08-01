package com.adxztech.pts.configserver;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.config.server.EnableConfigServer;

/**
 * Spring Cloud Config Server: one source of configuration for the dev, cert and prod zones (S12).
 *
 * <p>The reason this matters here rather than being generic microservice furniture: several settings must
 * be <em>identical</em> across services or the system silently breaks. The clearest example is
 * {@code pts.hsm.dev-seed} -- if provisioning and detokenization disagree about it, provisioning seals
 * funding PANs that detokenization cannot open, and the failure surfaces as authorization declines rather
 * than as a configuration error.
 *
 * <p>Uses the {@code native} (filesystem) backend against {@code ./config}, so the repository is
 * self-contained. A production deployment points {@code spring.cloud.config.server.git.uri} at a Git
 * repository and gets change history and review on configuration for free -- which is part of the
 * regulated change-management story in S10.5.
 */
@SpringBootApplication
@EnableConfigServer
public class ConfigServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(ConfigServerApplication.class, args);
    }
}
