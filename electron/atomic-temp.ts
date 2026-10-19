import { randomBytes } from "node:crypto";
// Every write-then-rename temp file ends in this; sweeps and watchers test it.
export const TMP_SUFFIX = ".tmp";

/** `<filePath>.<pid>.<8 hex>.tmp`, the temp name shared with the host registry. */
export function atomicTempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}${TMP_SUFFIX}`;
}
