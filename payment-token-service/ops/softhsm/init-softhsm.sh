#!/usr/bin/env bash
#
# Create a SoftHSM2 token and the three keys the PKCS#11 key service expects (S7.1).
#
# NOT EXECUTED IN THIS REPOSITORY: SoftHSM2 was not installed on the authoring machine, so this
# script and Pkcs11KeyService are reviewed rather than demonstrated. Said plainly in
# docs/SIMPLIFICATIONS.md rather than left for someone to discover.
#
#   brew install softhsm      # or: apt-get install -y softhsm2 opensc
#   ops/softhsm/init-softhsm.sh
#   java -jar ... --pts.hsm.mode=PKCS11 --pts.hsm.pkcs11.config-path=$PWD/target/softhsm/pkcs11.cfg
set -euo pipefail
cd "$(dirname "$0")/../.."

TOKEN_LABEL="${TOKEN_LABEL:-pts-token}"
SO_PIN="${SO_PIN:-0000}"
USER_PIN="${USER_PIN:-1234}"
OUT_DIR="target/softhsm"

command -v softhsm2-util >/dev/null || { echo "!! softhsm2-util not found" >&2; exit 1; }
command -v pkcs11-tool  >/dev/null || { echo "!! pkcs11-tool not found (install opensc)" >&2; exit 1; }

# Locate the PKCS#11 module: the path differs across Homebrew, Debian and Fedora.
MODULE=""
for candidate in \
    /opt/homebrew/lib/softhsm/libsofthsm2.so \
    /usr/local/lib/softhsm/libsofthsm2.so \
    /usr/lib/softhsm/libsofthsm2.so \
    /usr/lib64/pkcs11/libsofthsm2.so; do
  [[ -f "$candidate" ]] && MODULE="$candidate" && break
done
[[ -n "$MODULE" ]] || { echo "!! could not find libsofthsm2.so" >&2; exit 1; }

mkdir -p "$OUT_DIR/tokens"
export SOFTHSM2_CONF="$PWD/$OUT_DIR/softhsm2.conf"
cat > "$SOFTHSM2_CONF" <<CONF
directories.tokendir = $PWD/$OUT_DIR/tokens
objectstore.backend = file
log.level = INFO
CONF

echo "=== initialising token '$TOKEN_LABEL' ==="
if softhsm2-util --show-slots 2>/dev/null | grep -q "$TOKEN_LABEL"; then
  echo "  (already initialised)"
else
  softhsm2-util --init-token --free --label "$TOKEN_LABEL" --so-pin "$SO_PIN" --pin "$USER_PIN"
fi

# The KEK and the two MAC keys are generated INSIDE the token and never leave it. That is the whole
# point: the application can use them but cannot export them, so a compromised application host does
# not yield the keys. DEKs are different -- they must be extractable under wrap, which is exactly what
# envelope encryption means.
gen_key() {
  local label="$1" type="$2"
  if pkcs11-tool --module "$MODULE" --list-objects --pin "$USER_PIN" 2>/dev/null \
       | grep -q "label:\s*$label"; then
    echo "  key '$label' already present"
    return
  fi
  echo "  generating '$label' ($type, non-extractable, sensitive)"
  pkcs11-tool --module "$MODULE" --login --pin "$USER_PIN" \
      --keygen --key-type "$type" --label "$label" \
      --sensitive --private --usage-wrap --usage-sign
}

echo "=== generating keys ==="
gen_key pts-kek              AES:32   # wraps DEKs; must never leave the token
gen_key pts-cryptogram-key   GENERIC:32
gen_key pts-fingerprint-key  GENERIC:32

cat > "$OUT_DIR/pkcs11.cfg" <<CFG
# SunPKCS11 configuration for the payment-token-service demo.
name = SoftHSM-PTS
library = $MODULE
slotListIndex = 0
attributes(*,CKO_SECRET_KEY,*) = {
  CKA_TOKEN = true
  CKA_SENSITIVE = true
  CKA_EXTRACTABLE = false
}
CFG

cat <<INFO

=== done ===
  SOFTHSM2_CONF   $SOFTHSM2_CONF
  SunPKCS11 cfg   $PWD/$OUT_DIR/pkcs11.cfg
  module          $MODULE

Run a service against it:

  export SOFTHSM2_CONF=$SOFTHSM2_CONF
  java -jar token-provisioning-service/target/token-provisioning-service-1.0.0-SNAPSHOT-exec.jar \\
    --pts.hsm.mode=PKCS11 \\
    --pts.hsm.pkcs11.config-path=$PWD/$OUT_DIR/pkcs11.cfg \\
    --pts.hsm.pkcs11.pin=$USER_PIN

Startup logs 'key service: PKCS11:...' instead of 'JCE-DEV'. Every service in the deployment must
use the SAME token: provisioning seals funding PANs and detokenization opens them.

NOTE: with keys marked non-extractable, DEK generation may be refused in-token. Pkcs11KeyService
falls back to the JVM RNG for DEKs on purpose -- a DEK MUST be extractable under wrap, or envelope
encryption is impossible. The KEK is the key that must never leave.
INFO
