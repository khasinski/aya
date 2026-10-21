import * as fs from "node:fs";
import * as path from "node:path";

/** The file on disk whose replacement means another build of Aya was installed. */
export function installedBuildFile(hostScript: string): string {
  const marker = `.asar${path.sep}`;
  const at = hostScript.indexOf(marker);
  return at < 0 ? hostScript : hostScript.slice(0, at + ".asar".length);
}

export interface InstalledBuildStamp {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

type Stat = (file: string) => { dev: number; ino: number; size: number; mtimeMs: number };

// Electron's fs reads an .asar archive as a folder; the archive itself needs
// noAsar so a swapped bundle shows as a different file.
function statFile(file: string): InstalledBuildStamp {
  const holder = process as { noAsar?: boolean };
  const before = holder.noAsar;
  holder.noAsar = true;
  try {
    const { dev, ino, size, mtimeMs } = fs.statSync(file);
    return { dev, ino, size, mtimeMs };
  } finally {
    holder.noAsar = before;
  }
}

/**
 * Remembers the build this app started from. A build installed over it by
 * hand (not by the updater) is a different file at the same path, and its
 * quit must hand the panes over as an update does.
 */
export class InstalledBuild {
  private readonly started: InstalledBuildStamp | null;
  constructor(private readonly file: string, private readonly stat: Stat = statFile) {
    this.started = this.read();
  }
  private read(): InstalledBuildStamp | null {
    try {
      const { dev, ino, size, mtimeMs } = this.stat(this.file);
      return { dev, ino, size, mtimeMs };
    } catch {
      return null;
    }
  }
  /** True only when both reads succeed and differ; a missing file is not a new build. */
  replaced(): boolean {
    const now = this.read();
    if (!this.started || !now) return false;
    return now.dev !== this.started.dev || now.ino !== this.started.ino || now.size !== this.started.size || now.mtimeMs !== this.started.mtimeMs;
  }
}
