package com.adxztech.pts.detok;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code detok.*} -- the feature flags that make the latency story reproducible (S8.2, S12).
 *
 * <p>Every optimization is a runtime flag rather than a rewrite, for two reasons. First, it lets the A/B
 * be measured on one build, so the only variable is the flag. Second, it is how you would actually ship
 * a change like this: behind a flag, progressively, with the old path one setting away.
 */
@ConfigurationProperties(prefix = "detok")
public class DetokProperties {

    public enum CacheMode {
        /** Every vault read is a JDBC round trip. The "before" world (S8.1). */
        DIRECT,
        /** Reads served from the Hazelcast client near-cache, falling through to the cluster (S8.2). */
        NEAR_CACHE
    }

    public enum AtcMode {
        /** Conditional UPDATE in the database: durable, one synchronous round trip. */
        DB,
        /** Entry processor on the partition owner, write-behind to the database (S8.2). */
        CLUSTER
    }

    /**
     * Where the ATC advance sits relative to cryptogram verification.
     *
     * <p>See {@link DetokenizationService} for why the default deviates from the ordering in S6.1.
     */
    public enum AtcOrder {
        /** Verify the cryptogram first, then advance the counter. Default; safe against ATC burning. */
        AFTER_CRYPTOGRAM,
        /** Advance the counter first, exactly as written in S6.1 steps 4-5. */
        BEFORE_CRYPTOGRAM
    }

    private CacheMode cacheMode = CacheMode.DIRECT;
    private AtcMode atcMode = AtcMode.DB;
    private AtcOrder atcOrder = AtcOrder.AFTER_CRYPTOGRAM;
    private Controls controls = new Controls();

    public CacheMode getCacheMode() {
        return cacheMode;
    }

    public void setCacheMode(CacheMode cacheMode) {
        this.cacheMode = cacheMode;
    }

    public AtcMode getAtcMode() {
        return atcMode;
    }

    public void setAtcMode(AtcMode atcMode) {
        this.atcMode = atcMode;
    }

    public AtcOrder getAtcOrder() {
        return atcOrder;
    }

    public void setAtcOrder(AtcOrder atcOrder) {
        this.atcOrder = atcOrder;
    }

    public Controls getControls() {
        return controls;
    }

    public void setControls(Controls controls) {
        this.controls = controls;
    }

    public static class Controls {

        /**
         * {@code false} calls token-controls-service (the baseline's second synchronous round trip);
         * {@code true} answers the same question from the already-fetched vault record (S8.2).
         */
        private boolean inline = false;

        private String url = "http://localhost:8084";

        public boolean isInline() {
            return inline;
        }

        public void setInline(boolean inline) {
            this.inline = inline;
        }

        public String getUrl() {
            return url;
        }

        public void setUrl(String url) {
            this.url = url;
        }
    }
}
