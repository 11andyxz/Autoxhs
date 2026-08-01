package com.adxztech.pts.authswitch;

import com.adxztech.pts.common.iso8583.PtsPackager;
import org.jpos.iso.ISOServer;
import org.jpos.iso.channel.ASCIIChannel;
import org.jpos.util.ThreadPool;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * Runs the jPOS {@link ISOServer} for the lifetime of the Spring context (S6.2).
 *
 * <p>A {@link SmartLifecycle} rather than an {@code ApplicationRunner}: the socket must be listening
 * before the context is considered started and closed cleanly on shutdown, otherwise integration tests
 * race the listener and a redeploy leaks the port.
 *
 * <p>{@link ASCIIChannel} frames each message with a 4-digit ASCII length header, which is what the test
 * client and the cert harness speak. Real acquirer links use whatever the network specifies; the framing
 * is a channel concern and the packager above it is unaffected.
 */
@Component
public class IsoServerRunner implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(IsoServerRunner.class);

    private final AuthSwitchProperties properties;
    private final TokenAuthRequestListener listener;

    private volatile ISOServer server;
    private volatile ThreadPool pool;
    private volatile Thread serverThread;
    private volatile boolean running;

    public IsoServerRunner(AuthSwitchProperties properties, TokenAuthRequestListener listener) {
        this.properties = properties;
        this.listener = listener;
    }

    @Override
    public synchronized void start() {
        if (running) {
            return;
        }
        try {
            ASCIIChannel channel = new ASCIIChannel(PtsPackager.create());
            channel.setTimeout(properties.getSocketTimeoutMillis());

            pool = new ThreadPool(properties.getMinThreads(), properties.getMaxThreads(), "pts-iso");
            server = new ISOServer(properties.getIsoPort(), channel, pool);
            server.addISORequestListener(listener);

            serverThread = new Thread(server, "iso-8583-server");
            serverThread.setDaemon(true);
            serverThread.start();

            running = true;
            log.info("ISO 8583 server listening on port {} (ASCII channel, {} max threads)",
                    properties.getIsoPort(), properties.getMaxThreads());
        } catch (Exception e) {
            throw new IllegalStateException(
                    "cannot start the ISO 8583 server on port " + properties.getIsoPort(), e);
        }
    }

    @Override
    public synchronized void stop() {
        if (!running) {
            return;
        }
        running = false;
        try {
            if (server != null) {
                server.shutdown();
            }
        } finally {
            if (pool != null) {
                pool.close();
            }
            if (serverThread != null) {
                serverThread.interrupt();
            }
            log.info("ISO 8583 server on port {} stopped", properties.getIsoPort());
        }
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    /** Start late and stop early relative to the web tier, so the socket never outlives its dependencies. */
    @Override
    public int getPhase() {
        return Integer.MAX_VALUE - 100;
    }

    public int port() {
        return properties.getIsoPort();
    }

    public int connectionCount() {
        return server == null ? 0 : server.getConnectionCount();
    }
}
