#!/usr/bin/env bash
#
# Build and run every test.
#
# Pins JAVA_HOME to a JDK 17 because the project targets 17 and the Maven on this machine defaults
# to a newer JDK. Compiling with --release 17 under a newer JDK would work, but running the tests
# there would not be testing what ships.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -z "${JAVA_HOME:-}" || ! -x "${JAVA_HOME}/bin/javac" ]]; then
  for candidate in \
      /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
      "$(/usr/libexec/java_home -v 17 2>/dev/null || true)" \
      /usr/lib/jvm/java-17-openjdk-amd64; do
    if [[ -n "$candidate" && -x "$candidate/bin/javac" ]]; then
      export JAVA_HOME="$candidate"
      break
    fi
  done
fi

if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "!! no JDK 17 found. Set JAVA_HOME to one and re-run." >&2
  exit 1
fi

echo "JAVA_HOME=$JAVA_HOME"
"$JAVA_HOME/bin/java" -version
echo

# verify runs surefire (unit) and failsafe (integration) in one pass.
exec mvn "$@" clean verify
