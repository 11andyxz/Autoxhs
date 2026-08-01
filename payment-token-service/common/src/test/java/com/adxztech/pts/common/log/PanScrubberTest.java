package com.adxztech.pts.common.log;

import com.adxztech.pts.common.demo.DemoCards;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The PII discipline claim (S13) is only worth something if it holds for code nobody reviewed, so these
 * tests are written from the attacker's side: every plausible way a PAN might reach a log line.
 */
class PanScrubberTest {

    @Test
    @DisplayName("masks a bare 16-digit PAN")
    void masksPan() {
        assertThat(PanScrubber.scrub("provisioning card " + DemoCards.ISSA_APPROVE))
                .isEqualTo("provisioning card 411110******0725")
                .doesNotContain(DemoCards.ISSA_APPROVE);
    }

    @Test
    @DisplayName("masks formatted PANs with spaces or dashes")
    void masksFormattedPan() {
        assertThat(PanScrubber.scrub("card=4111 1000 0000 0725"))
                .isEqualTo("card=411110******0725");
        assertThat(PanScrubber.scrub("card=4111-1000-0000-0725"))
                .isEqualTo("card=411110******0725");
    }

    @Test
    @DisplayName("masks 15-digit and 19-digit account numbers too")
    void masksOtherLengths() {
        assertThat(PanScrubber.scrub("amex 340000000000009")).isEqualTo("amex 340000*****0009");
        assertThat(PanScrubber.scrub("long 4111100000007251234"))
                .isEqualTo("long 411110*********1234");
    }

    @Test
    @DisplayName("masks several PANs in one line, including inside JSON")
    void masksMultiple() {
        String json = "{\"old\":\"4111100000000725\",\"new\":\"4111100000002325\"}";
        String scrubbed = PanScrubber.scrub(json);
        assertThat(scrubbed).doesNotContain("4111100000000725");
        assertThat(scrubbed).doesNotContain("4111100000002325");
        assertThat(scrubbed).contains("411110******0725").contains("411110******2325");
    }

    @Test
    @DisplayName("masks tokens as well as funding PANs -- they are format-identical")
    void masksTokens() {
        assertThat(PanScrubber.scrub("token 4999600000004822"))
                .isEqualTo("token 499960******4822");
    }

    @Test
    @DisplayName("leaves short numbers, ATCs, amounts and identifiers untouched")
    void leavesShortNumbersAlone() {
        assertThat(PanScrubber.scrub("atc=41 amount=4999 last4=4822"))
                .isEqualTo("atc=41 amount=4999 last4=4822");
        assertThat(PanScrubber.scrub("requestorId=40010030001")) // 11 digits, below the threshold
                .isEqualTo("requestorId=40010030001");
        assertThat(PanScrubber.scrub("no digits here at all")).isEqualTo("no digits here at all");
    }

    @Test
    @DisplayName("fails closed: masks a 13-digit number even though it is not a card")
    void failsClosed() {
        // An epoch-millisecond timestamp gets masked. That is the intended trade: losing a timestamp
        // to the mask is cheap, losing a PAN to a log is not.
        assertThat(PanScrubber.scrub("ts=1735689600000")).isEqualTo("ts=173568***0000");
    }

    @Test
    @DisplayName("does not partially mask a longer digit run, which would leak by inference")
    void doesNotSplitLongerRuns() {
        String twentyDigits = "12345678901234567890";
        assertThat(PanScrubber.scrub("id=" + twentyDigits)).isEqualTo("id=" + twentyDigits);
    }

    @Test
    @DisplayName("handles null and short input without throwing")
    void handlesEdgeCases() {
        assertThat(PanScrubber.scrub(null)).isNull();
        assertThat(PanScrubber.scrub("")).isEmpty();
        assertThat(PanScrubber.scrub("short")).isEqualTo("short");
    }
}
