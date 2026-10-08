#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

bun install
bun run build

export YACWU_INSECURE_SKIP_AUTH="${YACWU_INSECURE_SKIP_AUTH:-1}"
export YACWU_BACKENDS="${YACWU_BACKENDS-claude=node ./scripts/claude-backend.mjs ./claude-codex/dist/src/adapter.mjs}"

exec bun run start "$@"
