// Filesystem locations for Aya's config.
//
// Production (packaged Aya.app) and the development build must NOT share
// state — otherwise running `npm run dev` while dogfooding the installed app
// causes electronmon restarts to step on the user's real projects.
//
// AYA_DEV=1 is set by package.json's `dev:electron` script via cross-env.
// The packaged app launches with that variable unset and therefore uses the
// canonical ~/.aya/ directory.

import * as os from "node:os";
import * as path from "node:path";

export const IS_DEV = process.env.AYA_DEV === "1";
export const IS_E2E_HEADLESS = process.env.AYA_E2E_HEADLESS === "1";
export const IS_E2E_PTY_SHUTDOWN = process.env.AYA_E2E_PTY_SHUTDOWN === "1";

// AYA_HOME env var lets you point a single launch at an arbitrary config
// directory (e.g. /tmp/aya-demo for screenshots, or a per-task scratch dir).
// When unset we fall back to the dev/prod split.
export const AYA_HOME =
  process.env.AYA_HOME && process.env.AYA_HOME.trim()
    ? path.resolve(process.env.AYA_HOME)
    : path.join(os.homedir(), IS_DEV ? ".aya-dev" : ".aya");

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
export const CONTROL_SOCKET_PATH = path.join(AYA_HOME, "aya.sock");
export const PTY_HOST_SOCKET_PATH = path.join(AYA_HOME, "pty-host.sock");
