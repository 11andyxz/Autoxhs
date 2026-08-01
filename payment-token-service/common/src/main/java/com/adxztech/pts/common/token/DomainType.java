package com.adxztech.pts.common.token;

/**
 * The usage domain a token is restricted to (S1.1). A token presented outside its domain is
 * rejected with {@code DOMAIN_MISMATCH}, which is what makes a stolen token near-worthless.
 */
public enum DomainType {

    /** Device-present contactless / NFC. */
    CONTACTLESS,

    /** Card-on-file and e-commerce. */
    ECOM;

    public static DomainType parse(String raw) {
        if (raw == null) {
            throw new IllegalArgumentException("domainType is required");
        }
        try {
            return DomainType.valueOf(raw.trim().toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("unknown domainType: " + raw);
        }
    }
}
