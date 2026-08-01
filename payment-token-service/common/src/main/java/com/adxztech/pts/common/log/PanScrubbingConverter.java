package com.adxztech.pts.common.log;

import ch.qos.logback.classic.pattern.ClassicConverter;
import ch.qos.logback.classic.spi.ILoggingEvent;

/**
 * Logback converter that scrubs card data out of every formatted message (S13).
 *
 * <p>Registered as the {@code %scrubbedMsg} conversion word in {@code logback-spring.xml}, which every
 * service inherits from this library. A converter rather than a filter, because a filter can only drop
 * an event -- it cannot rewrite it, and dropping a log line to protect a PAN loses the diagnostic.
 */
public class PanScrubbingConverter extends ClassicConverter {

    @Override
    public String convert(ILoggingEvent event) {
        return PanScrubber.scrub(event.getFormattedMessage());
    }
}
