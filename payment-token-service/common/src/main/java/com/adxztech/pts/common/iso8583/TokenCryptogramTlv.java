package com.adxztech.pts.common.iso8583;

import com.adxztech.pts.common.util.Hex;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;

/**
 * BER-TLV codec for the token cryptogram data carried in DE 55 (S6.2).
 *
 * <p>Tags follow EMV convention so the shape is recognisable:
 * <table border="1">
 *   <caption>Tags</caption>
 *   <tr><th>Tag</th><th>Meaning</th><th>Length</th></tr>
 *   <tr><td>9F26</td><td>Application cryptogram (TAVV-style)</td><td>8</td></tr>
 *   <tr><td>9F36</td><td>Application transaction counter (ATC)</td><td>2</td></tr>
 *   <tr><td>9F37</td><td>Unpredictable number</td><td>4</td></tr>
 * </table>
 *
 * <p>Unknown tags are skipped rather than rejected: that is what lets a token-aware issuer add its
 * own TLVs without breaking this parser, and it is the same forward-compatibility discipline the
 * real networks rely on.
 *
 * <p>Because the demo packager renders DE 55 as ASCII ({@code IFA_LLLCHAR}), the wire form is the
 * uppercase hex of these bytes. A binary-format network would use {@code IFB_LLLBINARY} and the
 * bytes directly -- {@link #encode()} is the same either way.
 */
public record TokenCryptogramTlv(byte[] cryptogram, int atc, byte[] unpredictableNumber) {

    public static final int TAG_CRYPTOGRAM = 0x9F26;
    public static final int TAG_ATC = 0x9F36;
    public static final int TAG_UN = 0x9F37;

    public static final int CRYPTOGRAM_LEN = 8;
    public static final int ATC_LEN = 2;
    public static final int UN_LEN = 4;

    public TokenCryptogramTlv {
        if (cryptogram == null || cryptogram.length != CRYPTOGRAM_LEN) {
            throw new TlvException("cryptogram must be " + CRYPTOGRAM_LEN + " bytes");
        }
        if (atc < 0 || atc > 0xFFFF) {
            throw new TlvException("ATC must fit in 2 bytes: " + atc);
        }
        if (unpredictableNumber == null || unpredictableNumber.length != UN_LEN) {
            throw new TlvException("unpredictable number must be " + UN_LEN + " bytes");
        }
    }

    public byte[] encode() {
        ByteArrayOutputStream out = new ByteArrayOutputStream(32);
        writeTlv(out, TAG_CRYPTOGRAM, cryptogram);
        writeTlv(out, TAG_ATC, new byte[]{(byte) (atc >>> 8), (byte) (atc & 0xFF)});
        writeTlv(out, TAG_UN, unpredictableNumber);
        return out.toByteArray();
    }

    public String encodeHex() {
        return Hex.encode(encode());
    }

    public static TokenCryptogramTlv decodeHex(String hex) {
        if (hex == null || hex.isBlank()) {
            throw new TlvException("DE 55 is absent");
        }
        try {
            return decode(Hex.decode(hex));
        } catch (IllegalArgumentException e) {
            throw new TlvException("DE 55 is not valid hex: " + e.getMessage());
        }
    }

    public static TokenCryptogramTlv decode(byte[] data) {
        if (data == null || data.length == 0) {
            throw new TlvException("DE 55 is empty");
        }
        byte[] cryptogram = null;
        Integer atc = null;
        byte[] un = null;

        int i = 0;
        while (i < data.length) {
            if (i + 1 >= data.length) {
                throw new TlvException("truncated tag at offset " + i);
            }
            int tag = ((data[i] & 0xFF) << 8) | (data[i + 1] & 0xFF);
            i += 2;
            if (i >= data.length) {
                throw new TlvException("missing length for tag " + Integer.toHexString(tag));
            }
            int len = data[i] & 0xFF;
            i += 1;
            if (i + len > data.length) {
                throw new TlvException("value of tag " + Integer.toHexString(tag)
                        + " runs past end of DE 55");
            }
            byte[] value = Arrays.copyOfRange(data, i, i + len);
            i += len;

            switch (tag) {
                case TAG_CRYPTOGRAM -> cryptogram = value;
                case TAG_ATC -> {
                    if (value.length != ATC_LEN) {
                        throw new TlvException("ATC must be " + ATC_LEN + " bytes, was " + value.length);
                    }
                    atc = ((value[0] & 0xFF) << 8) | (value[1] & 0xFF);
                }
                case TAG_UN -> un = value;
                default -> { /* forward compatibility: ignore tags we do not own */ }
            }
        }

        if (cryptogram == null) {
            throw new TlvException("DE 55 is missing tag 9F26 (cryptogram)");
        }
        if (atc == null) {
            throw new TlvException("DE 55 is missing tag 9F36 (ATC)");
        }
        if (un == null) {
            throw new TlvException("DE 55 is missing tag 9F37 (unpredictable number)");
        }
        return new TokenCryptogramTlv(cryptogram, atc, un);
    }

    /** @return the unpredictable number as the uppercase hex string the detokenization API expects. */
    public String unpredictableNumberHex() {
        return Hex.encode(unpredictableNumber);
    }

    public String cryptogramHex() {
        return Hex.encode(cryptogram);
    }

    private static void writeTlv(ByteArrayOutputStream out, int tag, byte[] value) {
        out.write((tag >>> 8) & 0xFF);
        out.write(tag & 0xFF);
        out.write(value.length & 0xFF);
        out.write(value, 0, value.length);
    }

    /** Raised on a malformed DE 55; surfaces as a {@code 96} system-error response code. */
    public static class TlvException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public TlvException(String message) {
            super(message);
        }
    }
}
