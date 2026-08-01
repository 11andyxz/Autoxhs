# =====================================================================================
# One image definition for every service, parameterised by module (S14).
#
# A single Dockerfile rather than eleven near-identical ones: the services differ in their jar and
# their configuration, not in how they are packaged, and eleven copies would drift.
# =====================================================================================

FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src

# Copy poms first so dependency resolution is cached independently of source changes.
COPY pom.xml .
COPY common/pom.xml common/
COPY config-server/pom.xml config-server/
COPY hazelcast-member/pom.xml hazelcast-member/
COPY issuer-simulator/pom.xml issuer-simulator/
COPY token-controls-service/pom.xml token-controls-service/
COPY token-provisioning-service/pom.xml token-provisioning-service/
COPY detokenization-service/pom.xml detokenization-service/
COPY auth-switch-simulator/pom.xml auth-switch-simulator/
COPY issuer-notification-sim/pom.xml issuer-notification-sim/
COPY cert-harness/pom.xml cert-harness/
COPY loadtest/pom.xml loadtest/
COPY integration-tests/pom.xml integration-tests/
RUN mvn -B -q -Poracle dependency:go-offline -DskipTests || true

COPY . .
# -Poracle adds the Oracle JDBC driver, which the default (H2) build leaves out.
# Integration tests are skipped here: they are run by ./build.sh on the developer's machine and in
# CI, and re-running them inside every image build would multiply the time by eleven.
RUN mvn -B -q -Poracle -DskipTests package

FROM eclipse-temurin:17-jre
ARG MODULE
ENV MODULE=${MODULE}
WORKDIR /app

RUN mkdir -p /var/log/pts && \
    useradd --system --uid 10001 pts && \
    chown -R pts:pts /app /var/log/pts
USER pts

COPY --from=build --chown=pts:pts /src/${MODULE}/target/${MODULE}-1.0.0-SNAPSHOT-exec.jar /app/app.jar
COPY --from=build --chown=pts:pts /src/config /app/config

# JAVA_OPTS is unquoted on purpose: it carries a flag list, and the tuned overlay replaces it wholesale.
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/app.jar"]
