package com.adxztech.pts.common.iso8583;

import org.jpos.iso.ISOException;
import org.jpos.iso.packager.GenericPackager;

import java.io.IOException;
import java.io.InputStream;

/**
 * Loads the project's ISO 8583:1987 ASCII packager (S6.2).
 *
 * <p>A project-owned packager XML rather than jPOS's bundled {@code iso87ascii.xml}, because the
 * demo defines the meaning of DE 48 and DE 55 for the token flow and that definition belongs in this
 * repository where it is reviewable.
 */
public final class PtsPackager {

    private static final String RESOURCE = "/packager/pts-iso87ascii.xml";

    private PtsPackager() {
    }

    /**
     * @return a fresh packager instance. jPOS packagers are stateless once built, but each channel
     *         gets its own so nothing is shared across sockets by accident.
     */
    public static GenericPackager create() {
        try (InputStream in = PtsPackager.class.getResourceAsStream(RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException("packager resource not on classpath: " + RESOURCE);
            }
            return new GenericPackager(in);
        } catch (IOException | ISOException e) {
            throw new IllegalStateException("cannot build ISO 8583 packager from " + RESOURCE, e);
        }
    }
}
