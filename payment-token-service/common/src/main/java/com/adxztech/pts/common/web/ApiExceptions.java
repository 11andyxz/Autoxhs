package com.adxztech.pts.common.web;

/** Transport-neutral exceptions with a defined HTTP mapping, handled by {@link ApiExceptionHandler}. */
public final class ApiExceptions {

    private ApiExceptions() {
    }

    /** 404: the addressed resource does not exist. */
    public static class NotFoundException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public NotFoundException(String message) {
            super(message);
        }
    }

    /**
     * 422: the request is well-formed but cannot be processed. Used for idempotency-key reuse with a
     * different body, which is a client bug rather than a conflict to retry (S10.1).
     */
    public static class UnprocessableException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public UnprocessableException(String message) {
            super(message);
        }
    }

    /** 409: a concurrent request is already handling this idempotency key. */
    public static class ConflictException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public ConflictException(String message) {
            super(message);
        }
    }

    /** 503: a dependency the request needs is unavailable. */
    public static class DependencyUnavailableException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public DependencyUnavailableException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
