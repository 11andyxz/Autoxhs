package com.adxztech.pts.common.iso8583;

import com.adxztech.pts.common.util.Hex;
import org.jpos.iso.ISOMsg;
import org.jpos.iso.packager.GenericPackager;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The ISO 8583 layer: TLV codec, DE 48 markers, and a real pack/unpack round trip through the
 * project's packager (S6.2).
 *
 * <p>The round-trip test matters more than it looks: it is the only thing that proves the packager XML
 * actually describes the fields the switch sets. A wrong field class there produces messages that
 * unpack into garbage at the far end of a socket, which is painful to debug in an integration test.
 */
class Iso8583CodecTest {

    @Nested
    class TlvSpec {

        private final byte[] cryptogram = Hex.decode("0011223344556677");
        private final byte[] un = Hex.decode("A1B2C3D4");

        @Test
        @DisplayName("encodes and decodes cryptogram, ATC and UN")
        void roundTrip() {
            TokenCryptogramTlv tlv = new TokenCryptogramTlv(cryptogram, 41, un);
            TokenCryptogramTlv decoded = TokenCryptogramTlv.decode(tlv.encode());
            assertThat(decoded.cryptogram()).isEqualTo(cryptogram);
            assertThat(decoded.atc()).isEqualTo(41);
            assertThat(decoded.unpredictableNumber()).isEqualTo(un);
            assertThat(decoded.cryptogramHex()).isEqualTo("0011223344556677");
            assertThat(decoded.unpredictableNumberHex()).isEqualTo("A1B2C3D4");
        }

        @Test
        @DisplayName("hex round trip matches the ASCII DE 55 wire form")
        void hexRoundTrip() {
            TokenCryptogramTlv tlv = new TokenCryptogramTlv(cryptogram, 1, un);
            String hex = tlv.encodeHex();
            // 9F26 08 <8 bytes> 9F36 02 <2> 9F37 04 <4> = 3+8 + 3+2 + 3+4 = 23 bytes = 46 hex chars
            assertThat(hex).hasSize(46).startsWith("9F2608");
            assertThat(TokenCryptogramTlv.decodeHex(hex).atc()).isEqualTo(1);
        }

        @Test
        @DisplayName("encodes the ATC as two big-endian bytes across the whole range")
        void atcEncoding() {
            for (int atc : new int[]{0, 1, 255, 256, 4095, 65535}) {
                TokenCryptogramTlv tlv = new TokenCryptogramTlv(cryptogram, atc, un);
                assertThat(TokenCryptogramTlv.decode(tlv.encode()).atc()).isEqualTo(atc);
            }
        }

        @Test
        @DisplayName("skips unknown tags so a token-aware issuer can add its own TLVs")
        void forwardCompatible() {
            byte[] base = new TokenCryptogramTlv(cryptogram, 7, un).encode();
            byte[] extended = new byte[base.length + 5];
            System.arraycopy(base, 0, extended, 0, base.length);
            // 9F1E (IFD serial number) with a 2-byte value the parser has no opinion about
            extended[base.length] = (byte) 0x9F;
            extended[base.length + 1] = (byte) 0x1E;
            extended[base.length + 2] = 0x02;
            extended[base.length + 3] = 0x12;
            extended[base.length + 4] = 0x34;
            assertThat(TokenCryptogramTlv.decode(extended).atc()).isEqualTo(7);
        }

        @Test
        @DisplayName("rejects malformed, truncated and incomplete TLV rather than guessing")
        void rejectsMalformed() {
            assertThatThrownBy(() -> TokenCryptogramTlv.decode(new byte[0]))
                    .isInstanceOf(TokenCryptogramTlv.TlvException.class);
            assertThatThrownBy(() -> TokenCryptogramTlv.decode(null))
                    .isInstanceOf(TokenCryptogramTlv.TlvException.class);
            // tag present, length claims more bytes than exist
            assertThatThrownBy(() -> TokenCryptogramTlv.decode(Hex.decode("9F26FF00")))
                    .isInstanceOf(TokenCryptogramTlv.TlvException.class)
                    .hasMessageContaining("runs past end");
            // only the cryptogram: ATC and UN missing
            assertThatThrownBy(() -> TokenCryptogramTlv.decode(Hex.decode("9F26080011223344556677")))
                    .isInstanceOf(TokenCryptogramTlv.TlvException.class)
                    .hasMessageContaining("9F36");
            assertThatThrownBy(() -> TokenCryptogramTlv.decodeHex("not hex"))
                    .isInstanceOf(TokenCryptogramTlv.TlvException.class);
            assertThatThrownBy(() -> TokenCryptogramTlv.decodeHex(null))
                    .isInstanceOf(TokenCryptogramTlv.TlvException.class);
        }

