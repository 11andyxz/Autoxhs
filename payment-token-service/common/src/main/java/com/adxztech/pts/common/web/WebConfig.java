package com.adxztech.pts.common.web;

import com.adxztech.pts.common.trace.TraceFilter;
import com.adxztech.pts.common.trace.TraceHeaderInterceptor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

/**
 * Web-tier beans shared by every servlet service: trace propagation and the error contract.
 *
 * <p>Both halves of trace propagation live here rather than alongside the crypto beans, because both
 * depend on {@code spring-web} and the common library treats that as optional -- the load driver has no
 * web stack at all (S13).
 */
@Configuration(proxyBeanMethods = false)
@Import(ApiExceptionHandler.class)
public class WebConfig {

    /** Adopts or mints the inbound trace id. */
    @Bean
    public TraceFilter traceFilter() {
        return new TraceFilter();
    }

    /** Copies it onto every outbound inter-service call. */
    @Bean
    public TraceHeaderInterceptor traceHeaderInterceptor() {
        return new TraceHeaderInterceptor();
    }
}
