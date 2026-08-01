package com.adxztech.pts.common.iso8583;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * DE 48 (private use) markers: the token requestor and usage domain a token-aware issuer needs in
 * order to run its own domain checks (S6.2).
 *
 * <p>Wire form is {@code KEY=value} pairs separated by {@code ;} -- a readable stand-in for the
 * network-specific subfield layouts real specs define. The switch <em>strips</em> this field for
 * token-unaware issuers so they receive a clean legacy message.
 */
public record De48Markers(Map<String, String> values) {

    public static final String KEY_REQUESTOR = "TRID";
    public static final String KEY_DOMAIN = "DOM";
    public static final String KEY_TRACE = "TRACE";
    public static final String KEY_TOKEN_LAST4 = "TL4";

    public De48Markers {
        // Insertion order is part of the wire form, so the copy must preserve it. Map.copyOf() gives
        // an immutable map with *unspecified* iteration order and would scramble the field.
        values = Collections.unmodifiableMap(new LinkedHashMap<>(values));
    }

    public static Builder builder() {
        return new Builder();
    }

    public static De48Markers parse(String raw) {
        Map<String, String> parsed = new LinkedHashMap<>();
        if (raw != null && !raw.isBlank()) {
            for (String pair : raw.split(";")) {
                if (pair.isBlank()) {
                    continue;
                }
                int eq = pair.indexOf('=');
                if (eq <= 0) {
                    continue; // tolerate junk rather than failing an authorization on a marker field
                }
                parsed.put(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
            }
        }
        return new De48Markers(parsed);
    }

    public String encode() {
        StringBuilder sb = new StringBuilder();
        values.forEach((k, v) -> {
            if (sb.length() > 0) {
                sb.append(';');
            }
            sb.append(k).append('=').append(v);
        });
        return sb.toString();
    }

    public String requestorId() {
        return values.get(KEY_REQUESTOR);
    }

    public String domainType() {
        return values.get(KEY_DOMAIN);
    }

    public String traceId() {
        return values.get(KEY_TRACE);
    }

    public String get(String key) {
        return values.get(key);
    }

    public static final class Builder {
        private final Map<String, String> map = new LinkedHashMap<>();

        public Builder requestorId(String v) {
            return put(KEY_REQUESTOR, v);
        }

        public Builder domainType(String v) {
            return put(KEY_DOMAIN, v);
        }

        public Builder traceId(String v) {
            return put(KEY_TRACE, v);
        }

        public Builder tokenLast4(String v) {
            return put(KEY_TOKEN_LAST4, v);
        }

        public Builder put(String k, String v) {
            if (v != null && !v.isBlank()) {
                map.put(k, v);
            }
            return this;
        }

        public De48Markers build() {
            return new De48Markers(map);
        }
    }
}
