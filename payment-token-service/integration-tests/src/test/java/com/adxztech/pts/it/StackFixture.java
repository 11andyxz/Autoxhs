package com.adxztech.pts.it;

import com.adxztech.pts.authswitch.AuthSwitchApplication;
import com.adxztech.pts.cert.CertHarnessApplication;
import com.adxztech.pts.controls.TokenControlsApplication;
import com.adxztech.pts.detok.DetokenizationApplication;
import com.adxztech.pts.hzmember.HazelcastMemberApplication;
import com.adxztech.pts.issuersim.IssuerSimulatorApplication;
import com.adxztech.pts.notification.NotificationApplication;
import com.adxztech.pts.provisioning.ProvisioningApplication;
import com.adxztech.pts.common.demo.DemoCards;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.IOException;
import java.net.ServerSocket;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Boots the entire stack inside one JVM, once, for the whole integration suite.
 *
 * <p><b>Why a hand-rolled fixture rather than {@code @SpringBootTest}.</b> The claims being verified are
 * about <em>interactions between services</em>: a lifecycle change written by provisioning becoming
 * visible to detokenization through the cache; an ISO 8583 message crossing a real socket into the switch
 * and out to an issuer; the same behaviour under four different flag combinations simultaneously. A single
 * Spring context cannot express that, and mocking the boundaries would test the mocks.
 *
 * <p><b>Why every property is passed explicitly.</b> Ten service jars are on this module's test classpath
 * and each one ships its own {@code application.yml} at the classpath root. Loading
 * {@code classpath:/application.yml} would resolve to whichever jar the class loader happened to reach
 * first -- so each context could silently pick up another service's configuration. Setting
 * {@code spring.config.name} to a name no file uses disables that lookup entirely, and the topology is
 * then declared here, in one readable place, with no ambiguity about which value won.
 *
 * <p><b>What the topology looks like.</b> One shared in-memory database standing in for the Oracle vault,
 * one Hazelcast member carrying the read-through loader and the ATC entry processor, and four
 * detokenization services -- one per point in the {@code cache-mode} x {@code controls.inline} matrix --
 * so the behavioural-equivalence claim can be asserted across all of them in a single run.
 */
public final class StackFixture {

    private static final Logger log = LoggerFactory.getLogger(StackFixture.class);

    /** Shared by every service in the demo deployment, exactly as the config server would (S12). */
    private static final String SHARED_HSM_SEED = "integration-test-shared-hsm-seed-0001";

    /** One in-memory database plays the part of the Oracle vault for every service. */
    private static final String JDBC_URL =
            "jdbc:h2:mem:pts-integration;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE";

    private static volatile StackFixture instance;

    /** The four points of the A/B matrix (S8.2). */
    public enum Flavour {
        /** The "before" world: every read a database round trip, controls a second hop. */
        BASELINE("DIRECT", false, "DB"),
        /** Optimization A only: near-cache reads. */
        CACHE_ONLY("NEAR_CACHE", false, "DB"),
        /** Optimization B only: controls inlined, ATC moved into the cluster. */
        INLINE_ONLY("DIRECT", true, "CLUSTER"),
        /** Both: the "after" world. */
        OPTIMIZED("NEAR_CACHE", true, "CLUSTER");

        public final String cacheMode;
        public final boolean controlsInline;
        public final String atcMode;

        Flavour(String cacheMode, boolean controlsInline, String atcMode) {
            this.cacheMode = cacheMode;
            this.controlsInline = controlsInline;
            this.atcMode = atcMode;
        }

        boolean needsHazelcast() {
            return "NEAR_CACHE".equals(cacheMode) || "CLUSTER".equals(atcMode);
        }
    }

    private final List<ConfigurableApplicationContext> contexts = new ArrayList<>();

    private String issuerSimUrl;
    private String controlsUrl;
    private String notificationUrl;
    private String provisioningUrl;
    private String authSwitchUrl;
    private int isoPort;
    private int hazelcastPort;
    private final Map<Flavour, String> detokUrls = new LinkedHashMap<>();
    private ConfigurableApplicationContext certContext;

    private StackFixture() {
    }

    public static synchronized StackFixture get() {
        if (instance == null) {
            StackFixture fixture = new StackFixture();
            fixture.start();
            Runtime.getRuntime().addShutdownHook(new Thread(fixture::stop, "stack-fixture-shutdown"));
            instance = fixture;
        }
        return instance;
    }

