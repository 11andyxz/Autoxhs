package com.adxztech.pts.authswitch;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** {@code auth-switch.*} configuration (S6.2). */
@ConfigurationProperties(prefix = "auth-switch")
public class AuthSwitchProperties {

    /**
     * ISO 8583 TCP listen port. Must be a concrete port: jPOS reports the configured value from
     * {@code getPort()}, so binding 0 would leave callers unable to discover where it landed.
     */
    private int isoPort = 8583;

    private String detokenizeUrl = "http://localhost:8082";
    private String issuerSimUrl = "http://localhost:8085";

    private int socketTimeoutMillis = 30_000;
    private int minThreads = 4;
    private int maxThreads = 128;

    /** Retains the last outbound message for the S6.2 backward-compatibility assertions. */
    private boolean recordForwardedMessages = true;

    public int getIsoPort() {
        return isoPort;
    }

    public void setIsoPort(int isoPort) {
        this.isoPort = isoPort;
    }

    public String getDetokenizeUrl() {
        return detokenizeUrl;
    }

    public void setDetokenizeUrl(String detokenizeUrl) {
        this.detokenizeUrl = detokenizeUrl;
    }

    public String getIssuerSimUrl() {
        return issuerSimUrl;
    }

    public void setIssuerSimUrl(String issuerSimUrl) {
        this.issuerSimUrl = issuerSimUrl;
    }

    public int getSocketTimeoutMillis() {
        return socketTimeoutMillis;
    }

    public void setSocketTimeoutMillis(int socketTimeoutMillis) {
        this.socketTimeoutMillis = socketTimeoutMillis;
    }

    public int getMinThreads() {
        return minThreads;
    }

    public void setMinThreads(int minThreads) {
        this.minThreads = minThreads;
    }

    public int getMaxThreads() {
        return maxThreads;
    }

    public void setMaxThreads(int maxThreads) {
        this.maxThreads = maxThreads;
    }

    public boolean isRecordForwardedMessages() {
        return recordForwardedMessages;
    }

    public void setRecordForwardedMessages(boolean recordForwardedMessages) {
        this.recordForwardedMessages = recordForwardedMessages;
    }
}
