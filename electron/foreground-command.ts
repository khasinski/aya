// What a shell pane runs right now (#217). An interactive shell at its prompt holds its terminal's foreground; a command
// it starts (a dev server, a build, an editor) gets a process group of its own and takes the foreground until it ends.
// Measured on macOS 26 with zsh: at the prompt `ps -o tpgid=` of the shell is its own pid; running `sleep 4 | cat` it
// is the pid of sleep, the pipeline's first process. A restart stops that command, so Aya asks first.
// A job sent to the background (`cmd &`) is not seen. Windows: unsupported, null.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Asked only before a restart; a pane that cannot be read in this time counts as at its prompt.
const PS_TIMEOUT_MS = 1500;
/** The longest command the restart question shows; the rest is cut. */
export const FOREGROUND_COMMAND_MAX = 60;

export type RunPs = (args: string[]) => Promise<string>;

async function runPs(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("ps", args, { timeout: PS_TIMEOUT_MS, windowsHide: true });
  return stdout;
}

/** The command the shell `pid` has handed its terminal to, as ps shows it ("npm run dev"); null at its prompt, for a
 *  process that is gone, or when ps cannot say. */
export async function foregroundCommand(pid: number, ps: RunPs = runPs): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") return null;
  const group = Number((await ps(["-o", "tpgid=", "-p", String(pid)]).catch(() => "")).trim());
  if (!Number.isInteger(group) || group <= 0 || group === pid) return null;
  // The group's first process may have ended while the rest of a pipeline runs: the command is then unnamed.
  const command = (await ps(["-o", "command=", "-p", String(group)]).catch(() => "")).trim().replace(/\s+/g, " ");
  if (!command) return "a command";
  return command.length > FOREGROUND_COMMAND_MAX ? `${command.slice(0, FOREGROUND_COMMAND_MAX - 3)}...` : command;
}
