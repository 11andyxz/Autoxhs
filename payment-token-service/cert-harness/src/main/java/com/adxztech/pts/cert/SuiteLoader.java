package com.adxztech.pts.cert;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Loads a suite from the filesystem or the classpath.
 *
 * <p>Unknown YAML properties are a hard failure. A typo in a suite file must not silently drop an
 * assertion -- a certification suite that quietly asserts less than it appears to is the worst possible
 * outcome for this component.
 *
 * <p><b>The YAML mapper is constructed here, not injected.</b> Exposing a YAML-configured
 * {@code ObjectMapper} as a bean makes it <em>the</em> application mapper: Boot's Jackson
 * auto-configuration backs off, and every HTTP response then gets serialised as YAML while still
 * advertising {@code application/json}. Reading suite files is an internal concern of this class, so the
 * mapper stays inside it.
 */
public class SuiteLoader {

    private final ObjectMapper yamlMapper;

    public SuiteLoader() {
        this.yamlMapper = new ObjectMapper(new YAMLFactory())
                .findAndRegisterModules()
                .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true);
    }

    public CertSuite load(String location) {
        try {
            Path path = Path.of(location);
            if (Files.exists(path)) {
                return yamlMapper.readValue(Files.readString(path), CertSuite.class);
            }
            String classpathLocation = location.startsWith("/") ? location : "/" + location;
            try (InputStream in = SuiteLoader.class.getResourceAsStream(classpathLocation)) {
                if (in == null) {
                    throw new IllegalArgumentException(
                            "certification suite not found on disk or classpath: " + location);
                }
                return yamlMapper.readValue(in, CertSuite.class);
            }
        } catch (IOException e) {
            throw new IllegalArgumentException("cannot read certification suite " + location, e);
        }
    }
}
