// Filesystem locations for Aya's config.
//
// Production (packaged Aya.app) and the development build must NOT share
// state — otherwise running `npm run dev` while dogfooding the installed app
// causes electronmon restarts to step on the user's real projects.
//
// AYA_DEV=1 is set by scripts/dev-electron.sh (`env AYA_DEV=1 electronmon .`).
// The packaged app launches with that variable unset and therefore uses the
// canonical ~/.aya/ directory.

import * as os from "node:os";
import * as path from "node:path";
import { CONTROL_SOCKET_NAME, PTY_HOST_SOCKET_NAME, REMOTE_SOCKET_NAME } from "./constants";

export { CONTROL_SOCKET_NAME, PTY_HOST_SOCKET_NAME, REMOTE_SOCKET_NAME };

// The dev-build switch; the legacy sweep matches the same pair in a process env.
export const AYA_DEV_VAR = "AYA_DEV";
export const AYA_DEV_ON = "1";
export const IS_DEV = process.env[AYA_DEV_VAR] === AYA_DEV_ON;
export const IS_E2E_HEADLESS = process.env.AYA_E2E_HEADLESS === "1";
export const IS_E2E_PTY_SHUTDOWN = process.env.AYA_E2E_PTY_SHUTDOWN === "1";
/** E2E only: how long the boot window waits for its project list, to hold the gap where the socket is up and no project is restored. */
export const PROJECTS_STATE_DELAY_MS = Number(process.env.AYA_E2E_PROJECTS_STATE_DELAY_MS) || 0;
/** E2E only: how long main prepares every pane spawn (brief, lookups) before the host hears of it. */
export const SPAWN_PREP_DELAY_MS = Number(process.env.AYA_E2E_SPAWN_PREP_DELAY_MS) || 0;
/** E2E only: how long a team cadence "minute" lasts, so a round test need not wait a real one. */
export const TEAM_MINUTE_MS = Number(process.env.AYA_E2E_TEAM_MINUTE_MS) || 60_000;

// Home-relative config dirs; the legacy sweep maps a process's env to these too.
export const AYA_HOME_DIRNAME = ".aya";
export const AYA_DEV_HOME_DIRNAME = ".aya-dev";
// A repo's own Aya dir (.aya/project.json, .aya/teams), not the config home.
export const PROJECT_AYA_DIRNAME = ".aya";

// AYA_HOME env var lets you point a single launch at an arbitrary config
// directory (e.g. /tmp/aya-demo for screenshots, or a per-task scratch dir).
// When unset we fall back to the dev/prod split.
export const AYA_HOME =
  process.env.AYA_HOME && process.env.AYA_HOME.trim()
    ? path.resolve(process.env.AYA_HOME)
    : path.join(os.homedir(), IS_DEV ? AYA_DEV_HOME_DIRNAME : AYA_HOME_DIRNAME);

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
export const CONTROL_SOCKET_PATH = path.join(AYA_HOME, CONTROL_SOCKET_NAME);
export const REMOTE_SOCKET_PATH = path.join(AYA_HOME, REMOTE_SOCKET_NAME);
export const PTY_HOST_SOCKET_PATH = path.join(AYA_HOME, PTY_HOST_SOCKET_NAME);
export const CLI_ADOPTION_FILE = path.join(AYA_HOME, "cli-adoption.json");
export const REACHED_AYA_FILE = path.join(AYA_HOME, "reached-aya.json");
export const PANE_LAUNCH_ROLES_FILE = path.join(AYA_HOME, "pane-launch-roles.json");
export const AGENT_BRIEF_FILES_FILE = path.join(AYA_HOME, "agent-brief-files.json");
// Main-process diagnostics (GPU-helper deaths, #79).
export const DIAGNOSTICS_LOG_FILE = path.join(AYA_HOME, "diagnostics.log");

// rw------- (owner-only). Sockets accept unauthenticated local commands /
// remote bridge traffic, and host-registry records name kill targets - none
// of it may be readable/writable by other users. One definition for both.
export const OWNER_ONLY_FILE_MODE = 0o600;
// rwxr-xr-x: the installed CLI and the generated hook scripts.
export const EXECUTABLE_FILE_MODE = 0o755;
export const SOCKET_FILE_PERMISSIONS = OWNER_ONLY_FILE_MODE;
