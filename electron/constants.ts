// Cross-module domain constants shared by otherwise-unrelated main-process
// modules. Values that live here are used from 2+ files that must stay in
// sync; single-module constants belong at the top of their own file.

/** POSIX "command not found / not executable" exit status. Synthesized by the
 *  PTY host when a spawn fails, and emitted by the generated CLI shim when the
 *  real binary is missing - both sides must report the same code or the
 *  renderer's exit-classification drifts. */
export const COMMAND_NOT_FOUND_EXIT_CODE = 127;

/** A quick probe of an external command or local service (the login shell asked for CLIs not on PATH, Ollama's
 *  /api/tags): long enough for a cold disk hit, short enough not to stall a spawn. */
export const COMMAND_PROBE_TIMEOUT_MS = 2_500;

/** `caller.via` of an `aya` call made by Aya's own status hooks (AYA_VIA in the
 *  generated scripts); main skips these when counting CLI adoption (#121). */
export const HOOK_VIA = "hook";

/** Smallest PTY size Aya spawns or resizes to. The vt mirror floors at the
 *  same size, or screen rules would read a different screen than the agent draws. */
export const MIN_PTY_COLS = 4;
export const MIN_PTY_ROWS = 2;

/** The pty host's error for a request type it does not handle. Hosts from older builds send it
 *  verbatim, so clients read it as "this host predates the request", never change it. */
export const PTY_HOST_UNKNOWN_REQUEST = "unknown request";
/** The client's error for a request while it has no host; the renderer's buffer read treats it as an empty pane. */
export const PTY_HOST_NOT_CONNECTED = "PTY host is not connected";

// File and socket names with no env in them: modules the pty host or a test loads early import these, not paths.ts,
// which reads AYA_HOME once at load.
// Claude Code's config dir when a preset names none (CLAUDE_CONFIG_DIR aside).
export const CLAUDE_CONFIG_DIRNAME = ".claude";
// Claude Code's settings file inside a config dir (where the usage hook goes).
export const CLAUDE_SETTINGS_FILENAME = "settings.json";
// Codex's home when neither CODEX_HOME nor a preset names one.
export const CODEX_DIRNAME = ".codex";
// The config file in a Codex home and in a project's .codex dir.
export const CODEX_CONFIG_FILENAME = "config.toml";
export const CONTROL_SOCKET_NAME = "aya.sock";
// Bare name too: the remote bridge script rebuilds the path on the remote host.
export const REMOTE_SOCKET_NAME = "aya-remote.sock";
export const PTY_HOST_SOCKET_NAME = "pty-host.sock";
