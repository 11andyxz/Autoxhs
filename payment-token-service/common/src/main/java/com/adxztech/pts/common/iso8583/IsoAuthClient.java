package com.adxztech.pts.common.iso8583;

import org.jpos.iso.ISOException;
import org.jpos.iso.ISOMsg;
import org.jpos.iso.ISOPackager;
import org.jpos.iso.channel.ASCIIChannel;

import java.io.IOException;

/**
 * A minimal ISO 8583 client over jPOS's {@link ASCIIChannel} (4-digit ASCII length header).
 *
 * <p>Used by the cert harness, the load driver and the integration tests to drive the switch over a
 * real TCP socket -- not a mocked one. Testing the switch through anything other than its wire
 * protocol would leave the packager and the field-level swap unverified, which is precisely the part
 * that the ISO 8583 claim rests on.
 *
 * <p>One connection per instance, synchronous request/response. That is enough for certification and
 * demo traffic; a production acquirer front-end would multiplex on DE 11.
 */
public final class IsoAuthClient implements AutoCloseable {

    private final ASCIIChannel channel;
    private final ISOPackager packager;

    public IsoAuthClient(String host, int port, int timeoutMillis) throws IOException {
        this.packager = PtsPackager.create();
        this.channel = new ASCIIChannel(host, port, packager);
        this.channel.setTimeout(timeoutMillis);
        this.channel.connect();
    }

    public boolean isConnected() {
        return channel.isConnected();
    }

    /** Sends a request and blocks for the matching response. */
    public ISOMsg send(ISOMsg request) throws IOException, ISOException {
        request.setPackager(packager);
        channel.send(request);
        return channel.receive();
    }

    /** Convenience: build, send, return. */
    public ISOMsg authorize(AuthMessages.AuthRequest request) throws IOException, ISOException {
        return send(AuthMessages.newAuthRequest(request));
    }

    @Override
    public void close() {
        try {
            channel.disconnect();
        } catch (IOException e) {
            // closing a demo client socket: nothing useful to do, and nothing depends on it
        }
    }
}
