package com.adxztech.pts.common.trace;

import org.slf4j.MDC;

import java.util.UUID;

/**
 * The trace id that follows one authorization across every hop (S13).
 *
 * <p>Held in the SLF4J MDC so {@code logback-spring.xml} can stamp it on every line without any call
 * site passing it around, and copied onto outbound HTTP calls by {@link TraceHeaderInterceptor}. That
 * is what turns "detokenization got slow at 14:32" into a single greppable request across the switch,
 * the detokenization service and the database timing logs -- the mechanical part of latency RCA.
 */
public final class TraceContext {

    public static final String MDC_KEY = "traceId";
    public static final String HEADER = "X-Trace-Id";

    private TraceContext() {
    }

    public static String currentOrNew() {
        String existing = MDC.get(MDC_KEY);
        return existing != null ? existing : newId();
    }

    public static String current() {
        return MDC.get(MDC_KEY);
    }

    public static void set(String traceId) {
        MDC.put(MDC_KEY, traceId);
    }

    public static void clear() {
        MDC.remove(MDC_KEY);
    }

    /** Short ids: readable in a terminal, still collision-free for a demo or a single incident. */
    public static String newId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    }
}
