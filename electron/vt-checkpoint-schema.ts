// The private xterm binding may only consume this closed, allocation-bounded DTO.
// This validator deliberately refuses unknown fields instead of installing them
// on xterm objects. An unsupported state takes the confirmed restart path.
import { MAX_PTY_PANES } from "./pty-pane-limits";
export const MAX_VT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_VT_TAIL_BYTES = 256 * 1024;
export const MAX_CHECKPOINT_BYTES = 128 * 1024 * 1024;
export const MAX_CHECKPOINT_PANES = MAX_PTY_PANES;
const MAX_JSON_NODES = 2_000_000;
const MAX_JSON_DEPTH = 24;

type Dict = Record<string, unknown>;
type Check = (value: unknown, path: string) => void;
const fail = (path: string): never => { throw new Error(`Invalid VT checkpoint: ${path}`); };
const bool: Check = (v, p) => { if (typeof v !== "boolean") fail(p); };
const integer = (min: number, max: number): Check => (v, p) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) fail(p);
};
const literal = (...values: unknown[]): Check => (v, p) => { if (!values.includes(v)) fail(p); };
const text = (max: number): Check => (v, p) => {
  if (typeof v !== "string" || v.length > max || Buffer.byteLength(v) > max) fail(p);
};
const word = integer(-0x80000000, 0xffffffff);
const optional = (check: Check): Check => (v, p) => { if (v !== undefined) check(v, p); };
function object(v: unknown, p: string): Dict {
  if (!v || typeof v !== "object" || Array.isArray(v) ||
      (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) fail(p);
  return v as Dict;
}
const shape = (fields: Record<string, Check>): Check => (v, p) => {
  const d = object(v, p);
  for (const key of Object.keys(d)) if (!Object.hasOwn(fields, key)) fail(`${p}.${key}`);
  for (const [key, check] of Object.entries(fields)) check(d[key], `${p}.${key}`);
};
const array = (max: number, check: Check, min = 0): Check => (v, p) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail(p);
  (v as unknown[]).forEach((item, n) => check(item, `${p}[${n}]`));
};
const indexed = (max: number, check: Check): Check => (v, p) => {
  for (const [key, item] of Object.entries(object(v, p))) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) > max) fail(`${p}.${key}`);
    check(item, `${p}.${key}`);
  }
};
function base64(v: unknown, bytes: number, p: string): Buffer {
  // Check encoded size before allocating decoded storage. Buffer.from alone
  // accepts junk and truncated/noncanonical base64.
  if (typeof v !== "string" || v.length !== Math.ceil(bytes / 3) * 4) fail(p);
  const result = Buffer.from(v as string, "base64");
  if (result.length !== bytes || result.toString("base64") !== v) fail(p);
  return result;
}
const bytes = (size: number): Check => (v, p) => { base64(v, size, p); };
const extended = shape({ _ext: word, _urlId: integer(0, 0x7fffffff) });
const attributes = shape({ fg: word, bg: word, extended });
const charset: Check = (v, p) => {
  const d = object(v, p);
  if (Object.keys(d).length > 128) fail(p);
  for (const [key, item] of Object.entries(d)) {
    if (key.length !== 1 || key.charCodeAt(0) > 127) fail(p);
    text(32)(item, `${p}.${key}`);
  }
};
const finite: Check = (v, p) => { if (typeof v !== "number" || !Number.isFinite(v)) fail(p); };

/** Limit generic opaque JSON too; no callbacks, aliases, prototypes or huge
 * metadata trees can bypass the typed VT limits. The pane envelope adds its
 * own field schema when integrated with the mirror. */
export function validateCheckpointJson(value: unknown, maxBytes = MAX_VT_SNAPSHOT_BYTES): void {
  let nodes = 0, characters = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) fail("JSON complexity");
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number") { finite(v, "JSON number"); return; }
    if (typeof v === "string") { characters += Buffer.byteLength(v); if (characters > maxBytes) fail("JSON strings"); return; }
    if (typeof v !== "object" || seen.has(v)) fail("JSON value/alias");
    seen.add(v as object);
    if (Array.isArray(v)) { for (const item of v) visit(item, depth + 1); return; }
    for (const [key, item] of Object.entries(object(v, "JSON object"))) {
      if (["__proto__", "prototype", "constructor"].includes(key)) fail("JSON key");
      characters += Buffer.byteLength(key);
      if (characters > maxBytes) fail("JSON keys");
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) fail("JSON size");
}

/** Scan raw bytes with constant auxiliary space before JSON.parse can allocate
 * arrays/objects. This is a structural budget check, not a replacement JSON
 * parser: the built-in parser still checks grammar after this accepts. Keys
 * count against the token budget too. UTF-8 decoding happens only afterwards. */
