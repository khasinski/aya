// Replays a real CLI's recorded PTY output (tests/fixtures/own-screens: .raw, .chunks.jsonl, .meta.json) through the
// pty host's screen mirror on a fake clock, so a test asks paneHold what a message due at time t would meet.

import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const { openVtPane, closeVtPane, writeVtPane, paneHold } = await import("../../dist-electron/vt-state.js");

const DIR = new URL("../fixtures/own-screens/", import.meta.url);

/** The recording's reads as [t (ms), text], text decoded across read boundaries. */
export function ownScreen(name) {
  const raw = readFileSync(new URL(`${name}.raw`, DIR));
  const meta = JSON.parse(readFileSync(new URL(`${name}.meta.json`, DIR), "utf8"));
  const decoder = new StringDecoder("utf8");
  const reads = [];
  let at = 0;
  for (const line of readFileSync(new URL(`${name}.chunks.jsonl`, DIR), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    if (c.len === undefined) continue;
    reads.push([Math.round(c.t * 1000), decoder.write(raw.subarray(at, at + c.len))]);
    at += c.len;
  }
  return { meta, reads };
}

/** Runs `visit(id, t)` at each time in `atMs` (ascending) on a pane mirror `id` that has the recording written up
 *  to then, on a clock that starts at the spawn. Returns what each visit returned. */
export async function overRecording(name, agent, atMs, visit) {
  const { meta, reads } = ownScreen(name);
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const id = `own-${name}-${Math.random()}`;
  try {
    openVtPane(id, meta.cols, meta.rows, () => {}, agent);
    const start = now;
    let next = 0;
    const seen = [];
    for (const t of atMs) {
      while (next < reads.length && reads[next][0] <= t) {
        now = start + reads[next][0];
        writeVtPane(id, reads[next][1]);
        next += 1;
      }
      now = start + t;
      seen.push(await visit(id, t));
    }
    return seen;
  } finally {
    closeVtPane(id);
    Date.now = realNow;
  }
}

export const holdsOver = (name, agent, atMs) => overRecording(name, agent, atMs, (id) => paneHold(id));

/** The arrival time (ms) of every read, for a scan over a whole recording. */
export const readTimes = (name) => [...new Set(ownScreen(name).reads.map(([t]) => t))];
