package com.adxztech.pts.common.log;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Removes anything that could be a PAN or a token from a log line (S13, PII discipline).
 *
 * <p><b>Fail closed.</b> Any run of 12-19 digits -- optionally separated by single spaces or dashes --
 * is masked to first-6 / last-4, whether or not it is Luhn-valid. Masking the occasional epoch
 * millisecond value is a trivial cost; letting one PAN through because a developer wrote
 * {@code log.debug("card={}", pan)} is not. The guarantee has to hold for code nobody reviewed.
 *
 * <p>Wired in through {@link PanScrubbingConverter} so it applies to every log line from every service
 * rather than depending on each call site to remember.
 */
public final class PanScrubber {

    /**
     * 12-19 digits, allowing one space or dash between digits, not preceded or followed by a digit.
     * The lookarounds stop a 20-digit blob from being partially matched and half-masked.
     */
    private static final Pattern CANDIDATE =
            Pattern.compile("(?<![0-9])(?:[0-9][ -]?){11,18}[0-9](?![0-9])");

    private PanScrubber() {
    }

    public static String scrub(String message) {
        if (message == null || message.length() < 12) {
            return message;
        }
        Matcher m = CANDIDATE.matcher(message);
        if (!m.find()) {
            return message;
        }
        StringBuilder out = new StringBuilder(message.length());
        int last = 0;
        do {
            out.append(message, last, m.start());
            out.append(mask(m.group()));
            last = m.end();
        } while (m.find());
        out.append(message, last, message.length());
        return out.toString();
    }

    /** Masks the middle, preserving separators-free first 6 and last 4. */
    private static String mask(String raw) {
        String digits = raw.replaceAll("[ -]", "");
        if (digits.length() < 12 || digits.length() > 19) {
            return raw;
        }
        return digits.substring(0, 6)
                + "*".repeat(digits.length() - 10)
                + digits.substring(digits.length() - 4);
    }
}
