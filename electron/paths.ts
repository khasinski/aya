// Filesystem locations for Aya's config.
//
// Production (packaged Aya.app) and the development build must NOT share
// state — otherwise running `npm run dev` while dogfooding the installed app
// causes electronmon restarts to step on the user's real projects.
//
// AYA_DEV=1 is set by scripts/dev-electron.sh (`env AYA_DEV=1 electronmon .`).
// The packaged app launches with that variable unset and therefore uses the
// canonical ~/.aya/ directory.

import * as path from "node:path";

export { CONTROL_SOCKET_NAME, PTY_HOST_SOCKET_NAME, REMOTE_SOCKET_NAME } from "./pty-core-constants";

import { AYA_HOME } from "./pty-host-paths";
export { AYA_HOME, AYA_DEV_VAR, AYA_DEV_ON, IS_DEV, AYA_HOME_DIRNAME, AYA_DEV_HOME_DIRNAME, PROJECT_AYA_DIRNAME,
  CONTROL_SOCKET_PATH, REMOTE_SOCKET_PATH, PTY_HOST_SOCKET_PATH, OWNER_ONLY_FILE_MODE, SOCKET_FILE_PERMISSIONS } from "./pty-host-paths";
export const IS_E2E_HEADLESS = process.env.AYA_E2E_HEADLESS === "1";
export const IS_E2E_PTY_SHUTDOWN = process.env.AYA_E2E_PTY_SHUTDOWN === "1";
/** E2E only: how long the boot window waits for its project list, to hold the gap where the socket is up and no project is restored. */
export const PROJECTS_STATE_DELAY_MS = Number(process.env.AYA_E2E_PROJECTS_STATE_DELAY_MS) || 0;
/** E2E only: how long Settings > Machines' Save backend waits in main before it saves, to hold the form mid-save. */
export const MACHINES_CONFIGURE_DELAY_MS = Number(process.env.AYA_E2E_MACHINES_CONFIGURE_DELAY_MS) || 0;
/** E2E only: how long main prepares every pane spawn (brief, lookups) before the host hears of it. */
export const SPAWN_PREP_DELAY_MS = Number(process.env.AYA_E2E_SPAWN_PREP_DELAY_MS) || 0;
/** E2E only: how long a team cadence "minute" lasts, so a round test need not wait a real one. */
export const TEAM_MINUTE_MS = Number(process.env.AYA_E2E_TEAM_MINUTE_MS) || 60_000;

export const PROJECTS_DIR = path.join(AYA_HOME, "projects");
export const PRESETS_FILE = path.join(AYA_HOME, "presets.json");
export const SNIPPETS_FILE = path.join(AYA_HOME, "snippets.json");
// Account-wide Claude/Codex usage snapshot, written by a user-configured hook
// (see docs). Aya only reads it — it never fetches anything or touches a token.
export const USAGE_FILE = path.join(AYA_HOME, "usage.json");
export const THEMES_FILE = path.join(AYA_HOME, "themes.json");
export const WINDOW_STATE_FILE = path.join(AYA_HOME, "window-state.json");
export const PROJECTS_STATE_FILE = path.join(AYA_HOME, "projects-state.json");
export const PROJECTS_ORDER_FILE = path.join(AYA_HOME, "projects-order.json");
export const OPEN_PROJECTS_FILE = path.join(AYA_HOME, "open-projects.json");
// The detached pty host's stderr: an error that does end it leaves its stack here instead of in /dev/null.
export const PTY_HOST_STDERR_FILE = path.join(AYA_HOME, "pty-host.stderr.log");
export const CLI_ADOPTION_FILE = path.join(AYA_HOME, "cli-adoption.json");
export const REACHED_AYA_FILE = path.join(AYA_HOME, "reached-aya.json");
export const PANE_LAUNCH_ROLES_FILE = path.join(AYA_HOME, "pane-launch-roles.json");
export const AGENT_BRIEF_FILES_FILE = path.join(AYA_HOME, "agent-brief-files.json");
// Main-process diagnostics (GPU-helper deaths, #79).
export const DIAGNOSTICS_LOG_FILE = path.join(AYA_HOME, "diagnostics.log");

// rwxr-xr-x: the installed CLI and the generated hook scripts.
export const EXECUTABLE_FILE_MODE = 0o755;
