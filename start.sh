#!/usr/bin/env bash
# Build the current version and run it.
#
# With the yacwu user service installed (scripts/install-service.sh), the
# service is (re)started on the fresh build; persistent backends keep their
# running agents. Without it, or with --foreground, the server runs here in
# the foreground as before. Arguments after --foreground go to the server.
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

foreground=0
if [ "${1:-}" = "--foreground" ]; then
  foreground=1
  shift
fi

bun install
bun run build
# Compile the server now: errors stop here, before anything is restarted.
(cd server && gleam build)

export YACWU_PERSISTENT_BACKENDS="${YACWU_PERSISTENT_BACKENDS:-1}"
export YACWU_INSECURE_SKIP_AUTH="${YACWU_INSECURE_SKIP_AUTH:-1}"
export YACWU_BACKENDS="${YACWU_BACKENDS-claude=node ./scripts/claude-backend.mjs ./claude-codex/dist/src/adapter.mjs}"

if [ "$foreground" = 0 ] && systemctl --user cat yacwu >/dev/null 2>&1; then
  # The service has its own environment (see its unit and
  # ~/.config/yacwu/service.env); the exports above apply to --foreground.
  systemctl --user restart yacwu
  port="${PORT:-3000}"
  for _ in $(seq 1 120); do
    if curl -s -o /dev/null -m 2 "http://127.0.0.1:$port/api/hosts"; then
      echo "yacwu service running on port $port with the fresh build"
      exit 0
    fi
    if ! systemctl --user is-active --quiet yacwu; then
      break
    fi
    sleep 1
  done
  echo "yacwu service did not come up; recent log:" >&2
  journalctl --user -u yacwu -n 30 --no-pager >&2 || true
  exit 1
fi

exec bun run start "$@"
