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

export const AYA_HOME = path.join(
  os.homedir(),
  IS_DEV ? ".aya-dev" : ".aya",
);

export const PROJECTS_DIR = path.join(AYA_HOME, "projects");
export const PRESETS_FILE = path.join(AYA_HOME, "presets.json");
export const THEMES_FILE = path.join(AYA_HOME, "themes.json");
export const WINDOW_STATE_FILE = path.join(AYA_HOME, "window-state.json");
export const PROJECTS_ORDER_FILE = path.join(AYA_HOME, "projects-order.json");