        @Test
        @DisplayName("rejects wrong field widths at construction")
        void validatesWidths() {
            assertThatThrownBy(() -> new TokenCryptogramTlv(new byte[7], 1, un))
                    .isInstanceOf(TokenCryptogramTlv.TlvException.class);
            assertThatThrownBy(() -> new TokenCryptogramTlv(cryptogram, 1, new byte[3]))
                    .isInstanceOf(TokenCryptogramTlv.TlvException.class);
            assertThatThrownBy(() -> new TokenCryptogramTlv(cryptogram, 0x10000, un))
                    .isInstanceOf(TokenCryptogramTlv.TlvException.class);
        }

        @Test
        @DisplayName("an ATC declared with the wrong length is rejected")
        void rejectsWrongAtcLength() {
            // 9F36 with a 1-byte value
            assertThatThrownBy(() -> TokenCryptogramTlv.decode(
                    Hex.decode("9F26080011223344556677" + "9F360101" + "9F3704A1B2C3D4")))
                    .isInstanceOf(TokenCryptogramTlv.TlvException.class)
                    .hasMessageContaining("ATC must be 2 bytes");
        }
    }

    @Nested
    class De48Spec {

        @Test
        @DisplayName("round trips requestor, domain and trace markers")
        void roundTrip() {
            De48Markers markers = De48Markers.builder()
                    .requestorId("40010030001")
                    .domainType("ECOM")
                    .traceId("abc123")
                    .tokenLast4("4822")
                    .build();
            String encoded = markers.encode();
            assertThat(encoded).isEqualTo("TRID=40010030001;DOM=ECOM;TRACE=abc123;TL4=4822");

            De48Markers parsed = De48Markers.parse(encoded);
            assertThat(parsed.requestorId()).isEqualTo("40010030001");
            assertThat(parsed.domainType()).isEqualTo("ECOM");
            assertThat(parsed.traceId()).isEqualTo("abc123");
            assertThat(parsed.get("TL4")).isEqualTo("4822");
        }

        @Test
        @DisplayName("tolerates junk rather than declining an authorization over a marker field")
        void tolerantParsing() {
            De48Markers parsed = De48Markers.parse("TRID=400;;garbage;=novalue;DOM=ECOM");
            assertThat(parsed.requestorId()).isEqualTo("400");
            assertThat(parsed.domainType()).isEqualTo("ECOM");
        }

        @Test
        @DisplayName("empty and null inputs produce an empty marker set")
        void emptyInputs() {
            assertThat(De48Markers.parse(null).values()).isEmpty();
            assertThat(De48Markers.parse("").values()).isEmpty();
            assertThat(De48Markers.builder().build().encode()).isEmpty();
        }

        @Test
        @DisplayName("builder drops blank values instead of emitting empty markers")
        void builderDropsBlanks() {
            assertThat(De48Markers.builder().requestorId(null).domainType("  ").build().encode())
                    .isEmpty();
        }
    }

    @Nested
    class PackagerSpec {

