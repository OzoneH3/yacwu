#!/usr/bin/env bash
# Install Yacwu as a systemd user service ("yacwu"), so it can be restarted
# with `systemctl --user restart yacwu` without stopping running agents:
# backends run as persistent daemons (YACWU_PERSISTENT_BACKENDS=1) in scopes
# of their own, outside the service.
#
# Run it from a shell where `bun run start` works: the service gets this
# shell's PATH, since tool managers (mise, fnm, …) are usually not on
# systemd's default PATH. Re-run it after moving tools or the checkout.
#
#   scripts/install-service.sh            # write the unit and reload systemd
#   systemctl --user enable --now yacwu   # start it (stop any other Yacwu on the port first)
#
# Extra environment (auth, port, backends) can go in
# ~/.config/yacwu/service.env, one VAR=value per line.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="$unit_dir/yacwu.service"

for tool in bun gleam node; do
  command -v "$tool" >/dev/null || { echo "install-service: $tool is not on PATH" >&2; exit 1; }
done

mkdir -p "$unit_dir"
cat >"$unit" <<EOF
[Unit]
Description=Yacwu web UI for Codex and Claude sessions
After=network.target

[Service]
Type=exec
WorkingDirectory=$root
Environment="PATH=$PATH"
Environment=YACWU_INSECURE_SKIP_AUTH=1
Environment=YACWU_PERSISTENT_BACKENDS=1
Environment="YACWU_BACKENDS=claude=node ./scripts/claude-backend.mjs ./claude-codex/dist/src/adapter.mjs"
EnvironmentFile=-%h/.config/yacwu/service.env
ExecStart=$(command -v bun) run start
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
echo "Wrote $unit"
echo "Start it with: systemctl --user enable --now yacwu   (stop any other Yacwu on the same port first)"
