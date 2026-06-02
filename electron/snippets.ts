// Saved snippets — reusable text the user injects into the active terminal on
// demand. Stored at ~/.aya/snippets.json.
//
// Modeled on iTerm2's "Snippets": named text you send into a running terminal.
// Unlike presets (which LAUNCH a terminal), a snippet is written into an
// already-running PTY. The point is that these live on the editor side, in
// Aya, not in an agent's prompt or CLAUDE.md — so they never occupy the
// agent's context until the user actually sends one. A snippet's text can be a
// shell command or an agent prompt.
//
// `autoRun: true` means Aya appends a carriage return so it executes
// immediately; `false` means it only types the text and the user presses Enter
// themselves (useful for long agent prompts you want to review or extend).

import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { SNIPPETS_FILE } from "./paths";

export interface Snippet {
  id: string;
  name: string;
  /** Literal text written to the PTY. */
  text: string;
  /** When true, Aya appends "\r" so the text runs immediately. */
  autoRun: boolean;
}

/** Defensive cap so a corrupted or hostile file can't grow unbounded. */
export const SNIPPETS_MAX = 200;

/** Per-snippet text ceiling. A snippet is a command or a prompt, not a file;
 *  20k chars (~4k words) is far above any real use and bounds a corrupted or
 *  hostile file. Longer text is rejected by normalize and at the IPC boundary. */
export const SNIPPET_TEXT_MAX = 20_000;

/** Seeded on first launch (exactly like DEFAULT_PRESETS) so the snippet drawer
 *  isn't empty out of the box. One illustrative agent prompt in "hold" mode
 *  (autoRun: false) — it types into the terminal so the user can review/extend
 *  before pressing Enter. Freely editable or deletable in Settings. */
export const DEFAULT_SNIPPETS: readonly Snippet[] = [
  {
    id: "magic-numbers-audit",
    name: "magic numbers audit",
    autoRun: false,
    text: [
      "Run a full magic-numbers audit of this project - in both production code and tests. Work in a loop and don't stop until another pass finds nothing new:",
      "",
      "1. Detection - find every numeric literal (and other magic values) that carries domain meaning: timeouts, limits, thresholds, sizes, prices, coefficients. Skip trivial 0/1 where a name adds nothing.",
      "2. Test red - before changing a value, add a test that pins it (asserts the specific number / behavior).",
      "3. Extraction - move each value into one shared location (e.g. base.rb / a config class / settings) as a named constant with a sensible default. First check whether such a constant already exists - reuse, don't duplicate. Don't introduce new magic numbers along the way.",
      "4. Test green - make sure the tests pass after the swap.",
      "5. Keep it DRY - identical values in several places become one constant used everywhere (including validators).",
      "",
      "This task suits multiple agents - split detection/fixing across modules in parallel.",
      "",
      "At the end, verify and report: were all magic numbers eliminated? List the ones you deliberately left, with justification. Don't modify anything beyond extracting constants and adding tests.",
    ].join("\n"),
  },
];

export function isSnippet(x: unknown): x is Snippet {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    !!r.id &&
    typeof r.name === "string" &&
    typeof r.text === "string" &&
    typeof r.autoRun === "boolean"
  );
}

/** Normalize a raw snippet off disk. Drops bad shapes, backfills a missing
 *  `autoRun` to false, and rejects entries with an empty id or empty text
 *  (a snippet with nothing to send is useless and would render a dead row). */
export function normalizeSnippet(raw: unknown): Snippet | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id.trim()) return null;
  if (typeof r.text !== "string" || !r.text.trim()) return null;
  if (r.text.length > SNIPPET_TEXT_MAX) return null;
  const name =
    typeof r.name === "string" && r.name.trim() ? r.name : r.text.trim();
  return {
    id: r.id,
    name,
    text: r.text,
    autoRun: r.autoRun === true,
  };
}

/** Normalize and bound an arbitrary array of raw snippets. Non-array input
 *  yields []. Malformed entries are dropped, duplicate ids are collapsed
 *  (first wins — they'd otherwise collide as React keys), and the result is
 *  capped. */
export function normalizeSnippets(raw: unknown, cap = SNIPPETS_MAX): Snippet[] {
  if (!Array.isArray(raw)) return [];
  const out: Snippet[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw) {
    const normalized = normalizeSnippet(entry);
    if (!normalized) continue;
    if (seenIds.has(normalized.id)) continue;
    seenIds.add(normalized.id);
    out.push(normalized);
    if (out.length >= cap) break;
  }
  return out;
}

export async function listSnippets(): Promise<Snippet[]> {
  try {
    const raw = await fs.readFile(SNIPPETS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return normalizeSnippets(data?.snippets);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // First launch — seed the shipped defaults and persist so the user has
      // a starting set they can edit (mirrors how presets are seeded).
      const seeded = [...DEFAULT_SNIPPETS];
      await saveSnippets(seeded);
      return seeded;
    }
    throw err;
  }
}

export async function saveSnippets(snippets: Snippet[]): Promise<void> {
  const sanitized = normalizeSnippets(snippets);
  await writeFileAtomic(
    SNIPPETS_FILE,
    JSON.stringify({ snippets: sanitized }, null, 2) + "\n",
  );
}
