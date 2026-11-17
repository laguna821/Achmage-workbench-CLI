#!/bin/bash
# What happens to engines in scopes of their own when the gateway's SERVICE unit is restarted or stopped
# (`systemctl --user restart` after an install, prepare-update, logout). A transient test service runs the gateway
# stand-in (fixtures/engine-scope-gateway.mjs), which starts a stubborn engine through the real wrapper.
# Expect: restart → the new run sweeps the engine the old run left; stop → BindsTo stops the engine's scope; no scope left.
# Usage (from the worktree, through ux/run-isolated.sh): bash scripts/engine-scope-unit-check.sh
set -u
SC=/usr/bin/systemctl   # absolute: run-isolated stands in for `systemctl` on PATH; this acts only on its own test unit
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d /var/tmp/wb-unit-check-XXXX)
unit="wb-engine-scope-check-$$.service"
pass=0; fail=0
check() { if [ "$2" = yes ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 ${3:-}"; fail=$((fail+1)); fi; }
alive() { kill -0 "$1" 2>/dev/null && echo yes || echo no; }
engines() { ls /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/ 2>/dev/null | grep -c "^workbench-engine-wb_engine_scope_check_$$-" ; }
/usr/bin/systemd-run --user --quiet --unit="$unit" -p MemoryMax=256M "$(command -v node)" "$here/fixtures/engine-scope-gateway.mjs" "$here/../apps/host/src/resources/engine-scope.ts" "$out"
for i in $(seq 50); do [ -f "$out/log" ] && break; sleep 0.2; done
first=$(sed -n '1s/.*engine=//p' "$out/log")
check "the service's first run started an engine in a scope bound to it ($(sed -n 1p "$out/log"))" "$( [ -n "$first" ] && grep -q "owner=$unit" "$out/log" && alive "$first")"
$SC --user restart "$unit"
for i in $(seq 50); do [ "$(wc -l < "$out/log")" -ge 2 ] && break; sleep 0.2; done
second=$(sed -n '2s/.*engine=//p' "$out/log")
sleep 0.5
check "restart: the new run swept the engine the old run left (old engine $first ended; $(sed -n 2p "$out/log"))" "$( [ "$(alive "$first")" = no ] && grep -q "swept=1" <(sed -n 2p "$out/log") && echo yes)"
check "restart: the new run's engine runs; one engine scope" "$( [ -n "$second" ] && [ "$(alive "$second")" = yes ] && [ "$(engines)" = 1 ] && echo yes)" "scopes=$(engines)"
$SC --user stop "$unit"
sleep 1
check "stop: the engine's scope was stopped with the service (BindsTo); no engine scope left" "$( [ "$(alive "$second")" = no ] && [ "$(engines)" = 0 ] && echo yes)" "alive=$(alive "$second") scopes=$(engines)"
for p in $first $second; do kill -9 "$p" 2>/dev/null; done
$SC --user reset-failed "$unit" 2>/dev/null
rm -rf "$out"
echo "$pass/$((pass+fail)) passed"
[ $fail -eq 0 ]
