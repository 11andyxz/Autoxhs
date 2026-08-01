package com.adxztech.pts.authswitch;

import org.jpos.iso.ISOMsg;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Captures the shape of the message the switch forwarded to the issuer (S6.2).
 *
 * <p>This is what turns "preserves backward compatibility across issuer processors" from a claim into an
 * observation: for the same inbound authorization you can see that a token-unaware issuer received a
 * clean legacy message with DE 2 swapped and the token fields gone, while a token-aware issuer received
 * the token plus its cryptogram.
 *
 * <p>Records field <em>presence</em> and non-sensitive values only. The PAN is recorded masked -- a demo
 * affordance must not become the one place in the system where a PAN is retained in the clear.
 */
public class ForwardedMessageRecorder {

    /**
     * @param de2Masked        DE 2 as forwarded, masked
     * @param de2IsToken       whether DE 2 still carried the network token
     * @param presentFields    which data elements the outbound message carried
     * @param strippedFields   which data elements the switch removed
     * @param issuerTokenAware the capability flag that drove the decision
     */
    public record Forwarded(String mti,
                            String de2Masked,
                            boolean de2IsToken,
                            String de14Expiry,
                            List<Integer> presentFields,
                            List<Integer> strippedFields,
                            boolean issuerTokenAware,
                            String issuerId) {
    }

    private final AtomicReference<Forwarded> last = new AtomicReference<>();
    private final boolean enabled;

    public ForwardedMessageRecorder(boolean enabled) {
        this.enabled = enabled;
    }

    public void record(ISOMsg outbound, boolean de2IsToken, List<Integer> stripped,
                       boolean issuerTokenAware, String issuerId) {
        if (!enabled) {
            return;
        }
        List<Integer> present = new ArrayList<>();
        for (int field = 2; field <= 63; field++) {
            if (outbound.hasField(field)) {
                present.add(field);
            }
        }
        String mti;
        try {
            mti = outbound.getMTI();
        } catch (Exception e) {
            mti = "?";
        }
        last.set(new Forwarded(mti,
                com.adxztech.pts.common.pan.Pan.mask(outbound.getString(2)),
                de2IsToken,
                outbound.getString(14),
                present,
                List.copyOf(stripped),
                issuerTokenAware,
                issuerId));
    }

    public Forwarded last() {
        return last.get();
    }

    public void clear() {
        last.set(null);
    }
}
