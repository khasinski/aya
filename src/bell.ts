// Heuristic detection of "agent waiting for approval" in PTY output.
//
// This is best-effort — claude code's TUI repaints constantly with control
// sequences, so we strip ANSI escapes first, then look for distinctive
// approval-prompt strings. Imperfect but correct for the common case where the
// agent literally renders the approval box on screen.

// Min stripped char-count for a chunk to be treated as "busy output".
const BUSY_OUTPUT_MIN_LENGTH = 64;

const APPROVAL_PATTERNS: RegExp[] = [
  /Do you want to/i,
  /Do you want me to/i,
  /❯\s*1\.\s*Yes/i,
  /1\)\s*Yes,\s*and don't/i,
  /Approve\s*(this\s+)?(edit|change|action|tool|command)/i,
  /\bAccept all\b.*\bReject all\b/i,
  /Run this command\?\s*\[Y\/N\]/i,
];

// Once an approval is showing, the next non-approval chunk should clear it.
// We DON'T just look for "no approval text" because the agent may repaint
// the same approval box with different cursor positions.

function stripAnsi(s: string): string {
  // Drop CSI / OSC / DCS escape sequences the screen repaint cycle emits.
  // DUPLICATE: a near-identical copy lives in electron/pty.ts (main process).
  // Keep the escape-sequence rules in sync — the only intended difference is
  // that pty.ts also strips stray control chars (for readable search snippets).
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // DCS / PM / APC / SOS before OSC (so OSC can't steal a DCS string's ST);
    // OSC terminated by BEL or ST (matching only BEL leaked ST-OSC payloads).
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
}

export function detectApproval(chunk: string): boolean {
  const text = stripAnsi(chunk);
  return APPROVAL_PATTERNS.some((re) => re.test(text));
}

// "Active output" — large chunks of new content with no approval signal — is a
// signal that the agent is busy working, not waiting. Use length as a cheap
// proxy after stripping ANSI.
export function looksBusy(chunk: string): boolean {
  return stripAnsi(chunk).trim().length > BUSY_OUTPUT_MIN_LENGTH;
}
