// Parses Aya's OSC 9001 signal vocabulary (see integrations.md) out of raw PTY
// output. A cooperating TUI (or a wrapper script) can emit
// `ESC ]9001;aya.<key>=<value> BEL` to hand Aya a structured signal - the
// "explicit status" channel, the agent's own word next to what its screen shows
// (electron/vt-state.ts).
//
// Sequences are always stripped from the byte stream before it reaches
// xterm.js: whether or not Aya recognizes/consumes a given key, an agent's
// visible output must never leak escape-sequence noise.

// Only sequences beginning with an exact supported introducer are ever held
// back across a chunk boundary. Bounding the carry to our own namespaced prefix
// (or the open OSC 7501 Program Status Escape Sequence specification) means an
// unrelated program's use of OSC 9001 (collision risk called out in
// integrations.md) is never mistaken for a truncated Aya sequence and is left
// untouched in the output.
const AYA_OSC_INTRODUCER = "\x1b]9001;aya.";
const PROGRAM_STATUS_OSC_INTRODUCER = "\x1b]7501;";
const OSC_INTRODUCERS = [AYA_OSC_INTRODUCER, PROGRAM_STATUS_OSC_INTRODUCER];
export const PROGRAM_STATUS_OSC_KEY = "program-status";

// Guards against an unterminated (malformed, or truncated by a misbehaving
// process) sequence growing the carry buffer forever. Comfortably larger than
// any real vocabulary value (see integrations.md's key list) plus key name.
const MAX_CARRY_LENGTH = 4096;

// `aya.<key>=<value>` or `OSC 7501;<payload>` terminated by BEL or ST (ESC \\).
// Value excludes BEL/ESC so a truncated terminator can never be swallowed into it.
const AYA_OSC_RE = /\x1b\](?:9001;aya\.([a-zA-Z][a-zA-Z0-9_-]*)=([^\x07\x1b]*)|7501;([^\x07\x1b]*))(?:\x07|\x1b\\)/g;

export interface AyaOscEvent {
  key: string;
  value: string;
}

export interface OscExtractResult {
  /** Chunk with every complete + held-back Aya OSC 9001 / 7501 sequence removed. */
  cleaned: string;
  /** Structured events parsed from any complete sequences in this call. */
  events: AyaOscEvent[];
  /** Held-back partial sequence to prepend to the next chunk, or "". */
  carry: string;
}

/** Index within `rest` where a trailing partial match of any supported OSC
 *  introducer starts (i.e. `rest.slice(idx)` is a proper prefix of an
 *  introducer, with more possibly still to come next chunk), or -1 if `rest`
 *  doesn't end with any prefix of it. The introducers are short, so this is a
 *  cheap scan. */
function trailingPartialIntroducerStart(rest: string): number {
  let earliest = -1;
  for (const introducer of OSC_INTRODUCERS) {
    const maxLen = Math.min(rest.length, introducer.length - 1);
    for (let k = maxLen; k >= 1; k -= 1) {
      const start = rest.length - k;
      const suffix = rest.slice(start);
      if (introducer.startsWith(suffix)) {
        if (earliest < 0 || start < earliest) earliest = start;
        break;
      }
    }
  }
  return earliest;
}

/** Last index in `rest` where a full supported OSC introducer begins, or -1. */
function lastFullIntroducerStart(rest: string): number {
  let latest = -1;
  for (const introducer of OSC_INTRODUCERS) {
    const idx = rest.lastIndexOf(introducer);
    if (idx > latest) latest = idx;
  }
  return latest;
}

/** Strip Aya's OSC 9001 / OSC 7501 sequences from a chunk and parse any
 *  complete ones. `carry` is whatever the previous call returned — a sequence
 *  that started in an earlier chunk but hadn't seen its terminator yet. Pure
 *  and side-effect free; callers own the per-ptyId carry state. */
