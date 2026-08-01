package com.adxztech.pts.common.config;

import com.adxztech.pts.common.token.FundingBinRange;
import com.adxztech.pts.common.token.TokenBinRange;
import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.List;

/**
 * {@code pts.bins.*} -- the token and funding BIN maps, seeded from configuration (S4.2, S12).
 *
 * <p>Onboarding a new issuer is meant to be "add a BIN block and a capability flag, then run the cert
 * harness" rather than a code change. Keeping these in config, served per zone by the config server,
 * is what makes that true (S10.5).
 */
@ConfigurationProperties(prefix = "pts.bins")
public class BinProperties {

    /** Seed the BIN tables at start-up. Idempotent; safe with several services sharing a database. */
    private boolean seedOnStartup = true;

    private List<TokenRange> tokenRanges = new ArrayList<>();
    private List<FundingRange> fundingRanges = new ArrayList<>();

    public boolean isSeedOnStartup() {
        return seedOnStartup;
    }

    public void setSeedOnStartup(boolean seedOnStartup) {
        this.seedOnStartup = seedOnStartup;
    }

    public List<TokenRange> getTokenRanges() {
        return tokenRanges;
    }

    public void setTokenRanges(List<TokenRange> tokenRanges) {
        this.tokenRanges = tokenRanges;
    }

    public List<FundingRange> getFundingRanges() {
        return fundingRanges;
    }

    public void setFundingRanges(List<FundingRange> fundingRanges) {
        this.fundingRanges = fundingRanges;
    }

    /** One {@code issuer_bin_map} row. {@code binEnd} is exclusive, matching the Oracle partition bound. */
    public static class TokenRange {
        private long binStart;
        private long binEnd;
        private String issuerId;
        private boolean tokenAware;

        public TokenBinRange toDomain() {
            return new TokenBinRange(binStart, binEnd, issuerId, tokenAware);
        }

        public long getBinStart() {
            return binStart;
        }

        public void setBinStart(long binStart) {
            this.binStart = binStart;
        }

        public long getBinEnd() {
            return binEnd;
        }

        public void setBinEnd(long binEnd) {
            this.binEnd = binEnd;
        }

        public String getIssuerId() {
            return issuerId;
        }

        public void setIssuerId(String issuerId) {
            this.issuerId = issuerId;
        }

        public boolean isTokenAware() {
            return tokenAware;
        }

        public void setTokenAware(boolean tokenAware) {
            this.tokenAware = tokenAware;
        }
    }

    /** One {@code funding_bin_map} row. {@code blocked} drives the ID&amp;V blocklist rule (S5.2). */
    public static class FundingRange {
        private long binStart;
        private long binEnd;
        private String issuerId;
        private boolean blocked;

        public FundingBinRange toDomain() {
            return new FundingBinRange(binStart, binEnd, issuerId, blocked);
        }

        public long getBinStart() {
            return binStart;
        }

        public void setBinStart(long binStart) {
            this.binStart = binStart;
        }

        public long getBinEnd() {
            return binEnd;
        }

        public void setBinEnd(long binEnd) {
            this.binEnd = binEnd;
        }

        public String getIssuerId() {
            return issuerId;
        }

        public void setIssuerId(String issuerId) {
            this.issuerId = issuerId;
        }

        public boolean isBlocked() {
            return blocked;
        }

        public void setBlocked(boolean blocked) {
            this.blocked = blocked;
        }
    }
}
