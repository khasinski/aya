// Config home and socket paths owned by the detached PTY core.
import * as os from "node:os";
import * as path from "node:path";
import { CONTROL_SOCKET_NAME, PTY_HOST_SOCKET_NAME, REMOTE_SOCKET_NAME } from "./pty-core-constants";
// The dev-build switch; the legacy sweep matches the same pair in a process env.
export const AYA_DEV_VAR = "AYA_DEV";
export const AYA_DEV_ON = "1";
export const IS_DEV = process.env[AYA_DEV_VAR] === AYA_DEV_ON;
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


export const CONTROL_SOCKET_PATH = path.join(AYA_HOME, CONTROL_SOCKET_NAME);
export const REMOTE_SOCKET_PATH = path.join(AYA_HOME, REMOTE_SOCKET_NAME);
export const PTY_HOST_SOCKET_PATH = path.join(AYA_HOME, PTY_HOST_SOCKET_NAME);
export const PTY_HANDOVER_CORE_DIRECTORY = path.join(AYA_HOME, "pty-handover-core");
export const PTY_HANDOVER_DISPLAY_DIRECTORY = path.join(AYA_HOME, "pty-handover-display");
export const PTY_HANDOVER_TICKET_PATH = path.join(AYA_HOME, "pty-handover.json");
// rw------- (owner-only). Sockets accept unauthenticated local commands /
// remote bridge traffic, and host-registry records name kill targets - none
// of it may be readable/writable by other users. One definition for both.
export const OWNER_ONLY_FILE_MODE = 0o600;
export const SOCKET_FILE_PERMISSIONS = OWNER_ONLY_FILE_MODE;