export function extractAyaOsc(chunk: string, carry: string): OscExtractResult {
  const combined = carry + chunk;
  const events: AyaOscEvent[] = [];
  let cleaned = "";
  let lastIndex = 0;

  AYA_OSC_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AYA_OSC_RE.exec(combined)) !== null) {
    cleaned += combined.slice(lastIndex, match.index);
    if (match[1] !== undefined) {
      events.push({ key: match[1], value: match[2] });
    } else {
      events.push({ key: PROGRAM_STATUS_OSC_KEY, value: match[3] ?? "" });
    }
    lastIndex = AYA_OSC_RE.lastIndex;
  }

  const rest = combined.slice(lastIndex);

  // Every COMPLETE occurrence of the introducer was already consumed by the
  // loop above (it's global), so any occurrence still in `rest` must be the
  // start of an unterminated sequence — hold it back rather than let a
  // truncated escape sequence leak into the visible stream.
  const fullIntroducerIdx = lastFullIntroducerStart(rest);
  if (fullIntroducerIdx >= 0) {
    const candidate = rest.slice(fullIntroducerIdx);
    if (candidate.length <= MAX_CARRY_LENGTH) {
      return { cleaned: cleaned + rest.slice(0, fullIntroducerIdx), events, carry: candidate };
    }
    // Runaway/malformed sequence past the cap — fall through and flush it as
    // plain text instead of swallowing the rest of this terminal's output.
  } else {
    const partialIdx = trailingPartialIntroducerStart(rest);
    if (partialIdx >= 0) {
      return { cleaned: cleaned + rest.slice(0, partialIdx), events, carry: rest.slice(partialIdx) };
    }
  }

  cleaned += rest;
  return { cleaned, events, carry: "" };
}

const STATUS_LEVELS = new Set(["active", "waiting", "done", "error"]);

export interface AyaOscStatus {
  level: "active" | "waiting" | "done" | "error" | "clear";
  text: string;
}

const PROGRAM_STATUS_MAX_LENGTH = 80;

function stripControlChars(s: string): string {
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
}

/** Parse an `OSC 7501` Program Status Escape Sequence payload (`ESC ] 7501 ; ... ST`).
 *  Supports:
 *  - empty payload (`\x1b]7501;\x07`) -> `{ level: "clear", text: "" }`
 *  - level-prefixed payload (`waiting : Approval needed` or `done : Tests passed`)
 *  - bare status text (`Running tests`) -> `{ level: "active", text: "Running tests" }`
 *  Capped at 80 chars and stripped of C0/C1 control characters per the spec. */
export function parseProgramStatusOsc(raw: string): AyaOscStatus | null {
  const cleaned = stripControlChars(raw);
  if (!cleaned) return { level: "clear", text: "" };
  const sep = cleaned.indexOf(":");
  if (sep >= 0) {
    const maybeLevel = cleaned.slice(0, sep).trim();
    const rest = cleaned.slice(sep + 1).trim().slice(0, PROGRAM_STATUS_MAX_LENGTH);
    if (maybeLevel === "clear") return { level: "clear", text: "" };
    if (STATUS_LEVELS.has(maybeLevel)) {
      if (!rest) return null;
      return { level: maybeLevel as AyaOscStatus["level"], text: rest };
    }
  }
  return { level: "active", text: cleaned.slice(0, PROGRAM_STATUS_MAX_LENGTH) };
}

/** Parse an `aya.status` event's `level : text` (or `clear`) value, or an
 *  `OSC 7501` Program Status event. Returns null for any other key, an
 *  unrecognized level, or empty text — never throws, since this reads
 *  untrusted process output. */
export function parseAyaOscStatus(event: AyaOscEvent): AyaOscStatus | null {
  if (event.key === PROGRAM_STATUS_OSC_KEY) {
    return parseProgramStatusOsc(event.value);
  }
  if (event.key !== "status") return null;
  const trimmed = stripControlChars(event.value);
  if (trimmed === "clear" || trimmed.startsWith("clear:") || trimmed.startsWith("clear :")) {
    return { level: "clear", text: "" };
  }
  const sep = trimmed.indexOf(":");
  if (sep < 0) return null;
  const level = trimmed.slice(0, sep).trim();
  const text = trimmed.slice(sep + 1).trim();
  if (!STATUS_LEVELS.has(level) || !text) return null;
  return { level: level as AyaOscStatus["level"], text };
}

// A session id ends up inside a spawn command line on restore, so it is kept
// to characters that cannot change the shape of that command — no quotes,
// whitespace, or shell metacharacters. Anything else is dropped rather than
// escaped: a malformed id is worth losing, a command injection is not.
export const SESSION_ID_RE = /^[A-Za-z0-9_.:/-]{1,200}$/;

export const isSafeSessionId = (id: string): boolean => SESSION_ID_RE.test(id);

/** Parse an `aya.session` event's id. Returns null for any other key or an id
 *  that isn't shell-safe. */
export function parseAyaOscSession(event: AyaOscEvent): string | null {
  if (event.key !== "session") return null;
  const id = event.value.trim();
  return isSafeSessionId(id) ? id : null;
}
