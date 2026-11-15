#!/bin/bash
# Run a command on a NEW private D-Bus with a private gnome-keyring unlocked with a random made-up
# password (never the desktop's bus or the person's keyring). For checks that use the app's real
# vault helper, e.g.: SMOKE_SECRET_BIN=<built binary> scripts/with-private-keyring.sh node scripts/credential-smoke.ts
set -uo pipefail
if [ -z "${WB_PRIVATE_KEYRING:-}" ]; then
  S=$(mktemp -d "${TMPDIR:-/var/tmp}/wb-keyring-XXXXXX"); mkdir -p "$S/data/keyrings" "$S/config" "$S/runtime" "$S/control"; chmod -R 700 "$S"
  env -u DBUS_SESSION_BUS_ADDRESS -u GNOME_KEYRING_CONTROL -u SSH_AUTH_SOCK -u DISPLAY -u WAYLAND_DISPLAY \
    XDG_DATA_HOME="$S/data" XDG_CONFIG_HOME="$S/config" XDG_RUNTIME_DIR="$S/runtime" WB_PRIVATE_KEYRING="$S" \
    dbus-run-session -- "$0" "$@"
  code=$?; rm -rf -- "$S"; exit $code
fi
case "${DBUS_SESSION_BUS_ADDRESS:-}" in ""|*"/run/user/"*) echo "ABORT: not a private bus" >&2; exit 3;; esac
head -c 24 /dev/urandom | base64 | gnome-keyring-daemon --foreground --unlock --components=secrets --control-directory "$WB_PRIVATE_KEYRING/control" >/dev/null 2>&1 &
keyring=$!
for _ in $(seq 50); do gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets 2>/dev/null | grep -q true && break; sleep 0.1; done
"$@"; code=$?
kill "$keyring" 2>/dev/null; wait "$keyring" 2>/dev/null
exit $code
