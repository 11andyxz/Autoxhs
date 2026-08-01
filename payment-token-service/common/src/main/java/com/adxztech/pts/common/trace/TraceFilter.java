package com.adxztech.pts.common.trace;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Adopts an inbound {@code X-Trace-Id} or mints one, and echoes it on the response (S13).
 *
 * <p>Ordered ahead of everything else so even a request that fails validation is traceable.
 */
public class TraceFilter extends OncePerRequestFilter implements Ordered {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String inbound = request.getHeader(TraceContext.HEADER);
        String traceId = (inbound == null || inbound.isBlank()) ? TraceContext.newId() : inbound.trim();
        TraceContext.set(traceId);
        response.setHeader(TraceContext.HEADER, traceId);
        try {
            chain.doFilter(request, response);
        } finally {
            // Request threads are pooled: leaving the MDC populated would mislabel the next request.
            TraceContext.clear();
        }
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }
}
