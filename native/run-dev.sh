#!/bin/bash
# Build and run the native Swift Aya experiment against an ISOLATED backend.
#
# - AYA_HOME defaults to ~/.aya-native (own host, own config, own sessions) so
#   testing can never touch your real ~/.aya terminals. Override to share a
#   backend with another instance:  AYA_HOME=~/.aya-dev native/run-dev.sh
# - The PTY host is the regular Aya backend (dist-electron/pty-host.js) run
#   under plain node; it outlives the app, so sessions survive app restarts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# DELIBERATELY ignore inherited AYA_HOME: shells inside Aya terminals export
# it pointing at the LIVE ~/.aya, and inheriting it here once made this script
# fight the user's real PTY host. Opt into a different home explicitly with
# AYA_NATIVE_HOME.
AYA_HOME="${AYA_NATIVE_HOME:-$HOME/.aya-native}"
export AYA_HOME

# Refuse the live home outright - the experiment must never share ~/.aya.
if [ "$AYA_HOME" = "$HOME/.aya" ]; then
  echo "refusing to run against the live ~/.aya - use a separate AYA_NATIVE_HOME" >&2
  exit 1
fi

# Unix socket paths cap at ~104 bytes.
if [ "${#AYA_HOME}" -gt 80 ]; then
  echo "AYA_NATIVE_HOME is too long for a unix socket path: $AYA_HOME" >&2
  exit 1
fi

# 1. Backend build (only if missing - `npm run build:electron` to refresh).
if [ ! -f "$REPO_ROOT/dist-electron/pty-host.js" ]; then
  echo "==> building electron backend (dist-electron)"
  (cd "$REPO_ROOT" && npm run build:electron)
fi

# 2. Seed an isolated config on first run.
mkdir -p "$AYA_HOME/projects"
if [ ! -f "$AYA_HOME/presets.json" ]; then
  cat > "$AYA_HOME/presets.json" <<'EOF'
{
  "presets": [
    { "id": "shell",  "name": "Shell",  "icon": "$", "command": "$SHELL" },
    { "id": "claude", "name": "Claude", "icon": "✻", "color": "#d97757", "command": "claude", "agent": "claude" },
    { "id": "codex",  "name": "Codex",  "icon": "◆", "color": "#10a37f", "command": "codex", "agent": "codex" }
  ]
}
EOF
fi
if [ -z "$(ls -A "$AYA_HOME/projects" 2>/dev/null)" ]; then
  cat > "$AYA_HOME/projects/playground.json" <<EOF
{
  "name": "playground",
  "directory": "$HOME",
  "tabs": [
    { "id": "pg-shell-1", "presetId": "shell", "name": "Shell 1" },
    { "id": "pg-shell-2", "presetId": "shell", "name": "Shell 2" },
    { "id": "pg-claude",  "presetId": "claude", "name": "Claude" }
  ]
}
EOF
fi

# 3. Start the host if this AYA_HOME doesn't have a live one. Probe with a
# real protocol handshake (nc -zU false-negatives on macOS); NEVER delete the
# socket file here - a live host owns it, and a fresh host rmSyncs a stale one
# itself before binding.
if env -u ELECTRON_RUN_AS_NODE node -e '
  const net = require("net");
  const s = net.connect(process.argv[1]);
  s.on("connect", () => process.exit(0));
  s.on("error", () => process.exit(1));
  setTimeout(() => process.exit(1), 1500);
' "$AYA_HOME/pty-host.sock" 2>/dev/null; then
  echo "==> reusing live pty host at $AYA_HOME/pty-host.sock"
else
  echo "==> starting pty host for $AYA_HOME"
  env -u ELECTRON_RUN_AS_NODE node "$REPO_ROOT/dist-electron/pty-host.js" \
    >> "$AYA_HOME/pty-host.out.log" 2>&1 &
  for _ in $(seq 1 100); do
    [ -S "$AYA_HOME/pty-host.sock" ] && break
    sleep 0.05
  done
fi

# 4. Build and run the app.
echo "==> building AyaNative (swift)"
cd "$REPO_ROOT/native"
swift build -c release 2>&1 | tail -3
echo "==> launching (AYA_HOME=$AYA_HOME)"
exec env -u ELECTRON_RUN_AS_NODE "$(swift build -c release --show-bin-path)/AyaNative"
