package com.adxztech.pts.loadtest;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * An open-model injection profile: arrival rate over time (S11.1).
 *
 * <p><b>Open model, not closed.</b> A closed model (N looping virtual users) throttles itself when the
 * system slows down: fewer requests are offered, so the measured latency improves as the system degrades.
 * That is coordinated omission, and it is how load tests come to report a healthy p99 for a system that
 * is failing. Authorization traffic arrives at a rate set by cardholders, not by how fast the network
 * responds, so the profile specifies <em>arrivals per second</em> and the driver honours them regardless
 * of how long responses take.
 *
 * <p>Syntax: comma-separated stages.
 * <pre>
 *   ramp:50-&gt;2000/120s      linearly ramp arrival rate from 50/s to 2000/s over 2 minutes
 *   constant:2000/300s      hold 2000/s for 5 minutes
 *   spike:6000/30s          holiday peak: 6000/s for 30 seconds
 * </pre>
 */
public record InjectionProfile(List<Stage> stages) {

    public sealed interface Stage {
        long durationMillis();

        /** @param offsetMillis time since the stage started */
        double rateAt(long offsetMillis);

        String describe();
    }

    public record Constant(double rate, long durationMillis) implements Stage {
        @Override
        public double rateAt(long offsetMillis) {
            return rate;
        }

        @Override
        public String describe() {
            return "constant " + fmt(rate) + "/s for " + durationMillis / 1000 + "s";
        }
    }

    public record Ramp(double fromRate, double toRate, long durationMillis) implements Stage {
        @Override
        public double rateAt(long offsetMillis) {
            double fraction = durationMillis == 0 ? 1.0
                    : Math.min(1.0, (double) offsetMillis / durationMillis);
            return fromRate + (toRate - fromRate) * fraction;
        }

        @Override
        public String describe() {
            return "ramp " + fmt(fromRate) + "/s -> " + fmt(toRate) + "/s over "
                    + durationMillis / 1000 + "s";
        }
    }

    public InjectionProfile {
        if (stages == null || stages.isEmpty()) {
            throw new IllegalArgumentException("an injection profile needs at least one stage");
        }
        stages = List.copyOf(stages);
    }

    public long totalDurationMillis() {
        return stages.stream().mapToLong(Stage::durationMillis).sum();
    }

    /** @return the expected number of arrivals, integrating rate over time */
    public long expectedArrivals() {
        double total = 0;
        for (Stage stage : stages) {
            if (stage instanceof Constant c) {
                total += c.rate() * c.durationMillis() / 1000.0;
            } else if (stage instanceof Ramp r) {
                total += (r.fromRate() + r.toRate()) / 2.0 * r.durationMillis() / 1000.0;
            }
        }
        return Math.round(total);
    }

    public String describe() {
        List<String> parts = new ArrayList<>();
        stages.forEach(stage -> parts.add(stage.describe()));
        return String.join(", then ", parts);
    }

    public static InjectionProfile parse(String spec) {
        if (spec == null || spec.isBlank()) {
            throw new IllegalArgumentException("an injection profile is required");
        }
        List<Stage> stages = new ArrayList<>();
        for (String rawStage : spec.split(",")) {
            String stage = rawStage.trim().toLowerCase(Locale.ROOT);
            if (stage.isEmpty()) {
                continue;
            }
            int colon = stage.indexOf(':');
            if (colon < 0) {
                throw new IllegalArgumentException("malformed stage (expected kind:spec): " + rawStage);
            }
            String kind = stage.substring(0, colon);
            String body = stage.substring(colon + 1);
            int slash = body.lastIndexOf('/');
            if (slash < 0) {
                throw new IllegalArgumentException("stage is missing a duration: " + rawStage);
            }
            long durationMillis = parseDuration(body.substring(slash + 1));
            String rateSpec = body.substring(0, slash);

            switch (kind) {
                case "constant", "spike" -> stages.add(new Constant(parseRate(rateSpec), durationMillis));
                case "ramp" -> {
                    String[] bounds = rateSpec.split("->");
                    if (bounds.length != 2) {
                        throw new IllegalArgumentException(
                                "a ramp needs from->to, e.g. ramp:50->2000/120s, got: " + rawStage);
                    }
                    stages.add(new Ramp(parseRate(bounds[0]), parseRate(bounds[1]), durationMillis));
                }
                default -> throw new IllegalArgumentException(
                        "unknown stage kind '" + kind + "' (expected ramp, constant or spike)");
            }
        }
        return new InjectionProfile(stages);
    }

    private static double parseRate(String text) {
        double rate = Double.parseDouble(text.trim());
        if (rate < 0) {
            throw new IllegalArgumentException("an arrival rate cannot be negative: " + text);
        }
        return rate;
    }

    private static long parseDuration(String text) {
        String value = text.trim();
        long multiplier = 1000L;
        if (value.endsWith("ms")) {
            multiplier = 1L;
            value = value.substring(0, value.length() - 2);
        } else if (value.endsWith("s")) {
            value = value.substring(0, value.length() - 1);
        } else if (value.endsWith("m")) {
            multiplier = 60_000L;
            value = value.substring(0, value.length() - 1);
        }
        long duration = Math.round(Double.parseDouble(value.trim()) * multiplier);
        if (duration <= 0) {
            throw new IllegalArgumentException("a stage duration must be positive: " + text);
        }
        return duration;
    }

    private static String fmt(double rate) {
        return rate == Math.rint(rate) ? String.valueOf((long) rate) : String.valueOf(rate);
    }
}
