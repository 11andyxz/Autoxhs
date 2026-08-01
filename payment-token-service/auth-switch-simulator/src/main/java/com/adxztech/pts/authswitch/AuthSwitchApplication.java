package com.adxztech.pts.authswitch;

import com.adxztech.pts.common.client.DetokenizeClient;
import com.adxztech.pts.common.client.IssuerSimClient;
import com.adxztech.pts.common.client.RestClients;
import com.adxztech.pts.common.config.CryptoConfig;
import com.adxztech.pts.common.config.PersistenceConfig;
import com.adxztech.pts.common.persistence.BinMapRepository;
import com.adxztech.pts.common.trace.TraceHeaderInterceptor;
import com.adxztech.pts.common.web.WebConfig;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;

/**
 * The authorization switch (S6.2): ISO 8583 in, detokenize, forward, relay.
 *
 * <p>This is where the token flow meets the existing rails. Everything upstream of it speaks JSON over
 * mTLS; everything downstream of it is a 1987-vintage message format that has to keep working unchanged
 * for issuers who have never heard of tokens.
 */
@SpringBootApplication
@EnableConfigurationProperties(AuthSwitchProperties.class)
@Import({CryptoConfig.class, PersistenceConfig.class, WebConfig.class})
public class AuthSwitchApplication {

    public static void main(String[] args) {
        SpringApplication.run(AuthSwitchApplication.class, args);
    }

    @Bean
    public ForwardedMessageRecorder forwardedMessageRecorder(AuthSwitchProperties properties) {
        return new ForwardedMessageRecorder(properties.isRecordForwardedMessages());
    }

    @Bean
    public DetokenizeClient detokenizeClient(AuthSwitchProperties properties,
                                             TraceHeaderInterceptor traceInterceptor) {
        // Hot path: short read timeout. A slow detokenization service must produce declines, not a
        // saturated switch.
        return new DetokenizeClient(
                RestClients.hotPath(properties.getDetokenizeUrl(), traceInterceptor));
    }

    @Bean
    public IssuerSimClient issuerSimClient(AuthSwitchProperties properties,
                                           TraceHeaderInterceptor traceInterceptor) {
        return new IssuerSimClient(
                RestClients.hotPath(properties.getIssuerSimUrl(), traceInterceptor));
    }

    @Bean
    public TokenAuthRequestListener tokenAuthRequestListener(DetokenizeClient detokenizeClient,
                                                             IssuerSimClient issuerSimClient,
                                                             BinMapRepository binMapRepository,
                                                             ForwardedMessageRecorder recorder,
                                                             MeterRegistry meterRegistry) {
        return new TokenAuthRequestListener(detokenizeClient, issuerSimClient, binMapRepository,
                recorder, meterRegistry);
    }
}