export function preflightCheckpointJson(input: Buffer, maxBytes = MAX_VT_SNAPSHOT_BYTES): void {
  if (input.length > maxBytes) fail("snapshot size");
  let depth = 0, nodes = 0;
  for (let n = 0; n < input.length; n++) {
    const c = input[n];
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44 || c === 58) continue;
    if (c === 93 || c === 125) { if (--depth < 0) fail("JSON structure"); continue; }
    if (++nodes > MAX_JSON_NODES) fail("JSON complexity before parse");
    if (c === 91 || c === 123) { if (++depth > MAX_JSON_DEPTH) fail("JSON depth before parse"); continue; }
    if (c === 34) {
      let closed = false;
      while (++n < input.length) {
        if (input[n] === 92) { n++; continue; }
        if (input[n] === 34) { closed = true; break; }
      }
      if (!closed) fail("JSON string");
      continue;
    }
    if (c === 45 || (c >= 48 && c <= 57) || c === 116 || c === 102 || c === 110) {
      while (n + 1 < input.length && ![32,9,10,13,44,58,93,125,91,123,34].includes(input[n + 1])) n++;
      continue;
    }
    fail("JSON token");
  }
  if (depth !== 0) fail("JSON structure");
}
export function parseCheckpointJson(input: Buffer, maxBytes = MAX_VT_SNAPSHOT_BYTES): unknown {
  preflightCheckpointJson(input, maxBytes);
  const text = new TextDecoder("utf-8", {fatal: true}).decode(input);
  return JSON.parse(text);
}
export function parseVtSnapshot(input: Buffer, engine: string, defaultOptions: Dict): Dict {
  const dto = parseCheckpointJson(input);
  validateVtSnapshot(dto, engine, defaultOptions);
  return dto as Dict;
}

