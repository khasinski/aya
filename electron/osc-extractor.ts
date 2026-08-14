// Parses Aya's OSC 9001 signal vocabulary (see integrations.md) out of raw PTY
// output. A cooperating TUI (or a wrapper script) can emit
// `ESC ]9001;aya.<key>=<value> BEL` to hand Aya a structured signal — the
// "explicit status" channel that supersedes the regex-based bell heuristic
// (src/bell.ts) once it can identify a live one.
//
// Sequences are always stripped from the byte stream before it reaches
// xterm.js: whether or not Aya recognizes/consumes a given key, an agent's
// visible output must never leak escape-sequence noise.

// Only sequences beginning with this exact introducer are ever held back
// across a chunk boundary. Bounding the carry to our own namespaced prefix
// means an unrelated program's use of OSC 9001 (collision risk called out in
// integrations.md) is never mistaken for a truncated Aya sequence and is left
// untouched in the output.
const AYA_OSC_INTRODUCER = "\x1b]9001;aya.";

// Guards against an unterminated (malformed, or truncated by a misbehaving
// process) sequence growing the carry buffer forever. Comfortably larger than
// any real vocabulary value (see integrations.md's key list) plus key name.
const MAX_CARRY_LENGTH = 4096;

// `aya.<key>=<value>` terminated by BEL or ST (ESC \\). Value excludes BEL/ESC
// so a truncated terminator can never be swallowed into it.
const AYA_OSC_RE = /\x1b\]9001;aya\.([a-zA-Z][a-zA-Z0-9_-]*)=([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export interface AyaOscEvent {
  key: string;
  value: string;
}

export interface OscExtractResult {
  /** Chunk with every complete + held-back Aya OSC 9001 sequence removed. */
  cleaned: string;
  /** Structured events parsed from any complete sequences in this call. */
  events: AyaOscEvent[];
  /** Held-back partial sequence to prepend to the next chunk, or "". */
  carry: string;
}

/** Index within `rest` where a trailing partial match of AYA_OSC_INTRODUCER
 *  starts (i.e. `rest.slice(idx)` is a proper prefix of the introducer, with
 *  more possibly still to come next chunk), or -1 if `rest` doesn't end with
 *  any prefix of it. The introducer is short, so this is a cheap scan. */
function trailingPartialIntroducerStart(rest: string): number {
  const maxLen = Math.min(rest.length, AYA_OSC_INTRODUCER.length - 1);
  for (let k = maxLen; k >= 1; k -= 1) {
    const suffix = rest.slice(rest.length - k);
    if (AYA_OSC_INTRODUCER.startsWith(suffix)) return rest.length - k;
  }
  return -1;
}

/** Strip Aya's OSC 9001 sequences from a chunk and parse any complete ones.
 *  `carry` is whatever the previous call returned — a sequence that started
 *  in an earlier chunk but hadn't seen its terminator yet. Pure and
 *  side-effect free; callers own the per-ptyId carry state. */
export function extractAyaOsc(chunk: string, carry: string): OscExtractResult {
  const combined = carry + chunk;
  const events: AyaOscEvent[] = [];
  let cleaned = "";
  let lastIndex = 0;

  AYA_OSC_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AYA_OSC_RE.exec(combined)) !== null) {
    cleaned += combined.slice(lastIndex, match.index);
    events.push({ key: match[1], value: match[2] });
    lastIndex = AYA_OSC_RE.lastIndex;
  }

  const rest = combined.slice(lastIndex);

  // Every COMPLETE occurrence of the introducer was already consumed by the
  // loop above (it's global), so any occurrence still in `rest` must be the
  // start of an unterminated sequence — hold it back rather than let a
  // truncated escape sequence leak into the visible stream.
  const fullIntroducerIdx = rest.lastIndexOf(AYA_OSC_INTRODUCER);
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
  level: "active" | "waiting" | "done" | "error";
  text: string;
}

/** Parse an `aya.status` event's `level : text` value. Returns null for any
 *  other key, an unrecognized level, or empty text — never throws, since this
 *  reads untrusted process output. */
export function parseAyaOscStatus(event: AyaOscEvent): AyaOscStatus | null {
  if (event.key !== "status") return null;
  const sep = event.value.indexOf(":");
  if (sep < 0) return null;
  const level = event.value.slice(0, sep).trim();
  const text = event.value.slice(sep + 1).trim();
  if (!STATUS_LEVELS.has(level) || !text) return null;
  return { level: level as AyaOscStatus["level"], text };
}

// A session id ends up inside a spawn command line on restore, so it is kept
// to characters that cannot change the shape of that command — no quotes,
// whitespace, or shell metacharacters. Anything else is dropped rather than
// escaped: a malformed id is worth losing, a command injection is not.
const SESSION_ID_RE = /^[A-Za-z0-9_.:/-]{1,200}$/;

/** Parse an `aya.session` event's id. Returns null for any other key or an id
 *  that isn't shell-safe. */
export function parseAyaOscSession(event: AyaOscEvent): string | null {
  if (event.key !== "session") return null;
  const id = event.value.trim();
  return SESSION_ID_RE.test(id) ? id : null;
}
