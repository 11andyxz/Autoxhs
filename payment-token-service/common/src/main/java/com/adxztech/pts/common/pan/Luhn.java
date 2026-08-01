package com.adxztech.pts.common.pan;

/**
 * Luhn (ISO/IEC 7812-1) check-digit arithmetic.
 *
 * <p>Network tokens are format-identical to PANs, which means they must also be Luhn-valid so that
 * they survive every legacy validation gate on the authorization rails (S1.1). This class is used
 * both to validate inbound funding PANs and to complete freshly allocated token PANs.
 */
public final class Luhn {

    private Luhn() {
    }

    /** @return {@code true} when {@code digits} is a non-empty digit string with a valid check digit. */
    public static boolean isValid(String digits) {
        if (digits == null || digits.length() < 2 || !isAllDigits(digits)) {
            return false;
        }
        return checksum(digits) % 10 == 0;
    }

    /**
     * Computes the check digit that must be appended to {@code prefix} to make it Luhn-valid.
     *
     * @param prefix the PAN without its trailing check digit
     */
    public static char checkDigit(String prefix) {
        requireDigits(prefix);
        // Appending a '0' places the (future) check digit in the rightmost position, so the
        // standard doubling pattern lines up with the final PAN.
        int sum = checksum(prefix + '0');
        int check = (10 - (sum % 10)) % 10;
        return (char) ('0' + check);
    }

    /** @return {@code prefix} with its Luhn check digit appended. */
    public static String complete(String prefix) {
        return prefix + checkDigit(prefix);
    }

    /** Doubles every second digit counting from the right, per ISO/IEC 7812-1. */
    private static int checksum(String digits) {
        int sum = 0;
        boolean doubling = false;
        for (int i = digits.length() - 1; i >= 0; i--) {
            int d = digits.charAt(i) - '0';
            if (doubling) {
                d *= 2;
                if (d > 9) {
                    d -= 9;
                }
            }
            sum += d;
            doubling = !doubling;
        }
        return sum;
    }

    private static void requireDigits(String s) {
        if (s == null || s.isEmpty() || !isAllDigits(s)) {
            throw new IllegalArgumentException("expected a non-empty digit string");
        }
    }

    private static boolean isAllDigits(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < '0' || c > '9') {
                return false;
            }
        }
        return true;
    }
}
