package com.adxztech.pts.common.api;

import java.util.List;

/**
 * Result of a card reissue (S5.5).
 *
 * @param tokensUpdated how many tokens were re-pointed at the new funding PAN
 * @param tokenRefs     the affected tokens, by opaque reference
 */
public record CardUpdateResponse(int tokensUpdated, List<String> tokenRefs) {
}
