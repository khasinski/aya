import * as path from "node:path";

function rewriteAsarPath(filePath: string): string {
  const parts = filePath.split(path.sep);
  const asarIndex = parts.lastIndexOf("app.asar");
  if (asarIndex === -1) return filePath;
  parts[asarIndex] = "app.asar.unpacked";
  return parts.join(path.sep);
}

/** Absolute path to the bundled `bin/aya` CLI script, given the __dirname of
 *  the running main module.
 *
 *  In a packaged app __dirname lives inside app.asar - a virtual filesystem
 *  that Node can read but the OS cannot exec from, so a shim pointing there
 *  fails with "Not a directory" (#39). The asarUnpack build rule materializes
 *  bin/ next to the archive as app.asar.unpacked/bin/aya; rewrite the exact
 *  app.asar path segment to target that real file. Dev runs (dist-electron in
 *  the repo, no asar anywhere in the path) pass through untouched. */
export function bundledAyaCliPath(mainDirname: string): string {
  const inside = path.join(mainDirname, "..", "bin", "aya");
  return rewriteAsarPath(inside);
}

/** Absolute path to a native helper emitted into dist-electron.
 *
 *  Native binaries cannot be executed from app.asar. electron-builder unpacks
 *  them to app.asar.unpacked/dist-electron, so packaged runs must point there.
 */
export function bundledDistElectronHelperPath(
  mainDirname: string,
  helperName: string,
): string {
  return rewriteAsarPath(path.join(mainDirname, helperName));
}
