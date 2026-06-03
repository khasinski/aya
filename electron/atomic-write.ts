// Atomic file write — writes to a sibling .tmp file then renames over the
// target. POSIX rename is atomic, so a crash during the write leaves either
// the old or new contents intact (never a truncated half-written file).
//
// Used for everything in ~/.aya/: projects/*.json, presets.json, themes.json.
// All three are small (<10kb each), so the extra disk I/O is negligible.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { recordWrite } from "./config-echo";

export async function writeFileAtomic(
  filePath: string,
  data: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  // Embed PID + a short random suffix in case two callers race on the same
  // path (shouldn't happen given the single-instance lock, but defensive).
  const tmpPath = `${filePath}.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, filePath);
    // Record what we just wrote so the config watcher can tell this echo of
    // our own save apart from a genuine external edit (see config-echo.ts).
    recordWrite(filePath, data);
  } catch (err) {
    // Best effort: clean up the tmp file if the rename never happened.
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}
