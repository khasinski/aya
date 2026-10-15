// Atomic file write — writes to a sibling .tmp file then renames over the
// target. POSIX rename is atomic, so a crash during the write leaves either
// the old or new contents intact (never a truncated half-written file).
//
// Used for every config Aya rewrites in place, including other tools' files via
// the hook installers. All are small (<10kb), so the extra disk I/O is cheap.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { recordWrite } from "./config-echo";

import { atomicTempPath } from "./atomic-temp";
export { atomicTempPath, TMP_SUFFIX } from "./atomic-temp";

export async function writeFileAtomic(
  filePath: string,
  data: string,
  mode?: number,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  // Embed PID + a random suffix in case two callers race on the same path
  // (shouldn't happen given the single-instance lock, but defensive). Use a
  // secure RNG so the temp path isn't predictable (symlink-attack hygiene).
  const tmpPath = atomicTempPath(filePath);
  try {
    // "wx": the temp file is created here or not at all. A file or symlink planted at the (random) temp path is an
    // error, never followed, so a save cannot write through it to somewhere else.
    await fs.writeFile(tmpPath, data, { mode, flag: "wx" });
    await fs.rename(tmpPath, filePath);
    // Remember what we just wrote so the config watcher can tell our own
    // saves apart from edits made outside the app (see config-echo.ts).
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