    private void start() {
        long began = System.currentTimeMillis();
        hazelcastPort = freePort();
        isoPort = freePort();

        // Boot in dependency order: each service needs its dependencies' URLs at construction time.
        ConfigurableApplicationContext issuerSim = boot("issuer-simulator",
                IssuerSimulatorApplication.class, Map.of());
        issuerSimUrl = urlOf(issuerSim);

        boot("hazelcast-member", HazelcastMemberApplication.class, Map.of(
                "pts.hazelcast.mode", "MEMBER",
                "pts.hazelcast.port", String.valueOf(hazelcastPort),
                "pts.hazelcast.members[0]", "127.0.0.1:" + hazelcastPort,
                "pts.hazelcast.backup-count", "0",
                // Write-through rather than write-behind: the ATC reaches the vault immediately, so a
                // test can assert on the durable counter without sleeping for a flush interval.
                "pts.hazelcast.write-behind-seconds", "0",
                "pts.bins.seed-on-startup", "false"));

        ConfigurableApplicationContext controls = boot("token-controls-service",
                TokenControlsApplication.class, Map.of("pts.bins.seed-on-startup", "false"));
        controlsUrl = urlOf(controls);

        ConfigurableApplicationContext notification = boot("issuer-notification-sim",
                NotificationApplication.class, Map.of("pts.bins.seed-on-startup", "false"));
        notificationUrl = urlOf(notification);

        Map<String, String> provisioningProps = new LinkedHashMap<>();
        provisioningProps.put("pts.bins.seed-on-startup", "true"); // provisioning owns reference data
        provisioningProps.put("pts.hazelcast.mode", "CLIENT");
        provisioningProps.put("pts.hazelcast.members[0]", "127.0.0.1:" + hazelcastPort);
        provisioningProps.put("provisioning.issuer-sim-url", issuerSimUrl);
        provisioningProps.put("provisioning.events.transport", "HTTP");
        provisioningProps.put("provisioning.events.notification-url", notificationUrl);
        // The poller is driven explicitly from tests (POST /admin/outbox/drain). Waiting on a scheduler
        // would make every event assertion a timing race.
        provisioningProps.put("provisioning.outbox.enabled", "false");
        provisioningProps.put("provisioning.reconciliation.enabled", "false");
        provisioningProps.put("provisioning.idv.expose-otp-for-demo", "true");
        provisioningProps.put("provisioning.idv.trusted-requestors[0]",
                DemoCards.TRUSTED_MERCHANT_REQUESTOR);
        ConfigurableApplicationContext provisioning =
                boot("token-provisioning-service", ProvisioningApplication.class, provisioningProps);
        provisioningUrl = urlOf(provisioning);

        for (Flavour flavour : Flavour.values()) {
            Map<String, String> props = new LinkedHashMap<>();
            props.put("pts.bins.seed-on-startup", "false");
            props.put("detok.cache-mode", flavour.cacheMode);
            props.put("detok.atc-mode", flavour.atcMode);
            props.put("detok.controls.inline", String.valueOf(flavour.controlsInline));
            props.put("detok.controls.url", controlsUrl);
            props.put("pts.hazelcast.mode", flavour.needsHazelcast() ? "CLIENT" : "DISABLED");
            props.put("pts.hazelcast.members[0]", "127.0.0.1:" + hazelcastPort);
            ConfigurableApplicationContext detok = boot("detok-" + flavour.name().toLowerCase(),
                    DetokenizationApplication.class, props);
            detokUrls.put(flavour, urlOf(detok));
        }

        // The switch points at the optimized replica: the ISO-level assertions are about field handling,
        // and they must hold against the configuration the demo actually ships with.
        ConfigurableApplicationContext authSwitch = boot("auth-switch-simulator",
                AuthSwitchApplication.class, Map.of(
                        "pts.bins.seed-on-startup", "false",
                        "auth-switch.iso-port", String.valueOf(isoPort),
                        "auth-switch.detokenize-url", detokUrls.get(Flavour.OPTIMIZED),
                        "auth-switch.issuer-sim-url", issuerSimUrl,
                        "auth-switch.record-forwarded-messages", "true"));
        authSwitchUrl = urlOf(authSwitch);

        certContext = boot("cert-harness", CertHarnessApplication.class, Map.of(
                "pts.bins.seed-on-startup", "false",
                "cert.provisioning-url", provisioningUrl,
                "cert.auth-switch-url", authSwitchUrl,
                "cert.iso-host", "127.0.0.1",
                "cert.iso-port", String.valueOf(isoPort),
                "cert.report-directory", "target/cert-reports"));

        log.info("=== integration stack up in {} ms ===", System.currentTimeMillis() - began);
        log.info("  issuer-sim   {}", issuerSimUrl);
        log.info("  controls     {}", controlsUrl);
        log.info("  notification {}", notificationUrl);
        log.info("  provisioning {}", provisioningUrl);
        log.info("  auth-switch  {} (ISO 8583 on port {})", authSwitchUrl, isoPort);
        log.info("  hazelcast    member on 127.0.0.1:{}", hazelcastPort);
        detokUrls.forEach((flavour, url) -> log.info("  detok {}  {}", flavour, url));
    }

