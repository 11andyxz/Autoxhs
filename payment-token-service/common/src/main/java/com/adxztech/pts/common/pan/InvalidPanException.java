package com.adxztech.pts.common.pan;

/** Raised when a supplied PAN is not a syntactically valid, Luhn-consistent account number. */
public class InvalidPanException extends IllegalArgumentException {

    private static final long serialVersionUID = 1L;

    public InvalidPanException(String message) {
        super(message);
    }
}
