package com.adxztech.pts.common.pan;

/**
 * A validated primary account number -- either a funding PAN or a network token (they are
 * format-identical by design, S1.1).
 *
 * <p>Instances hold the digits in memory only. Nothing here has a {@code toString()} that reveals
 * the full value: {@link #toString()} is masked so an accidental log or exception message cannot
 * leak cardholder data (S13, PII discipline).
 */
public final class Pan {

    private static final int MIN_LEN = 12;
    private static final int MAX_LEN = 19;

    private final String digits;

    private Pan(String digits) {
        this.digits = digits;
    }

    /**
     * Parses and validates a PAN, tolerating the spaces and dashes humans put in them.
     *
     * @throws InvalidPanException when the value is not 12-19 digits or fails the Luhn check
     */
    public static Pan of(String raw) {
        String normalized = normalize(raw);
        if (normalized.length() < MIN_LEN || normalized.length() > MAX_LEN) {
            throw new InvalidPanException("PAN length must be " + MIN_LEN + "-" + MAX_LEN
                    + " digits, was " + normalized.length());
        }
        if (!Luhn.isValid(normalized)) {
            throw new InvalidPanException("PAN fails Luhn check");
        }
        return new Pan(normalized);
    }

    /** Strips formatting characters without validating -- used before length/Luhn checks. */
    public static String normalize(String raw) {
        if (raw == null) {
            throw new InvalidPanException("PAN is required");
        }
        StringBuilder sb = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c >= '0' && c <= '9') {
                sb.append(c);
            } else if (c != ' ' && c != '-') {
                throw new InvalidPanException("PAN contains an illegal character");
            }
        }
        return sb.toString();
    }

    public String value() {
        return digits;
    }

    public int length() {
        return digits.length();
    }

    public String last4() {
        return digits.substring(digits.length() - 4);
    }

    /** @return the leading {@code n} digits, e.g. {@code bin(8)} for the token BIN partition key. */
    public String bin(int n) {
        if (n < 1 || n > digits.length()) {
            throw new IllegalArgumentException("bin length out of range: " + n);
        }
        return digits.substring(0, n);
    }

    /** @return the leading 8 digits as a number -- the {@code token_bin} partition key (S4.1). */
    public long bin8() {
        return Long.parseLong(bin(8));
    }

    /** @return {@code 499960******4821} -- safe for logs and API responses. */
    public String masked() {
        return mask(digits);
    }

    /** Masks a digit string, preserving the leading 6 and trailing 4 (PCI display rule). */
    public static String mask(String digits) {
        if (digits == null || digits.length() < 10) {
            return "***";
        }
        return digits.substring(0, 6)
                + "*".repeat(digits.length() - 10)
                + digits.substring(digits.length() - 4);
    }

    @Override
    public String toString() {
        return masked();
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof Pan other && digits.equals(other.digits);
    }

    @Override
    public int hashCode() {
        return digits.hashCode();
    }
}
