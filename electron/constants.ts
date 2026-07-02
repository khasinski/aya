// Cross-module domain constants shared by otherwise-unrelated main-process
// modules. Values that live here are used from 2+ files that must stay in
// sync; single-module constants belong at the top of their own file.

/** POSIX "command not found / not executable" exit status. Synthesized by the
 *  PTY host when a spawn fails, and emitted by the generated CLI shim when the
 *  real binary is missing - both sides must report the same code or the
 *  renderer's exit-classification drifts. */
export const COMMAND_NOT_FOUND_EXIT_CODE = 127;

/** How long a quick liveness/availability probe of an external command or
 *  local service may take (`command -v`-style checks before spawning a preset,
 *  harness scans, the Ollama /api/tags reachability probe). Long enough for a
 *  cold disk hit, short enough not to stall spawning noticeably. */
export const COMMAND_PROBE_TIMEOUT_MS = 2_500;
