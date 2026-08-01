package com.adxztech.pts.common.api;

/**
 * Authorization decision request forwarded to the issuer <em>after</em> detokenization (S3.1).
 *
 * <p>By this point DE 2 has already been swapped, so the issuer sees the funding PAN it knows.
 */
public record IssuerAuthRequest(String fundingPan,
                                String fundingExpiry,
                                long amountMinor,
                                String currencyCode,
                                String stan,
                                String issuerId,
                                boolean tokenized) {
}