        @Test
        @DisplayName("a fully populated 0100 packs and unpacks with every field intact")
        void authRequestRoundTrip() throws Exception {
            GenericPackager packager = PtsPackager.create();
            TokenCryptogramTlv tlv = new TokenCryptogramTlv(
                    Hex.decode("0011223344556677"), 41, Hex.decode("A1B2C3D4"));
            De48Markers markers = De48Markers.builder()
                    .requestorId("40010030001").domainType("ECOM").build();

            ISOMsg request = AuthMessages.newAuthRequest(new AuthMessages.AuthRequest(
                    "4999600000004822", "3112", 4999L, "123456", "840",
                    "TERM0001", "12345678901", "000000", tlv, markers));
            request.setPackager(packager);
            byte[] wire = request.pack();

            // Wire form must be printable ASCII -- this is an ASCII-format network.
            assertThat(new String(wire, StandardCharsets.US_ASCII)).startsWith("0100");

            ISOMsg unpacked = new ISOMsg();
            unpacked.setPackager(packager);
            unpacked.unpack(wire);

            assertThat(unpacked.getMTI()).isEqualTo("0100");
            assertThat(unpacked.getString(IsoFields.DE_PAN)).isEqualTo("4999600000004822");
            assertThat(unpacked.getString(IsoFields.DE_AMOUNT)).isEqualTo("000000004999");
            assertThat(unpacked.getString(IsoFields.DE_STAN)).isEqualTo("123456");
            assertThat(unpacked.getString(IsoFields.DE_EXPIRY)).isEqualTo("3112");
            assertThat(unpacked.getString(IsoFields.DE_TERMINAL_ID)).isEqualTo("TERM0001");
            assertThat(unpacked.getString(IsoFields.DE_CURRENCY)).isEqualTo("840");
            assertThat(unpacked.getString(IsoFields.DE_PRIVATE_USE))
                    .isEqualTo("TRID=40010030001;DOM=ECOM");

            // The cryptogram survives the ASCII hex rendering of DE 55.
            TokenCryptogramTlv decoded =
                    TokenCryptogramTlv.decodeHex(unpacked.getString(IsoFields.DE_ICC_DATA));
            assertThat(decoded.atc()).isEqualTo(41);
            assertThat(decoded.cryptogramHex()).isEqualTo("0011223344556677");
        }

        @Test
        @DisplayName("the 0110 response preserves the trace fields an acquirer matches on")
        void authResponsePreservesTraceFields() throws Exception {
            GenericPackager packager = PtsPackager.create();
            ISOMsg request = AuthMessages.newAuthRequest(new AuthMessages.AuthRequest(
                    "4999600000004822", "3112", 250L, "000777", "840",
                    "TERM0002", null, "000000", null, null));
            request.setPackager(packager);

            ISOMsg response = AuthMessages.newAuthResponse(request, IsoFields.RC_APPROVED, "AUTH01");
            response.setPackager(packager);
            ISOMsg reparsed = new ISOMsg();
            reparsed.setPackager(packager);
            reparsed.unpack(response.pack());

            assertThat(reparsed.getMTI()).isEqualTo("0110");
            assertThat(AuthMessages.responseCode(reparsed)).isEqualTo("00");
            assertThat(reparsed.getString(IsoFields.DE_STAN)).isEqualTo("000777");
            assertThat(reparsed.getString(IsoFields.DE_AMOUNT)).isEqualTo("000000000250");
            assertThat(reparsed.getString(38)).isEqualTo("AUTH01");
        }

        @Test
        @DisplayName("swapping DE 2 to a funding PAN of a different length re-packs correctly")
        void de2SwapAcrossLengths() throws Exception {
            // DE 2 is IFA_LLNUM: a 16-digit token replaced by a 15-digit funding PAN changes the
            // field's length prefix. If the packager got this wrong the issuer would see a corrupt PAN.
            GenericPackager packager = PtsPackager.create();
            ISOMsg msg = AuthMessages.newAuthRequest(new AuthMessages.AuthRequest(
                    "4999600000004822", "3112", 100L, "000001", "840", "T", null, "000000", null, null));
            msg.setPackager(packager);
            msg.set(IsoFields.DE_PAN, "340000000000009");

            ISOMsg reparsed = new ISOMsg();
            reparsed.setPackager(packager);
            reparsed.unpack(msg.pack());
            assertThat(reparsed.getString(IsoFields.DE_PAN)).isEqualTo("340000000000009");
        }
    }
}
