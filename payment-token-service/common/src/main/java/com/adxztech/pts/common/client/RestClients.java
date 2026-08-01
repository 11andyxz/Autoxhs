package com.adxztech.pts.common.client;

import com.adxztech.pts.common.trace.TraceHeaderInterceptor;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.net.http.HttpClient;
import java.time.Duration;

/**
 * Builds inter-service HTTP clients with timeouts and pooling that suit the authorization path.
 *
 * <p><b>Timeouts are not optional here.</b> The detokenization budget is ~22 ms p99; a client with no
 * read timeout turns a slow dependency into an exhausted request-thread pool and a total outage
 * instead of a bounded number of declines. Every client gets an explicit, short read timeout.
 *
 * <p>Backed by {@link HttpClient} rather than {@code HttpURLConnection}, so connections are pooled and
 * reused. Paying a fresh TCP (and in production, TLS) handshake per authorization would put several
 * milliseconds of avoidable work inside the latency budget -- exactly the kind of cost the whole
 * exercise is about removing.
 */
public final class RestClients {

    private RestClients() {
    }

    public static RestClient create(String baseUrl,
                                    Duration connectTimeout,
                                    Duration readTimeout,
                                    TraceHeaderInterceptor traceInterceptor) {
        HttpClient httpClient = HttpClient.newBuilder()
                .connectTimeout(connectTimeout)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(httpClient);
        factory.setReadTimeout(readTimeout);

        RestClient.Builder builder = RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(factory);
        if (traceInterceptor != null) {
            builder = builder.requestInterceptor(traceInterceptor);
        }
        return builder.build();
    }

    /** Hot-path default: fail fast rather than hold a request thread. */
    public static RestClient hotPath(String baseUrl, TraceHeaderInterceptor traceInterceptor) {
        return create(baseUrl, Duration.ofMillis(500), Duration.ofSeconds(2), traceInterceptor);
    }

    /** Provisioning and admin calls can afford to wait longer than an authorization can. */
    public static RestClient controlPlane(String baseUrl, TraceHeaderInterceptor traceInterceptor) {
        return create(baseUrl, Duration.ofSeconds(2), Duration.ofSeconds(15), traceInterceptor);
    }
}
