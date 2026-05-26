#!/bin/sh
# seed-screenshot.sh — populate a throwaway AYA_HOME with fake projects so
# you can grab a clean screenshot without leaking real project names or
# directory paths. Demo "tabs" run small print-and-sleep scripts so the
# screenshot shows realistic agent output without launching the real CLIs
# (no subscription credits burned, no user prompts leaked).
#
# Usage:
#   ./scripts/seed-screenshot.sh
#   AYA_HOME=/tmp/aya-demo AYA_DEV=1 npm run dev    # then take screenshot
#   rm -rf /tmp/aya-demo /tmp/aya-demo-projects     # cleanup
#
# All fake project directories are created under /tmp/aya-demo-projects so
# aya doesn't trip the "directory not found" modal.

set -e

HOME_DIR="${AYA_HOME:-/tmp/aya-demo}"
PROJECTS_ROOT="/tmp/aya-demo-projects"
SCRIPTS_ROOT="$HOME_DIR/demo-scripts"

rm -rf "$HOME_DIR" "$PROJECTS_ROOT"
mkdir -p "$HOME_DIR/projects" "$PROJECTS_ROOT" "$SCRIPTS_ROOT"

# Create three fake project directories so cwd validation passes.
for name in armillary atlas-api portfolio-site; do
  mkdir -p "$PROJECTS_ROOT/$name"
  git init -q -b main "$PROJECTS_ROOT/$name"
  (cd "$PROJECTS_ROOT/$name" && \
    touch README.md && \
    git -c user.email=demo@aya.dev -c user.name=demo add README.md && \
    git -c user.email=demo@aya.dev -c user.name=demo commit -q -m "init")
done

# Demo "claude" — prints a welcome box + a fake conversation, then idles.
cat > "$SCRIPTS_ROOT/demo-claude.sh" <<'EOF'
#!/bin/sh
clear
printf '\033[38;5;180m✻\033[0m \033[1mWelcome to Claude Code!\033[0m\n'
printf '\033[2m  /help for help, /status for your current setup\033[0m\n'
printf '\033[2m  cwd: /tmp/aya-demo-projects/armillary\033[0m\n\n'
printf '\033[2m> \033[0mthe scanner is dropping symlinked dirs even when follow_symlinks=True. find why.\n\n'
printf '\033[38;5;180m●\033[0m I'\''ll trace the symlink handling. Let me start by reading the scanner module.\n\n'
printf '\033[38;5;180m●\033[0m \033[1mRead\033[0m(\033[35msrc/armillary/scanner.py\033[0m)\n'
printf '  \033[2m⎿  Read 142 lines (ctrl+o to expand)\033[0m\n\n'
printf '\033[38;5;180m●\033[0m Found it. On line 87, \033[35mscanner.py\033[0m calls \033[35mos.walk\033[0m with\n'
printf '  \033[2mfollowlinks=False hard-coded — the constructor flag never propagates.\033[0m\n'
exec sleep infinity
EOF

# Demo "codex" — fake streaming session.
cat > "$SCRIPTS_ROOT/demo-codex.sh" <<'EOF'
#!/bin/sh
clear
printf '\033[38;5;42m◆\033[0m \033[1mOpenAI Codex\033[0m \033[2mv0.27.0 · gpt-5-codex · /tmp/aya-demo-projects/atlas-api\033[0m\n\n'
printf '\033[2muser\033[0m\n'
printf '  add a --since flag to \033[35matlas-api status\033[0m that filters by last commit date\n\n'
printf '\033[38;5;42m◆\033[0m looking at the status command…\n'
exec sleep infinity
EOF

# Demo "shell" — fake pytest output for the first project.
cat > "$SCRIPTS_ROOT/demo-pytest.sh" <<'EOF'
#!/bin/sh
clear
printf '\033[1m$\033[0m pytest tests/\n'
printf '\033[2m============================= test session starts ==============================\033[0m\n'
printf 'collected 24 items\n\n'
printf 'tests/test_scanner.py ............ \033[32m[100%%]\033[0m\n'
printf 'tests/test_models.py   ............ \033[32m[100%%]\033[0m\n\n'
printf '\033[32m============================== 24 passed in 0.42s ==============================\033[0m\n'
exec sleep infinity
EOF

# Demo "shell" — fake vite dev server.
cat > "$SCRIPTS_ROOT/demo-vite.sh" <<'EOF'
#!/bin/sh
clear
printf '\033[1m$\033[0m pnpm dev\n\n'
printf '  \033[1m\033[38;5;42mVITE\033[0m v5.4.21  ready in \033[1m231\033[0m ms\n\n'
printf '  \033[2m➜\033[0m  \033[1mLocal:\033[0m   \033[36mhttp://localhost:5173/\033[0m\n'
printf '  \033[2m➜\033[0m  \033[1mNetwork:\033[0m use --host to expose\n\n'
printf '\033[32m12:42:11 PM\033[0m [vite] hmr update /src/App.tsx\n'
exec sleep infinity
EOF

chmod +x "$SCRIPTS_ROOT"/*.sh

# Project configs — names + paths are demo-safe.
cat > "$HOME_DIR/projects/armillary.json" <<EOF
{
  "name": "armillary",
  "directory": "$PROJECTS_ROOT/armillary",
  "tabs": [
    { "id": "demo-c1", "presetId": "claude-demo", "name": "claude" },
    { "id": "demo-s1", "presetId": "pytest-demo", "name": "pytest" }
  ]
}
EOF

cat > "$HOME_DIR/projects/atlas-api.json" <<EOF
{
  "name": "atlas-api",
  "directory": "$PROJECTS_ROOT/atlas-api",
  "tabs": [
    { "id": "demo-x1", "presetId": "codex-demo", "name": "codex" }
  ]
}
EOF

cat > "$HOME_DIR/projects/portfolio-site.json" <<EOF
{
  "name": "portfolio-site",
  "directory": "$PROJECTS_ROOT/portfolio-site",
  "tabs": [
    { "id": "demo-v1", "presetId": "vite-demo", "name": "vite dev" }
  ]
}
EOF

# Display order matches the design's mockup.
cat > "$HOME_DIR/projects-order.json" <<'EOF'
["armillary", "atlas-api", "portfolio-site"]
EOF

# Presets reference the demo scripts so no real claude/codex are launched.
cat > "$HOME_DIR/presets.json" <<EOF
{
  "presets": [
    { "id": "claude-demo", "name": "Claude Code", "icon": "✻", "color": "#d97757", "command": "$SCRIPTS_ROOT/demo-claude.sh" },
    { "id": "codex-demo",  "name": "Codex",       "icon": "◆", "color": "#10a37f", "command": "$SCRIPTS_ROOT/demo-codex.sh" },
    { "id": "pytest-demo", "name": "Shell",       "icon": "\$", "color": "",        "command": "$SCRIPTS_ROOT/demo-pytest.sh" },
    { "id": "vite-demo",   "name": "Shell",       "icon": "\$", "color": "",        "command": "$SCRIPTS_ROOT/demo-vite.sh" }
  ]
}
EOF

cat <<EOF

Seeded:
  $HOME_DIR
    presets.json, projects/*.json, projects-order.json
    demo-scripts/                  (fake claude/codex/shell output)
  $PROJECTS_ROOT
    armillary/, atlas-api/, portfolio-site/   (initialized git repos)

Launch aya pointing at this home:
  AYA_HOME=$HOME_DIR AYA_DEV=1 npm run dev

Cleanup when done:
  rm -rf $HOME_DIR $PROJECTS_ROOT

EOF