export function validateVtSnapshot(value: unknown, engine: string, defaultOptions: Dict, purpose: "host" | "renderer" = "host"): void {
  validateCheckpointJson(value);
  const dto = object(value, "snapshot");
  integer(2, 1000)(dto.cols, "cols"); integer(1, 1000)(dto.rows, "rows");
  const cols = dto.cols as number, rows = dto.rows as number;
  const options = object(dto.options, "options");
  // The host constructs headless terminals with default options except geometry
  // and scrollback. Refuse other options until the binding explicitly supports
  // them; never spread attacker-controlled options into a constructor.
  const optionChecks: Record<string, Check> = {};
  for (const [key, item] of Object.entries(defaultOptions)) optionChecks[key] = (v, p) => {
    if (JSON.stringify(v) !== JSON.stringify(item)) fail(p);
  };
  optionChecks.cols = integer(2, 1000); optionChecks.rows = integer(1, 1000);
  optionChecks.scrollback = integer(0, 10_000);
  if (purpose === "renderer") { optionChecks.cursorBlink = bool; optionChecks.scrollOnEraseInDisplay = bool; }
  shape(optionChecks)(options, "options");
  const scrollback = options.scrollback as number;
  let totalCells = 0;
  const buffer = (normal: boolean): Check => (v, p) => {
    const d = object(v, p), lines = d.lines;
    if (!Array.isArray(lines) || lines.length > rows + (normal ? scrollback : 0) ||
        (normal && lines.length < rows)) fail(`${p}.lines`);
    const length = (lines as unknown[]).length;
    shape({ state: shape({
      ydisp: integer(0, Math.max(0, length - rows)), ybase: integer(0, Math.max(0, length - rows)),
      y: integer(0, rows - 1), x: integer(0, cols), scrollBottom: integer(0, rows - 1), scrollTop: integer(0, rows - 1),
      tabs: indexed(1000, literal(true)), savedY: integer(0, rows + scrollback), savedX: integer(0, 1000),
      savedCharset: optional(charset), _cols: literal(cols), _rows: literal(rows), _hasScrollback: literal(normal),
    }), saved: attributes, lines: array(rows + (normal ? scrollback : 0), (line, q) => {
      const l = object(line, q);
      integer(2, 1000)(l.length, `${q}.length`);
      const width = l.length as number;
      // Resized historical lines can be wider than the current viewport.
      totalCells += width;
      if (totalCells > 3_000_000) fail("retained cell allocation");
      shape({length: integer(2, 1000), isWrapped: bool, data: bytes(width * 12),
        combined: indexed(width - 1, text(4096)), extended: indexed(width - 1, extended)})(l, q);
      const plane = base64(l.data, width * 12, `${q}.data`);
      for (let x = 0; x < width; x++) {
        const content = plane.readUInt32LE(x * 12);
        if ((content >>> 22) > 2 || (!(content & 0x200000) && (content & 0x1fffff) > 0x10ffff)) fail(`${q}.content`);
        if ((content & 0x200000) && !Object.hasOwn(l.combined as object, String(x))) fail(`${q}.combined reference`);
        if ((plane.readUInt32LE(x * 12 + 8) & 0x10000000) && !Object.hasOwn(l.extended as object, String(x))) fail(`${q}.extended reference`);
      }
    }) })(d, p);
    const state = d.state as Dict;
    if ((state.ydisp as number) > (state.ybase as number) || (state.scrollTop as number) > (state.scrollBottom as number)) fail(`${p}.coordinates`);
  };
  const lastMouseEvent: Check = purpose === "renderer" ? (v, p) => {
    if (v !== null) shape({col: integer(1, 1000), row: integer(1, 1000), x: finite, y: finite,
      button: integer(0, 4), action: literal(0, 1, 2, 3, 32), ctrl: bool, alt: bool, shift: bool})(v, p);
  } : literal(null);
  shape({
    format: literal(1), engine: literal(engine), options: shape(optionChecks), metadata: () => {},
    cols: literal(cols), rows: literal(rows), normal: buffer(true), alternate: buffer(false), active: literal("normal", "alternate"), userScrolling: bool,
    core: shape({ isCursorInitialized: bool, isCursorHidden: bool, modes: shape({ insertMode: bool }), decPrivateModes: shape({
      applicationCursorKeys: bool, applicationKeypad: bool, bracketedPasteMode: bool, origin: bool, reverseWraparound: bool,
      sendFocus: bool, synchronizedOutput: bool, wraparound: bool, cursorBlink: optional(bool), cursorStyle: optional(literal("block", "bar", "underline")),
    }) }),
    mouse: shape({ _activeProtocol: literal("NONE", "X10", "VT200", "DRAG", "ANY"), _activeEncoding: literal("DEFAULT", "SGR", "SGR_PIXELS"),
      _lastEvent: lastMouseEvent, _wheelPartialScroll: finite }),
    charset: shape({ charset: optional(charset), glevel: integer(0, 3), _charsets: array(4, (v, p) => { if (v !== null) charset(v, p); }) }),
    input: shape({ _windowTitle: text(1024 * 1024), _iconName: text(1024 * 1024),
      _windowTitleStack: array(10, text(1024 * 1024)), _iconNameStack: array(10, text(1024 * 1024)),
      _specialColors: (v, p) => { if (JSON.stringify(v) !== "[256,257,258]") fail(p); } }),
    current: attributes, erase: attributes,
    parser: shape({ initialState: literal(0), currentState: literal(0), precedingJoinState: word, collect: word,
      params: shape({ maxLength: literal(32), maxSubParamsLength: literal(32), length: integer(0, 32), _subParamsLength: integer(0, 32),
        _rejectDigits: bool, _rejectSubDigits: bool, _digitIsSub: bool, params: bytes(128), sub: bytes(128), indices: bytes(64) }) }),
    stringInterim: integer(0, 0x10ffff), utf8Interim: bytes(3), unicode: literal("6"),
    palette: indexed(258, array(3, integer(0, 255), 3)),
    links: shape({ nextId: integer(1, 0x7fffffff), entries: array(8192, shape({
      id: integer(1, 0x7fffffff), key: optional(text(16384)), data: shape({ id: optional(text(8192)), uri: text(8192) }),
      lines: array(11000, shape({ buffer: literal("normal", "alternate"), line: integer(0, 10999) })),
    })) }),
  })(dto, "snapshot");
  const params = (dto.parser as Dict).params as Dict;
  const indices = base64(params.indices, 64, "parser indices");
  for (let n = 0; n < (params.length as number); n++) {
    const index = indices.readUInt16LE(n * 2), start = index >>> 8, end = index & 255;
    if (start > end || end > (params._subParamsLength as number)) fail("parser parameter range");
  }
  for (const field of ["params", "sub"]) {
    const words = base64(params[field], 128, "parser values");
    for (let n = 0; n < 32; n++) if (words.readInt32LE(n * 4) < -1) fail("parser parameter value");
  }
  const links = dto.links as {nextId: number; entries: {id: number; key?: string; lines: {buffer: string; line: number}[]}[]};
  const ids = new Set<number>(), keys = new Set<string>();
  for (const entry of links.entries) {
    if (ids.has(entry.id) || entry.id >= links.nextId || (entry.key !== undefined && keys.has(entry.key))) fail("links identity");
    ids.add(entry.id); if (entry.key !== undefined) keys.add(entry.key);
    for (const marker of entry.lines) {
      const b = dto[marker.buffer] as {lines: unknown[]};
      if (marker.line >= b.lines.length) fail("link marker line");
    }
  }
  if (dto.active === "alternate" && (dto.alternate as {lines: unknown[]}).lines.length < rows) fail("active alternate size");
}

export function validateVtTail(value: unknown): void {
  validateCheckpointJson(value, MAX_VT_TAIL_BYTES);
  array(65536, (v, p) => {
    const d = object(v, p), keys = Object.keys(d);
    if (keys.length !== 1) fail(p);
    if (keys[0] === "text") text(MAX_VT_TAIL_BYTES)(d.text, p);
    else if (keys[0] === "bytes") {
      text(MAX_VT_TAIL_BYTES)(d.bytes, p);
      const decoded = Buffer.from(d.bytes as string, "base64");
      base64(d.bytes, decoded.length, p);
    } else if (keys[0] === "resize") {
      array(2, integer(1, 1000), 2)(d.resize, p);
      integer(2, 1000)((d.resize as number[])[0], p);
    } else fail(p);
  })(value, "tail");
}
