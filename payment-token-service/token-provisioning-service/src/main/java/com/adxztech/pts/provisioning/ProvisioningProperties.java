package com.adxztech.pts.provisioning;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.List;

/** {@code provisioning.*} configuration (S5, S10.1, S10.2). */
@ConfigurationProperties(prefix = "provisioning")
public class ProvisioningProperties {

    private String issuerSimUrl = "http://localhost:8085";

    private Idv idv = new Idv();
    private Outbox outbox = new Outbox();
    private Events events = new Events();
    private Reconciliation reconciliation = new Reconciliation();

    public String getIssuerSimUrl() {
        return issuerSimUrl;
    }

    public void setIssuerSimUrl(String issuerSimUrl) {
        this.issuerSimUrl = issuerSimUrl;
    }

    public Idv getIdv() {
        return idv;
    }

    public void setIdv(Idv idv) {
        this.idv = idv;
    }

    public Outbox getOutbox() {
        return outbox;
    }

    public void setOutbox(Outbox outbox) {
        this.outbox = outbox;
    }

    public Events getEvents() {
        return events;
    }

    public void setEvents(Events events) {
        this.events = events;
    }

    public Reconciliation getReconciliation() {
        return reconciliation;
    }

    public void setReconciliation(Reconciliation reconciliation) {
        this.reconciliation = reconciliation;
    }

    /** ID&amp;V decision thresholds and OTP policy (S5.2, S5.3). */
    public static class Idv {

        /** Below this score the issuer signal is green: approve without step-up. */
        private int approveBelowScore = 30;

        /** At or above this score the signal is red: decline outright. */
        private int declineAtScore = 70;

        /**
         * Requestors whose provisioning is approved in the yellow band without OTP. Models the real
         * distinction between a trusted card-on-file merchant and a wallet enrolling a new device.
         */
        private List<String> trustedRequestors = new ArrayList<>();

        private int otpLength = 6;
        private int otpTtlSeconds = 300;
        private int otpMaxAttempts = 3;

        /**
         * Exposes the generated OTP over an endpoint so a demo or test can complete step-up without an
         * SMS gateway. A demo affordance, off by default, and never appropriate outside a simulator.
         */
        private boolean exposeOtpForDemo = false;

        public int getApproveBelowScore() {
            return approveBelowScore;
        }

        public void setApproveBelowScore(int approveBelowScore) {
            this.approveBelowScore = approveBelowScore;
        }

        public int getDeclineAtScore() {
            return declineAtScore;
        }

        public void setDeclineAtScore(int declineAtScore) {
            this.declineAtScore = declineAtScore;
        }

        public List<String> getTrustedRequestors() {
            return trustedRequestors;
        }

        public void setTrustedRequestors(List<String> trustedRequestors) {
            this.trustedRequestors = trustedRequestors;
        }

        public int getOtpLength() {
            return otpLength;
        }

        public void setOtpLength(int otpLength) {
            this.otpLength = otpLength;
        }

        public int getOtpTtlSeconds() {
            return otpTtlSeconds;
        }

        public void setOtpTtlSeconds(int otpTtlSeconds) {
            this.otpTtlSeconds = otpTtlSeconds;
        }

        public int getOtpMaxAttempts() {
            return otpMaxAttempts;
        }

        public void setOtpMaxAttempts(int otpMaxAttempts) {
            this.otpMaxAttempts = otpMaxAttempts;
        }

        public boolean isExposeOtpForDemo() {
            return exposeOtpForDemo;
        }

        public void setExposeOtpForDemo(boolean exposeOtpForDemo) {
            this.exposeOtpForDemo = exposeOtpForDemo;
        }
    }

    /** Outbox poller settings (S10.2). */
    public static class Outbox {
        private boolean enabled = true;
        private long pollIntervalMs = 250;
        private int batchSize = 50;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public long getPollIntervalMs() {
            return pollIntervalMs;
        }

        public void setPollIntervalMs(long pollIntervalMs) {
            this.pollIntervalMs = pollIntervalMs;
        }

        public int getBatchSize() {
            return batchSize;
        }

        public void setBatchSize(int batchSize) {
            this.batchSize = batchSize;
        }
    }

    /** Which broker carries lifecycle events (S10.2). */
    public static class Events {

        public enum Transport {
            /** In-JVM; tests assert directly on what was published. */
            IN_MEMORY,
            /** HTTP to the notification consumer; the pure-JVM stack has no Kafka. */
            HTTP,
            /** Kafka with enable.idempotence=true; the Docker Compose stack. */
            KAFKA
        }

        private Transport transport = Transport.IN_MEMORY;
        private String notificationUrl = "http://localhost:8086";
        private String kafkaTopic = "token.lifecycle";

        /**
         * Deliveries per event. Set above 1 to force the duplicate that a broker retry would produce
         * and prove the consumer's {@code eventId} dedupe absorbs it.
         */
        private int deliveriesPerEvent = 1;

        public Transport getTransport() {
            return transport;
        }

        public void setTransport(Transport transport) {
            this.transport = transport;
        }

        public String getNotificationUrl() {
            return notificationUrl;
        }

        public void setNotificationUrl(String notificationUrl) {
            this.notificationUrl = notificationUrl;
        }

        public String getKafkaTopic() {
            return kafkaTopic;
        }

        public void setKafkaTopic(String kafkaTopic) {
            this.kafkaTopic = kafkaTopic;
        }

        public int getDeliveriesPerEvent() {
            return deliveriesPerEvent;
        }

        public void setDeliveriesPerEvent(int deliveriesPerEvent) {
            this.deliveriesPerEvent = deliveriesPerEvent;
        }
    }

    /**
     * Cache/database status reconciliation (S16, "biggest risk in this design").
     *
     * <p>Write-through plus invalidation makes divergence very unlikely, not impossible: a crash
     * between the database commit and the cache push leaves a stale entry until TTL. This sweep detects
     * that and is the thing that turns "should not happen" into "would be caught and alerted on".
     */
    public static class Reconciliation {
        private boolean enabled = true;
        private long intervalMs = 60_000;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public long getIntervalMs() {
            return intervalMs;
        }

        public void setIntervalMs(long intervalMs) {
            this.intervalMs = intervalMs;
        }
    }
}
