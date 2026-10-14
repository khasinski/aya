// Stable PTY protocol and geometry constants, shared with main.
/** POSIX command-not-found status, shared with the renderer. */
export const COMMAND_NOT_FOUND_EXIT_CODE = 127;
/** Same geometry floor in the PTY and its VT mirror. */
export const MIN_PTY_COLS = 4;
export const MIN_PTY_ROWS = 2;
/** Exact legacy protocol error: clients use it to detect unsupported requests. */
export const PTY_HOST_UNKNOWN_REQUEST = "unknown request";
export const CONTROL_SOCKET_NAME = "aya.sock";
export const PTY_HOST_SOCKET_NAME = "pty-host.sock";
export const REMOTE_SOCKET_NAME = "aya-remote.sock";
