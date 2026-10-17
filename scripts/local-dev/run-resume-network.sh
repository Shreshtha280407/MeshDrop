#!/usr/bin/env bash
set -euo pipefail
# Linux-only isolated network demonstration. No host interface, route or firewall is changed.
if [[ "${1:-}" != --inside ]]; then
  export MESHDROP_HOST_NETNS
  MESHDROP_HOST_NETNS=$(readlink /proc/self/ns/net)
  exec unshare --user --map-root-user --net -- bash "$0" --inside
fi
if [[ -z "${MESHDROP_HOST_NETNS:-}" || "$(readlink /proc/self/ns/net)" == "$MESHDROP_HOST_NETNS" || "$(id -u)" != 0 ]]; then
  echo 'Refusing network changes outside a private user/network namespace.' >&2
  exit 1
fi
ip link set lo up
ip link add meshdrop-a type dummy
ip address add 10.90.0.2/24 dev meshdrop-a
ip link set meshdrop-a up
ip route add default dev meshdrop-a
export MESHDROP_ISOLATED_NETWORK=1
export WRANGLER_SEND_METRICS=false
run_tmp=$(mktemp -d /tmp/meshdrop-p5-network.XXXXXX)
worker_pid=''
web_pid=''
cleanup() {
  if [[ -n "$worker_pid" ]]; then kill -- "-$worker_pid" 2>/dev/null || true; fi
  if [[ -n "$web_pid" ]]; then kill -- "-$web_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
setsid pnpm --filter @meshdrop/signaling exec wrangler dev --local --ip 127.0.0.1 --port 8787 --persist-to "$run_tmp/worker-state" > "$run_tmp/worker.log" 2>&1 &
worker_pid=$!
setsid pnpm dev:web > "$run_tmp/web.log" 2>&1 &
web_pid=$!
node_modules/.bin/tsx scripts/local-dev/verify-resume.mjs
