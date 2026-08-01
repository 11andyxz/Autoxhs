package com.adxztech.pts.common.crypto;

/** Raised when the key store (HSM token or dev key material) cannot satisfy an operation. */
public class KeyServiceException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public KeyServiceException(String message) {
        super(message);
    }

    public KeyServiceException(String message, Throwable cause) {
        super(message, cause);
    }
}