    /**
     * Boots one service.
     *
     * <p><b>Properties are passed as command-line arguments, not via
     * {@code SpringApplicationBuilder.properties()}.</b> That distinction matters: {@code properties()}
     * contributes a <em>default</em> property source, which sits <em>below</em> anything loaded through
     * {@code spring.config.import}. Since the shared {@code pts-defaults.yml} declares values like
     * {@code pts.hazelcast.mode}, passing overrides as defaults meant the file silently won and, for
     * example, the Hazelcast member came up with Hazelcast disabled. Command-line arguments outrank
     * config data, so an override here actually overrides.
     */
    private ConfigurableApplicationContext boot(String name, Class<?> application,
                                                Map<String, String> extraProperties) {
        Map<String, String> props = new LinkedHashMap<>();
        // No file of this name exists anywhere, which is the point: it disables the ambiguous
        // classpath:/application.yml lookup across ten service jars.
        props.put("spring.config.name", "pts-integration-none");
        props.put("spring.config.import", "classpath:config/pts-defaults.yml");
        // spring-cloud-starter-config is on the classpath via two of the services, and its client
        // refuses to start unless spring.config.import names configserver:. There is no config server in
        // the test topology, so the client is explicitly off rather than accidentally required.
        props.put("spring.cloud.config.enabled", "false");
        props.put("spring.application.name", name);
        props.put("spring.main.banner-mode", "off");
        props.put("spring.jmx.enabled", "false");
        props.put("server.port", "0");
        props.put("spring.datasource.url", JDBC_URL);
        props.put("spring.datasource.username", "sa");
        props.put("spring.datasource.password", "");
        props.put("spring.datasource.driver-class-name", "org.h2.Driver");
        props.put("spring.datasource.hikari.pool-name", name + "-pool");
        props.put("spring.datasource.hikari.maximum-pool-size", "8");
        props.put("spring.sql.init.mode", "always");
        props.put("spring.sql.init.schema-locations", "classpath:db/h2/schema.sql");
        props.put("management.endpoints.web.exposure.include", "health,info,metrics");
        props.put("pts.hsm.dev-seed", SHARED_HSM_SEED);
        props.put("pts.sim.hop-latency-ms", "0");
        props.putAll(extraProperties);

        String[] args = props.entrySet().stream()
                .map(entry -> "--" + entry.getKey() + "=" + entry.getValue())
                .toArray(String[]::new);
        ConfigurableApplicationContext context = new SpringApplicationBuilder(application).run(args);
        contexts.add(context);
        return context;
    }

    private static String urlOf(ConfigurableApplicationContext context) {
        int port = ((WebServerApplicationContext) context).getWebServer().getPort();
        return "http://127.0.0.1:" + port;
    }

    static int freePort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (IOException e) {
            throw new IllegalStateException("cannot allocate a free port", e);
        }
    }

    private void stop() {
        // Reverse order so a service never outlives something it depends on.
        for (int i = contexts.size() - 1; i >= 0; i--) {
            try {
                contexts.get(i).close();
            } catch (Exception e) {
                log.debug("error closing context: {}", e.toString());
            }
        }
    }

    // ------------------------------------------------------------------ accessors

    public String issuerSimUrl() {
        return issuerSimUrl;
    }

    public String controlsUrl() {
        return controlsUrl;
    }

    public String notificationUrl() {
        return notificationUrl;
    }

    public String provisioningUrl() {
        return provisioningUrl;
    }

    public String authSwitchUrl() {
        return authSwitchUrl;
    }

    public String detokUrl(Flavour flavour) {
        return detokUrls.get(flavour);
    }

    public int isoPort() {
        return isoPort;
    }

    public int hazelcastPort() {
        return hazelcastPort;
    }

    public ConfigurableApplicationContext certContext() {
        return certContext;
    }

    public String sharedHsmSeed() {
        return SHARED_HSM_SEED;
    }

    public String jdbcUrl() {
        return JDBC_URL;
    }
}
