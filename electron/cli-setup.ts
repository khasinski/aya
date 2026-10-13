// CLI setup: PATH probes, install status, shim installation and startup repair.
// The running app's directory, development mode and packaged state stay with main.ts.

import type { App } from "electron";
import { accessSync, constants as fsConstants, promises as fs, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TMP_SUFFIX } from "./atomic-write";
import {
  type AyaCopy,
  ayaShimTargets,
  chooseCliInstallDir,
  describeCliStatus,
  insideAsarArchive,
  offPathNote,
  planCliInstall,
} from "./cli-install";
import { bundledAyaCliPath } from "./cli-path";
import { defaultInstallAyaCliPath, renderCliShim } from "./cli-shim";
import { EXECUTABLE_FILE_MODE } from "./paths";
import type { CliStatus } from "./types";

export interface CliSetupDeps {
  app: Pick<App, "isPackaged">;
  mainDirname: string;
  isDev: boolean;
}

export function pathEntries(): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    // Relative entries (`node_modules/.bin`, `.`) depend on the cwd, so an
    // `aya` found or written there means nothing to a shell elsewhere.
    .filter((entry) => entry.trim().length > 0 && path.isAbsolute(entry));
}

export function findExecutableOnPath(name: string): string | null {
  for (const entry of pathEntries()) {
    const candidate = path.join(entry, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export async function anyExecutable(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    try {
      await fs.access(p, fsConstants.X_OK);
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

/** A missing dir counts when its nearest existing ancestor is writable, since
 *  install creates it (a fresh ~/.local/bin). */
export function isWritableDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch (err) {
    const parent = path.dirname(dir);
    return (
      (err as NodeJS.ErrnoException).code === "ENOENT" &&
      parent !== dir &&
      isWritableDir(parent)
    );
  }
}

/** Something at `target` that Reinstall must not write through: a symlink, or
 *  a file that is not our shim. */
export async function foreignFileAt(target: string): Promise<boolean> {
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) return true;
    return ayaShimTargets(await fs.readFile(target, "utf-8")).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Every `aya` on PATH, in PATH order - not just the one a shell runs, so a
 *  dead copy waiting below it is visible too (#115). */
export async function ayaCopiesOnPath(): Promise<AyaCopy[]> {
  const copies: AyaCopy[] = [];
  const seen = new Set<string>();
  for (const entry of pathEntries()) {
    const candidate = path.join(entry, "aya");
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    // A symlink (e.g. into a dotfiles repo) is the user's arrangement: listed,
    // but never ours to rewrite, repair or remove (#120 review).
    let symlink = false;
    try {
      symlink = (await fs.lstat(candidate)).isSymbolicLink();
    } catch {
      // vanished between access and lstat: treat as a plain file
    }
    let targets: string[] = [];
    try {
      targets = ayaShimTargets(await fs.readFile(candidate, "utf-8"));
    } catch {
      // unreadable: treat as not ours
    }
    // A shim can be on PATH yet dead: it bakes an absolute path into Aya.app,
    // and moving/renaming the app kills it (follow-up on #42).
    const ours = targets.length > 0 && !symlink;
    copies.push({
      path: candidate,
      ours,
      broken:
        ours &&
        !(await anyExecutable(
          targets.filter((target) => !insideAsarArchive(target)),
        )),
    });
  }
  return copies;
}

export async function writeCliShim(target: string, script: string): Promise<void> {
  // Temp file + rename: a failed write can't leave a truncated, dead shim, and
  // rename replaces the entry itself instead of writing through a link.
  const tmp = `${target}.aya-${process.pid}${TMP_SUFFIX}`;
  try {
    await fs.writeFile(tmp, script, { mode: EXECUTABLE_FILE_MODE });
    await fs.chmod(tmp, EXECUTABLE_FILE_MODE);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function createCliSetup(deps: CliSetupDeps) {
  function cliInstallDir() {
    return chooseCliInstallDir(pathEntries(), os.homedir(), isWritableDir);
  }

  async function cliStatus(): Promise<CliStatus> {
    const copies = await ayaCopiesOnPath();
    const choice = cliInstallDir();
    const active = copies[0] ?? null;
    const message = describeCliStatus(copies, choice);
    return {
      installed: active !== null,
      path: active?.path ?? null,
      installDir: choice.dir,
      installable: true,
      copies,
      ...(message ? { message } : {}),
    };
  }

  function freshCliShim(): string {
    return renderCliShim(
      bundledAyaCliPath(deps.mainDirname),
      defaultInstallAyaCliPath(process.platform),
    );
  }

  async function installCli(): Promise<CliStatus> {
    const choice = cliInstallDir();
    const installDir = choice.dir;
    const source = bundledAyaCliPath(deps.mainDirname);
    // Refuse to install a shim that cannot work. The asar path bug (#39) made
    // Install report success while the written shim exec'd a file inside the
    // archive; verifying the exec bit up front turns any future packaging
    // regression into a visible error instead of a silently broken CLI.
    try {
      await fs.access(source, fsConstants.X_OK);
    } catch {
      return {
        installed: false,
        path: null,
        installDir,
        installable: false,
        message: `Bundled aya CLI is not executable at ${source}`,
      };
    }
    const target = path.join(installDir, "aya");
    if (await foreignFileAt(target)) {
      return {
        ...(await cliStatus()),
        message: `${target} exists and was not installed by Aya - move it away, then click Reinstall.`,
      };
    }
    await fs.mkdir(installDir, { recursive: true });
    const script = freshCliShim();
    await writeCliShim(target, script);
    // Aya Dev writes a shim aimed at this checkout; spreading it to the user's
    // other copies would repoint their production `aya` (#120 review).
    const plan = deps.isDev
      ? { rewrite: [] as string[], remove: [] as string[] }
      : planCliInstall(await ayaCopiesOnPath(), target);
    const failed: string[] = [];
    for (const copy of plan.rewrite) {
      await writeCliShim(copy, script).catch(() => failed.push(copy));
    }
    for (const copy of plan.remove) {
      await fs.rm(copy, { force: true }).catch(() => failed.push(copy));
    }
    const status = await cliStatus();
    const installedMessage = `Installed at ${target}${offPathNote(choice)}`;
    return {
      ...status,
      message: failed.length
        ? `${installedMessage}. Could not update ${failed.join(", ")}.`
        : choice.onPath
          ? (status.message ?? installedMessage)
          : installedMessage,
    };
  }

  /** Rewrites dead shims at startup for users who never reopen Settings (#115).
   *  Packaged only: in dev the fresh shim would aim at this checkout. */
  async function healDeadCliShims(): Promise<void> {
    if (deps.isDev || !deps.app.isPackaged) return;
    // An AppImage mounts under a fresh /tmp/.mount_* each launch: a "repaired"
    // shim would aim at a path that dies when the app quits.
    if (process.env.APPIMAGE) return;
    try {
      await fs.access(bundledAyaCliPath(deps.mainDirname), fsConstants.X_OK);
    } catch {
      return;
    }
    const script = freshCliShim();
    for (const copy of await ayaCopiesOnPath()) {
      if (!copy.broken) continue;
      try {
        await writeCliShim(copy.path, script);
        console.log(`[aya] repaired dead aya shim at ${copy.path}`);
      } catch (err) {
        console.warn(`[aya] could not repair dead aya shim at ${copy.path}:`, err);
      }
    }
  }

  return { cliInstallDir, cliStatus, freshCliShim, installCli, healDeadCliShims };
}
