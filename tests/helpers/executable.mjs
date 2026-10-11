import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/** Writes an executable script that has already run once. macOS checks a new executable file on its first
 *  run, one file at a time across processes: with the suite's files in parallel that run took about 1.8 s
 *  (measured), so a fake started inside a 2.5 s probe never ran. The check is per file, not per content,
 *  so the stub's run covers the body written over it in place. */
export function writeExecutable(file, body) {
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  execFileSync(file);
  writeFileSync(file, body, { mode: 0o755 });
}
