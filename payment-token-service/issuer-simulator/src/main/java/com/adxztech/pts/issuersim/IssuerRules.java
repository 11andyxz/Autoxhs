package com.adxztech.pts.issuersim;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.List;

/** {@code issuer-sim.*} -- the configurable rule set behind both simulator roles. */
@ConfigurationProperties(prefix = "issuer-sim")
public class IssuerRules {

    /** Above this amount the issuer answers {@code 51} insufficient funds. */
    private long declineAboveAmountMinor = 500_000L;

    /** Funding PANs the issuer refuses outright ({@code 05}). */
    private List<String> hardDeclinePans = new ArrayList<>();

    /** Funding PANs the issuer hard-blocks at ID&amp;V time, whatever the risk score. */
    private List<String> idvBlockedPans = new ArrayList<>();

    /** Approve every authorization regardless of the rules -- for load tests. */
    private boolean approveEverything = false;

    public long getDeclineAboveAmountMinor() {
        return declineAboveAmountMinor;
    }

    public void setDeclineAboveAmountMinor(long declineAboveAmountMinor) {
        this.declineAboveAmountMinor = declineAboveAmountMinor;
    }

    public List<String> getHardDeclinePans() {
        return hardDeclinePans;
    }

    public void setHardDeclinePans(List<String> hardDeclinePans) {
        this.hardDeclinePans = hardDeclinePans;
    }

    public List<String> getIdvBlockedPans() {
        return idvBlockedPans;
    }

    public void setIdvBlockedPans(List<String> idvBlockedPans) {
        this.idvBlockedPans = idvBlockedPans;
    }

    public boolean isApproveEverything() {
        return approveEverything;
    }

    public void setApproveEverything(boolean approveEverything) {
        this.approveEverything = approveEverything;
    }
}
