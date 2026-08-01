package com.adxztech.pts.cert;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.List;

/** {@code cert.*} configuration for the certification harness (S10.5). */
@ConfigurationProperties(prefix = "cert")
public class CertProperties {

    private String provisioningUrl = "http://localhost:8081";
    private String authSwitchUrl = "http://localhost:8083";
    private String isoHost = "127.0.0.1";
    private int isoPort = 8583;

    /** Where HTML reports are written. */
    private String reportDirectory = "target/cert-reports";

    /**
     * Suites to run on start-up in CLI mode. Empty means "run nothing, serve the API instead".
     * The Jenkins cert stage passes these on the command line.
     */
    private List<String> suites = new ArrayList<>();

    /** Exit the JVM with a non-zero code when a suite fails, so a pipeline stage goes red. */
    private boolean exitOnCompletion = false;

    public String getProvisioningUrl() {
        return provisioningUrl;
    }

    public void setProvisioningUrl(String provisioningUrl) {
        this.provisioningUrl = provisioningUrl;
    }

    public String getAuthSwitchUrl() {
        return authSwitchUrl;
    }

    public void setAuthSwitchUrl(String authSwitchUrl) {
        this.authSwitchUrl = authSwitchUrl;
    }

    public String getIsoHost() {
        return isoHost;
    }

    public void setIsoHost(String isoHost) {
        this.isoHost = isoHost;
    }

    public int getIsoPort() {
        return isoPort;
    }

    public void setIsoPort(int isoPort) {
        this.isoPort = isoPort;
    }

    public String getReportDirectory() {
        return reportDirectory;
    }

    public void setReportDirectory(String reportDirectory) {
        this.reportDirectory = reportDirectory;
    }

    public List<String> getSuites() {
        return suites;
    }

    public void setSuites(List<String> suites) {
        this.suites = suites;
    }

    public boolean isExitOnCompletion() {
        return exitOnCompletion;
    }

    public void setExitOnCompletion(boolean exitOnCompletion) {
        this.exitOnCompletion = exitOnCompletion;
    }
}
