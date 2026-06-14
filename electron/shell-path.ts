// Recover the user's real PATH for GUI-launched Aya.
//
// macOS (and Linux desktop) start GUI apps from launchd/the session manager
// with a minimal PATH — typically just /usr/bin:/bin:/usr/sbin:/sbin plus
// whatever /etc/paths(.d) and the login profile add. The user's own PATH
// additions (~/.local/bin, mise, asdf, npm-global, …) are commonly written to
// .zshrc / .bashrc, which are sourced ONLY for *interactive* shells. Aya spawns
// presets through `$SHELL -l -c` (a login but NON-interactive shell), so those
// dirs never make it onto PATH and `claude`/`codex` come back as
// "command not found". Running from `npm run dev` hides the bug because the
// dev process inherits the developer's already-populated interactive PATH.
//
// The fix: once at startup, ask a login + INTERACTIVE shell for its PATH and
// merge it into process.env.PATH. The PTY host inherits this env when it is
// spawned (see pty-host-client.ts), and harness auto-detection runs in this
// same main process, so a single repair fixes preset launches, the
// command-not-found preflight, the first-launch harness scan, and the
// writable-dir search used by the `aya` CLI installer — all at once.

import { execFile } from "node:child_process";
import * as path from "node:path";
import { userShell } from "./shell";

// Worst-case time we'll wait for the shell to print its PATH. A normal shell
// answers in well under a second; a heavy .zshrc (oh-my-zsh + plugins) can take
// a few hundred ms. On expiry we abandon the probe and leave PATH untouched.
const PATH_PROBE_TIMEOUT_MS = 5000;

// Sentinels bracket the PATH value so rc-file noise printed during shell
// startup (banners, instant-prompt escapes, "update available" notices) can be
// sliced off — we keep only what's strictly between the markers.
const PATH_BEGIN = "__AYA_PATH_BEGIN__";
const PATH_END = "__AYA_PATH_END__";

/** argv for a login + interactive shell that prints its PATH between sentinels.
 *  `-i` is what makes the shell source .zshrc/.bashrc (where ~/.local/bin etc.
 *  usually live); `-l` keeps .zprofile/.bash_profile in the mix too. $PATH is
 *  double-quoted so zsh/bash/sh expand the colon-joined scalar; the markers are
 *  single-quoted literals. POSIX-oriented — fish expands $PATH as a space-
 *  joined list, not a colon scalar, so parseResolvedPath rejects its output
 *  (see there) rather than risk corrupting PATH. */
export function shellPathProbeArgv(shell: string): string[] {
  return [
    shell,
    "-l",
    "-i",
    "-c",
    `printf '%s%s%s' '${PATH_BEGIN}' "$PATH" '${PATH_END}'`,
  ];
}

/** Pull the PATH value out of the probe's stdout, ignoring anything printed
 *  before/after our sentinels. Returns null when the markers are absent (the
 *  shell errored), the value is empty, or it doesn't look like a colon-joined
 *  PATH. The last guard catches fish, whose "$PATH" prints as a space-joined
 *  list: a value with whitespace but no path separator would otherwise be
 *  merged in as a single bogus entry, so we drop it and leave PATH unchanged. */
export function parseResolvedPath(stdout: string): string | null {
  const begin = stdout.indexOf(PATH_BEGIN);
  if (begin === -1) return null;
  const valueStart = begin + PATH_BEGIN.length;
  const end = stdout.indexOf(PATH_END, valueStart);
  if (end === -1) return null;
  const value = stdout.slice(valueStart, end);
  if (value.length === 0) return null;
  if (/\s/.test(value) && !value.includes(path.delimiter)) return null;
  return value;
}

/** Union of the resolved (login-shell) PATH entries followed by whatever the
 *  current process already had, de-duplicated and order-preserving. The
 *  resolved entries come first so the user's intended order wins, but nothing
 *  the GUI environment provided (cryptex paths, etc.) is dropped. */
export function mergePath(resolved: string, current: string | undefined): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const source of [resolved, current ?? ""]) {
    for (const entry of source.split(path.delimiter)) {
      if (entry.length > 0 && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
  }
  return out.join(path.delimiter);
}

/** Run the user's login + interactive shell once and return the PATH it
 *  reports. Resolves null on Windows (the `$SHELL -l -i -c` model doesn't
 *  apply), on timeout, on shell error, or when the output isn't a usable PATH —
 *  every failure is non-fatal and callers leave PATH as-is. The probe can never
 *  stall startup: the shell is SIGKILLed on timeout, and a guard timer settles
 *  the promise even if a stray child kept stdout open past the kill. `platform`
 *  and `run` are injectable so the win32 short-circuit and the error/success
 *  paths are testable without spawning a real shell. */
export function resolveLoginShellPath(
  platform: NodeJS.Platform = process.platform,
  run: typeof execFile = execFile,
): Promise<string | null> {
  if (platform === "win32") return Promise.resolve(null);
  const [shell, ...args] = shellPathProbeArgv(userShell());
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const guard = setTimeout(() => settle(null), PATH_PROBE_TIMEOUT_MS);
    guard.unref();
    run(
      shell,
      args,
      {
        timeout: PATH_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout) => {
        clearTimeout(guard);
        settle(err ? null : parseResolvedPath(stdout));
      },
    );
  });
}

/** Merge the login-shell PATH into process.env.PATH so GUI-launched Aya can
 *  find CLIs whose dirs are only added in .zshrc/.bashrc. Call once, early in
 *  startup, before the PTY host is spawned or harnesses are scanned. Returns
 *  true if PATH actually changed (useful for tests/logging). No-op on any
 *  failure. */
export async function repairProcessPath(
  resolvePath: typeof resolveLoginShellPath = resolveLoginShellPath,
): Promise<boolean> {
  const resolved = await resolvePath();
  if (!resolved) return false;
  const merged = mergePath(resolved, process.env.PATH);
  if (merged === process.env.PATH) return false;
  process.env.PATH = merged;
  return true;
}
