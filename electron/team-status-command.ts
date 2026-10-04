// A team's "## Status command": project state Aya cannot know (which models a server has loaded, who shares the GPU),
// run in the project directory and handed to the lead with its round. The CLI's team stats loads this with plain node
// and only reads the last run the round recorded (status.json): stats must not run the user's command beside a round.

import { spawn } from "node:child_process";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { withoutSessionMarkers } from "./pane-command";
import { PANE_ENV_VARS } from "./pane-env";
import { statusCommandOf } from "./team-definition";
import { TEAM_FILES } from "./team-records";
import { clock } from "./team-times";
import type { TeamDefinition } from "./types";

export const STATUS_COMMAND_TIMEOUT_MS = 20_000;
export const STATUS_OUTPUT_MAX_BYTES = 2048;
export const STATUS_SECTION_TITLE = "Status (from the team's command)";

/** What statusSection needs of a team: TeamRunner's `open` gives exactly these. */
export interface StatusTeam {
  project: { directory: string; remote?: unknown };
  store: { dir: string; state(): Promise<TeamState> };
  team: Pick<TeamDefinition, "statusCommand">;
}

/** How the command ended: `failure` is null when it exited 0. */
export interface StatusRun {
  output: string;
  failure: string | null;
}

/** What `aya team stats` shows: the last run a round recorded; `ranAt` null when this command has not run yet. */
export interface StatsStatus extends StatusRun {
  command: string;
  ranAt: string | null;
}

type TeamState = { paused: boolean; running: boolean };

const failed = (reason: string) => `status command failed: ${reason}`;

/** Why the command does not run for this team, or null. A remote project's directory is on another machine; a paused
 *  or unstarted team gets no rounds to carry it. */
async function whyNotRun(project: { remote?: unknown }, readState: () => Promise<TeamState>): Promise<string | null> {
  if (project.remote) return "a remote project: the command would run on this machine, not in its directory";
  const { paused, running } = await readState();
  return running ? null : `the team is ${paused ? "paused" : "not started"}; it runs only for a running team`;
}

// A pane's identity in the command's env would let its `aya` calls act as that pane (a nested Aya Dev inherits one).

export function statusCommandEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const plain = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));
  const out = withoutSessionMarkers(plain);
  for (const key of PANE_ENV_VARS) delete out[key];
  return out;
}

// The output is typed into the lead's composer: ESC sequences or a carriage return there would act as keys, not text.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

function clean(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(ANSI, "").replace(CONTROL, "");
}

/** The text cut to `max` UTF-8 bytes on a character boundary, with a note when cut. */
export function capOutput(text: string, max = STATUS_OUTPUT_MAX_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  let end = max;
  // A continuation byte (10xxxxxx) means the cut fell inside a character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n(cut at ${max} bytes)`;
}

/** Runs `command` with sh in `cwd`, no stdin, killed with its children after `timeoutMs`. Never rejects. */
export function runStatusCommand(command: string, cwd: string, timeoutMs = STATUS_COMMAND_TIMEOUT_MS, env = statusCommandEnv()): Promise<StatusRun> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const kept = { out: 0, err: 0 };
    let done = false;
    const finish = (failure: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const stdout = clean(Buffer.concat(out).toString("utf8")).trim();
      const stderr = clean(Buffer.concat(err).toString("utf8")).trim();
      const text = [stdout, stderr && `stderr:\n${stderr}`].filter(Boolean).join("\n");
      resolve({ output: capOutput(text), failure });
    };
    let child: ReturnType<typeof spawn>;
    try {
      // detached: its own process group, so a timeout kills what the shell started too, not the shell alone.
      child = spawn(command, { cwd, env, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ output: "", failure: failed((e as Error).message) });
      return;
    }
    // Reading past the cap only drains the pipe: a chatty command must not block on a full one.
    const take = (chunks: Buffer[], key: "out" | "err") => (chunk: Buffer) => {
      if (kept[key] > STATUS_OUTPUT_MAX_BYTES) return;
      chunks.push(chunk);
      kept[key] += chunk.length;
    };
    child.stdout?.on("data", take(out, "out"));
    child.stderr?.on("data", take(err, "err"));
    const timer = setTimeout(() => {
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(`status command timed out after ${Math.round(timeoutMs / 1000)} s`);
    }, timeoutMs);
    child.on("error", (e) => finish(failed(e.message)));
    child.on("close", (code, signal) => finish(code === 0 ? null : failed(signal ? `killed by ${signal}` : `exit ${code}`)));
  });
}

const inFlight = new Map<string, Promise<StatusRun | null>>();

/** The command's run for a running local team, else null; calls made while one runs share it. */
export function statusRun({ project, store, team }: StatusTeam, timeoutMs = STATUS_COMMAND_TIMEOUT_MS): Promise<StatusRun | null> {
  const command = statusCommandOf(team.statusCommand);
  if (!command) return Promise.resolve(null);
  const running = inFlight.get(store.dir);
  if (running) return running;
  const run = (async () => {
    if (await whyNotRun(project, () => store.state())) return null;
    const result = await runStatusCommand(command, project.directory, timeoutMs);
    // A record that fails to write must not cost the round its status.
    await writeFileAtomic(path.join(store.dir, TEAM_FILES.status), JSON.stringify({ command, ranAt: new Date().toISOString(), ...result })).catch(() => {});
    return result;
  })()
    .catch((e: Error) => ({ output: "", failure: failed(e.message) }))
    .finally(() => inFlight.delete(store.dir));
  inFlight.set(store.dir, run);
  return run;
}

/** The status block for the lead's round, one line (typed text is one line anyway), or null when nothing ran. */
export async function statusSection(team: StatusTeam): Promise<string | null> {
  const run = await statusRun(team);
  if (!run) return null;
  const lines = [...run.output.split("\n"), run.failure ?? ""].map((l) => l.trim()).filter(Boolean);
  return `${STATUS_SECTION_TITLE}: ${lines.length ? lines.join(" | ") : "no output"}`;
}

/** `aya team stats`: the saved command and the last run of it the round recorded (status.json's text), never a run
 *  of its own; null for a team with no status command. */
export function statusForStats(statusCommand: string | undefined, recorded: string | null): StatsStatus | null {
  const command = statusCommandOf(statusCommand);
  if (!command) return null;
  let last: Partial<Record<keyof StatsStatus, unknown>> = {};
  try {
    last = JSON.parse(recorded ?? "{}") as typeof last;
  } catch {
    // A torn record: not run yet.
  }
  if (last.command !== command || typeof last.ranAt !== "string" || typeof last.output !== "string") return { command, ranAt: null, output: "", failure: null };
  return { command, ranAt: last.ranAt, output: last.output, failure: typeof last.failure === "string" ? last.failure : null };
}

export function formatStatusForStats(s: StatsStatus): string {
  const lines = ["", STATUS_SECTION_TITLE, `  command: ${s.command}`];
  if (s.ranAt === null) lines.push("  not run yet: it runs with the lead's rounds of a running local team");
  else lines.push(`  last run ${clock(s.ranAt)}`, ...(s.output ? s.output.split("\n") : ["no output"]).map((l) => `  ${l}`), ...(s.failure ? [`  ${s.failure}`] : []));
  return `${lines.join("\n")}\n`;
}
