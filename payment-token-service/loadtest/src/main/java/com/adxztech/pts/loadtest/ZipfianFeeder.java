package com.adxztech.pts.loadtest;

import java.util.List;
import java.util.Random;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Zipfian token selection (S11.2).
 *
 * <p><b>Why this matters more than it looks.</b> A uniform feeder would spread traffic evenly across the
 * token pool, so a near-cache of any realistic size would miss most of the time and the measured benefit
 * of the optimization would be far smaller than production. Card usage is heavily skewed -- a small set of
 * cards drives most volume -- so a uniform feeder does not merely understate the improvement, it
 * misrepresents what the near-cache is for.
 *
 * <p>Using a skewed feeder is therefore not making the numbers look good; it is the only way to make them
 * mean anything. Stating the exponent out loud is part of that: at {@code 1.0} the top 1 % of tokens take
 * roughly a fifth of the traffic in a 10k pool.
 *
 * <p>Precomputes the CDF once and samples with a binary search, so the feeder never becomes the
 * bottleneck it is supposed to be measuring around.
 */
public class ZipfianFeeder {

    private final List<String> tokens;
    private final double[] cumulative;
    private final double exponent;

    public ZipfianFeeder(List<String> tokens, double exponent) {
        if (tokens == null || tokens.isEmpty()) {
            throw new IllegalArgumentException("the token pool is empty");
        }
        if (exponent < 0) {
            throw new IllegalArgumentException("the Zipf exponent must be >= 0");
        }
        this.tokens = List.copyOf(tokens);
        this.exponent = exponent;
        this.cumulative = new double[this.tokens.size()];

        double sum = 0;
        for (int i = 0; i < this.tokens.size(); i++) {
            sum += 1.0 / Math.pow(i + 1, exponent);
            cumulative[i] = sum;
        }
        for (int i = 0; i < cumulative.length; i++) {
            cumulative[i] /= sum;
        }
    }

    /** Uses {@link ThreadLocalRandom} so concurrent workers do not contend on one RNG. */
    public String next() {
        return next(ThreadLocalRandom.current());
    }

    public String next(Random random) {
        double u = random.nextDouble();
        int index = binarySearch(u);
        return tokens.get(index);
    }

    private int binarySearch(double u) {
        int low = 0;
        int high = cumulative.length - 1;
        while (low < high) {
            int mid = (low + high) >>> 1;
            if (cumulative[mid] < u) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    public int poolSize() {
        return tokens.size();
    }

    public double exponent() {
        return exponent;
    }

    /** @return the share of traffic the hottest {@code n} tokens receive -- disclosed in the report */
    public double topShare(int n) {
        if (n <= 0) {
            return 0;
        }
        return cumulative[Math.min(n, cumulative.length) - 1];
    }

    public List<String> tokens() {
        return tokens;
    }
}
