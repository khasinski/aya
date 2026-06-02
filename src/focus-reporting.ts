/** Track whether a full-screen / rich TUI (claude, codex, vim, …) is running in
 *  a terminal by watching for focus-reporting mode (DECSET 1004) in its output:
 *  `ESC [ ? 1004 h` enables it, `ESC [ ? 1004 l` disables it. Those programs
 *  turn it on; a plain shell prompt does not — so it's a reliable, program-
 *  driven signal for gating behavior like the Shift+Enter soft newline.
 *
 *  Given an output chunk and the current state, return the updated state. The
 *  last transition in the chunk wins (a chunk may toggle it more than once). */
// DECSET private mode number for focus reporting (ESC [ ? 1004 h / l).
const FOCUS_REPORTING_MODE = 1004;

export function focusReportingState(chunk: string, current: boolean): boolean {
  let state = current;
  const re = new RegExp("\\x1b\\[\\?" + FOCUS_REPORTING_MODE + "(h|l)", "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(chunk)) !== null) {
    state = match[1] === "h";
  }
  return state;
}
