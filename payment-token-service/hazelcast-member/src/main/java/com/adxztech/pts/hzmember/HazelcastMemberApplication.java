package com.adxztech.pts.hzmember;

import com.adxztech.pts.common.config.CryptoConfig;
import com.adxztech.pts.common.config.HazelcastConfig;
import com.adxztech.pts.common.config.PersistenceConfig;
import com.adxztech.pts.common.web.WebConfig;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Import;

/**
 * A Hazelcast cluster member that carries this project's code (S3.1).
 *
 * <p><b>Why the members are not stock Hazelcast containers.</b> Three things in the design have to
 * execute on the member that owns a partition:
 *
 * <ul>
 *   <li>the read-through {@code MapLoader} for {@code vault-records} -- so a cache miss reads the vault
 *       instead of failing an authorization;</li>
 *   <li>the write-behind {@code MapStore} for {@code token-atc} -- so ATC counters reach the database
 *       without a synchronous hop on the hot path;</li>
 *   <li>the {@code AtcAdvanceProcessor} entry processor -- so compare-and-advance is a single
 *       serialized operation on the partition owner.</li>
 * </ul>
 *
 * <p>All three need the classes and a DataSource on the member's classpath. That is why this module
 * exists, and it is the same reason production Hazelcast deployments ship member-side jars rather than
 * relying on user-code deployment.
 */
@SpringBootApplication
@Import({CryptoConfig.class, PersistenceConfig.class, HazelcastConfig.class, WebConfig.class})
public class HazelcastMemberApplication {

    public static void main(String[] args) {
        SpringApplication.run(HazelcastMemberApplication.class, args);
    }
}
