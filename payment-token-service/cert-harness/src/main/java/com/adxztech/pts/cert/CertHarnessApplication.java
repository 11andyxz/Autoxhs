package com.adxztech.pts.cert;

import com.adxztech.pts.common.client.ProvisioningClient;
import com.adxztech.pts.common.client.RestClients;
import com.adxztech.pts.common.config.CryptoConfig;
import com.adxztech.pts.common.config.PersistenceConfig;
import com.adxztech.pts.common.crypto.CryptogramService;
import com.adxztech.pts.common.persistence.VaultRepository;
import com.adxztech.pts.common.trace.TraceHeaderInterceptor;
import com.adxztech.pts.common.web.WebConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.web.client.RestClient;

/**
 * The automated certification-environment harness (S10.5).
 *
 * <p>What this replaces: a manual round of test transactions negotiated with each new issuer, one email
 * at a time. What it becomes: a YAML capability profile plus a suite run that either goes green or tells
 * you precisely which data element was wrong. That difference is the mechanism behind shortening issuer
 * onboarding -- the work stops being sequential human coordination and starts being a build step.
 *
 * <p>Runs either as a service ({@code POST /cert/run}) or as a one-shot CLI
 * ({@code --cert.suite=suites/issuer-a-legacy.yml}), which is what the Jenkins {@code cert-suite} stage
 * invokes.
 */
@SpringBootApplication
@EnableConfigurationProperties(CertProperties.class)
@Import({CryptoConfig.class, PersistenceConfig.class, WebConfig.class})
public class CertHarnessApplication {

    public static void main(String[] args) {
        SpringApplication.run(CertHarnessApplication.class, args);
    }

    /**
     * Pins the web layer to JSON.
     *
     * <p>This is not boilerplate, it is a fix. {@code jackson-dataformat-yaml} is on this module's
     * classpath so suite files can be read, and its mere presence changes how the web layer serialises
     * responses: without this bean the harness answered {@code POST /cert/run} with a YAML body while
     * still advertising {@code Content-Type: application/json}, which any JSON client rejects. Actuator
     * was unaffected because it maintains its own mapper, which is exactly why the problem is easy to
     * miss -- health checks kept working.
     *
     * <p>Declaring an explicit JSON mapper makes the response format a decision rather than a
     * side effect of the dependency list. The YAML mapper stays private to {@link SuiteLoader}.
     */
    @Bean
    @Primary
    public ObjectMapper objectMapper() {
        return JsonMapper.builder()
                .findAndAddModules()
                .disable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .build();
    }

    @Bean
    public ProvisioningClient provisioningClient(CertProperties properties,
                                                TraceHeaderInterceptor traceInterceptor) {
        return new ProvisioningClient(
                RestClients.controlPlane(properties.getProvisioningUrl(), traceInterceptor));
    }

    /** Talks to the switch's admin endpoints: the shape of the last forwarded message (S6.2). */
    @Bean
    public RestClient switchAdminClient(CertProperties properties,
                                        TraceHeaderInterceptor traceInterceptor) {
        return RestClients.controlPlane(properties.getAuthSwitchUrl(), traceInterceptor);
    }

    /** Talks to the provisioning service's admin endpoints: issuer capability flags, key rotation. */
    @Bean
    public RestClient provisioningAdminClient(CertProperties properties,
                                              TraceHeaderInterceptor traceInterceptor) {
        return RestClients.controlPlane(properties.getProvisioningUrl(), traceInterceptor);
    }

    @Bean
    public HttpStepExecutor httpStepExecutor(CertProperties properties,
                                            ProvisioningClient provisioningClient,
                                            RestClient provisioningAdminClient,
                                            RestClient switchAdminClient,
                                            VaultRepository vaultRepository,
                                            CryptogramService cryptogramService) {
        return new HttpStepExecutor(provisioningClient, provisioningAdminClient, switchAdminClient,
                vaultRepository, cryptogramService, properties.getIsoHost(), properties.getIsoPort());
    }

    @Bean
    public SuiteRunner suiteRunner(HttpStepExecutor executor) {
        return new SuiteRunner(executor);
    }

    @Bean
    public HtmlReportWriter htmlReportWriter() {
        return new HtmlReportWriter();
    }

    @Bean
    public SuiteLoader suiteLoader() {
        // No ObjectMapper bean is declared anywhere in this application on purpose: see SuiteLoader.
        return new SuiteLoader();
    }
}
