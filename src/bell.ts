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

// Hot path: every PTY data chunk is analyzed several times per event — the
// reducer checks approval AND busy, then App's timeline handler checks approval
// again, all on the SAME chunk string. Single-entry memos collapse that to one
// real strip (3 regex passes) and one approval-pattern scan per chunk instead
// of three strips (9 passes) and two scans. Pure-function semantics unchanged.
let lastStripInput: string | null = null;
let lastStripOutput = "";
let lastApprovalInput: string | null = null;
let lastApprovalResult = false;

function stripAnsi(s: string): string {
  // Drop CSI / OSC / DCS escape sequences the screen repaint cycle emits.
  // DUPLICATE: a near-identical copy lives in electron/pty.ts (main process).
  // Keep the escape-sequence rules in sync — the only intended difference is
  // that pty.ts also strips stray control chars (for readable search snippets).
  if (s === lastStripInput) return lastStripOutput;
  const stripped = s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // DCS / PM / APC / SOS before OSC (so OSC can't steal a DCS string's ST);
    // OSC terminated by BEL or ST (matching only BEL leaked ST-OSC payloads).
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
  lastStripInput = s;
  lastStripOutput = stripped;
  return stripped;
}

export function detectApproval(chunk: string): boolean {
  if (chunk === lastApprovalInput) return lastApprovalResult;
  const text = stripAnsi(chunk);
  const result = APPROVAL_PATTERNS.some((re) => re.test(text));
  lastApprovalInput = chunk;
  lastApprovalResult = result;
  return result;
}

// "Active output" — large chunks of new content with no approval signal — is a
// signal that the agent is busy working, not waiting. Use length as a cheap
// proxy after stripping ANSI.
export function looksBusy(chunk: string): boolean {
  return stripAnsi(chunk).trim().length > BUSY_OUTPUT_MIN_LENGTH;
}
