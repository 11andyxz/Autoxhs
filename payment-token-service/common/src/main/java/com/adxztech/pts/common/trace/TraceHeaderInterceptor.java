package com.adxztech.pts.common.trace;

import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;

import java.io.IOException;

/** Copies the current trace id onto every outbound inter-service call (S13). */
public class TraceHeaderInterceptor implements ClientHttpRequestInterceptor {

    @Override
    public ClientHttpResponse intercept(org.springframework.http.HttpRequest request, byte[] body,
                                        ClientHttpRequestExecution execution) throws IOException {
        String traceId = TraceContext.current();
        if (traceId != null && !request.getHeaders().containsKey(TraceContext.HEADER)) {
            request.getHeaders().add(TraceContext.HEADER, traceId);
        }
        return execution.execute(request, body);
    }
}
