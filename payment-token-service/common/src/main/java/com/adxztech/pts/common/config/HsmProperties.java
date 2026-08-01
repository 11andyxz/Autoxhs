package com.adxztech.pts.common.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code pts.hsm.*} -- which key custody path the service uses (S7).
 *
 * <p>Served from the config server so every service in a zone agrees on it (S12): provisioning seals
 * funding PANs and detokenization opens them, so a mismatch here is an outage.
 */
@ConfigurationProperties(prefix = "pts.hsm")
public class HsmProperties {

    public enum Mode {
        /** HKDF-derived keys from {@link #devSeed}. Dev and CI only. */
        JCE,
        /** SoftHSM2 in the demo, a payment HSM in production. */
        PKCS11
    }

    private Mode mode = Mode.JCE;

    /** Shared secret for {@link Mode#JCE}. Must be identical across services in a deployment. */
    private String devSeed = "pts-local-dev-seed-do-not-use-in-prod";

    private Pkcs11 pkcs11 = new Pkcs11();

    public Mode getMode() {
        return mode;
    }

    public void setMode(Mode mode) {
        this.mode = mode;
    }

    public String getDevSeed() {
        return devSeed;
    }

    public void setDevSeed(String devSeed) {
        this.devSeed = devSeed;
    }

    public Pkcs11 getPkcs11() {
        return pkcs11;
    }

    public void setPkcs11(Pkcs11 pkcs11) {
        this.pkcs11 = pkcs11;
    }

    /** SunPKCS11 wiring. See {@code ops/softhsm/init-softhsm.sh}. */
    public static class Pkcs11 {

        private String configPath = "/etc/pts/softhsm-pkcs11.cfg";
        private String pin = "1234";
        private String kekAlias = "pts-kek";
        private String cryptogramAlias = "pts-cryptogram-key";
        private String fingerprintAlias = "pts-fingerprint-key";

        public String getConfigPath() {
            return configPath;
        }

        public void setConfigPath(String configPath) {
            this.configPath = configPath;
        }

        public String getPin() {
            return pin;
        }

        public void setPin(String pin) {
            this.pin = pin;
        }

        public String getKekAlias() {
            return kekAlias;
        }

        public void setKekAlias(String kekAlias) {
            this.kekAlias = kekAlias;
        }

        public String getCryptogramAlias() {
            return cryptogramAlias;
        }

        public void setCryptogramAlias(String cryptogramAlias) {
            this.cryptogramAlias = cryptogramAlias;
        }

        public String getFingerprintAlias() {
            return fingerprintAlias;
        }

        public void setFingerprintAlias(String fingerprintAlias) {
            this.fingerprintAlias = fingerprintAlias;
        }
    }
}
