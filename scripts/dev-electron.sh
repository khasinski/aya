#!/bin/sh
# Launch the development Electron app with a clean environment.
#
# Aya is routinely developed INSIDE Aya, and a terminal Aya spawns inherits the
# PTY host's environment (see safeEnv in electron/pty.ts). Two of those
# variables break `npm run dev` when it is started from such a terminal:
#
#   ELECTRON_RUN_AS_NODE=1
#       The PTY host is Electron running as plain Node. Inherited, it makes the
#       dev app boot as Node too, so `electron.app` is undefined and startup
#       dies with "Cannot read properties of undefined (reading 'setName')".
#       This must be cleared BEFORE launch — the Electron binary reads it long
#       before any of our JavaScript runs, so it cannot be fixed from inside.
#
#   AYA_HOME
#       An explicit AYA_HOME wins over the AYA_DEV dev/prod split
#       (electron/paths.ts), so the dev build would run against the user's real
#       ~/.aya — same presets, same projects, and critically the same control
#       and PTY-host sockets. That is precisely the state-sharing that
#       paths.ts's header warns about: an electronmon restart would then step
#       on the terminals of the installed app.
#
# The remaining AYA_* variables are per-terminal metadata. Child terminals get
# fresh values from safeEnv regardless, but they are cleared here so nothing in
# the dev app can read a stale id belonging to the parent instance.
set -e

exec env \
  -u ELECTRON_RUN_AS_NODE \
  -u AYA_HOME \
  -u AYA_SOCKET \
  -u AYA_TERMINAL_ID \
  -u AYA_PRESET_ID \
  -u AYA_PROJECT_SLUG \
  -u AYA_PROJECT_DIR \
  AYA_DEV=1 \
  electronmon .
