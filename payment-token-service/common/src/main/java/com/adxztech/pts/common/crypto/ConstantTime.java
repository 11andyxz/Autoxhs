package com.adxztech.pts.common.crypto;

import java.security.MessageDigest;

/**
 * Timing-safe comparison for MAC and cryptogram verification.
 *
 * <p>{@code Arrays.equals} returns on the first differing byte, which leaks how much of a forged
 * cryptogram was correct and turns forgery into a byte-at-a-time search. {@link MessageDigest#isEqual}
 * is specified to be constant-time for equal-length inputs.
 */
public final class ConstantTime {

    private ConstantTime() {
    }

    public static boolean equals(byte[] a, byte[] b) {
        if (a == null || b == null) {
            return false;
        }
        return MessageDigest.isEqual(a, b);
    }
}
