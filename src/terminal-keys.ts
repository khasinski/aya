/** What the Enter key should do in a terminal, given its modifiers and the
 *  terminal's state. Pure, so the decision can be tested without xterm.
 *
 *  - "restart": bare Shift+Enter on a cleanly-exited terminal re-spawns it.
 *  - "soft-newline": Shift+Enter or Option+Enter while a rich TUI (claude,
 *    codex…) is running — insert a newline (sent as meta-Enter, ESC+CR) instead
 *    of submitting.
 *  - "submit": Shift+Enter or Option+Enter at a plain shell prompt — send a
 *    normal CR. Needed because xterm sends a bare CR for Shift+Enter anyway, but
 *    macOptionIsMeta would otherwise turn Option+Enter into meta-Enter (a zsh
 *    multiline edit); both should just submit at the shell, like iTerm.
 *  - "default": everything else — let xterm send its normal key.
 *
 *  Restart takes precedence; Cmd/Ctrl combinations are left to xterm. */
export type EnterAction = "restart" | "soft-newline" | "submit" | "default";

export interface EnterKeyState {
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  /** Terminal exited cleanly (code 0) and can be restarted. */
  canRestart: boolean;
  /** A rich TUI is running (focus-reporting active). */
  richInput: boolean;
}

export function enterKeyAction(s: EnterKeyState): EnterAction {
  if (s.meta || s.ctrl) return "default";
  if (!s.shift && !s.alt) return "default";
  // Bare Shift+Enter on an exited terminal restarts it.
  if (s.shift && !s.alt && s.canRestart) return "restart";
  // Shift/Option+Enter: soft newline in a rich TUI, plain submit at the shell.
  return s.richInput ? "soft-newline" : "submit";
}

/** The bytes meta-Enter sends — ESC + CR — which claude/codex and zsh's zle
 *  treat as "insert a newline" rather than submit. */
export const META_ENTER = "\x1b\r";
