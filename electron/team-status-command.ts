// A team's "## Status command": project state Aya cannot know (which models a server has loaded, who shares the GPU),
// run in the project directory and handed to the lead with its round. The CLI's team stats loads this with plain node.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { withoutSessionMarkers } from "./pane-command";
import type { TeamDefinition } from "./types";

export const STATUS_COMMAND_TIMEOUT_MS = 20_000;
export const STATUS_OUTPUT_MAX_BYTES = 2048;
export const STATUS_SECTION_TITLE = "Status (from the team's command)";

/** What statusSection needs of a team: TeamRunner's `open` gives exactly these. */
export interface StatusTeam {
  project: { directory: string; remote?: unknown };
  store: { dir: string; state(): Promise<{ paused: boolean; running: boolean }> };
  team: Pick<TeamDefinition, "statusCommand">;
}

/** How the command ended: `failure` is null when it exited 0. */
export interface StatusRun {
  output: string;
  failure: string | null;
}

// A pane's identity in the command's env would let its `aya` calls act as that pane (a nested Aya Dev inherits one).
const PANE_VARS = ["AYA_TERMINAL_ID", "AYA_PRESET_ID", "AYA_PROJECT_SLUG", "AYA_PROJECT_DIR"];

export function statusCommandEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const plain = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));
  const out = withoutSessionMarkers(plain);
  for (const key of PANE_VARS) delete out[key];
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
      resolve({ output: "", failure: `status command failed: ${(e as Error).message}` });
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
    child.on("error", (e) => finish(`status command failed: ${e.message}`));
    child.on("close", (code, signal) => finish(code === 0 ? null : `status command failed: ${signal ? `killed by ${signal}` : `exit ${code}`}`));
  });
}

// One run per team directory: a round and a stats call made while it runs share it.
const inFlight = new Map<string, Promise<StatusRun | null>>();

/** The command's run for a running local team, else null; calls made while one runs share it. */
export function statusRun({ project, store, team }: StatusTeam, timeoutMs = STATUS_COMMAND_TIMEOUT_MS): Promise<StatusRun | null> {
  const command = team.statusCommand?.trim();
  if (!command) return Promise.resolve(null);
  const running = inFlight.get(store.dir);
  if (running) return running;
  const run = (async () => {
    // A remote project's directory is on another machine; a paused or unstarted team gets no rounds to carry it.
    if (project.remote || !(await store.state()).running) return null;
    return runStatusCommand(command, project.directory, timeoutMs);
  })()
    .catch((e: Error) => ({ output: "", failure: `status command failed: ${e.message}` }))
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

/** `aya team stats`: the block it prints, from the team directory `dir` (<home>/teams/<slug>/<team>), its saved
 *  definition and state.json; null for a team with no status command. */
export async function statusForStats(dir: string, statusCommand: string | undefined, state: { paused: boolean; running: boolean }): Promise<{ command: string; output: string; failure: string | null; notRun: string | null } | null> {
  if (!statusCommand) return null;
  const slug = path.basename(path.dirname(dir));
  const projectFile = path.join(dir, "..", "..", "..", "projects", `${slug}.json`);
  let project: { directory?: unknown; remote?: unknown } = {};
  try {
    project = JSON.parse(await fs.readFile(projectFile, "utf8")) as typeof project;
  } catch {
    // No project file: said below.
  }
  const base = { command: statusCommand, output: "", failure: null };
  if (typeof project.directory !== "string") return { ...base, notRun: `project ${slug} is not in Aya's projects` };
  if (project.remote) return { ...base, notRun: "a remote project: the command would run on this machine, not in its directory" };
  if (!state.running) return { ...base, notRun: `the team is ${state.paused ? "paused" : "not started"}; it runs only for a running team` };
  const run = await statusRun({ project: { directory: project.directory }, store: { dir, state: async () => state }, team: { statusCommand } });
  return run ? { ...base, ...run, notRun: null } : { ...base, notRun: "the team is not running" };
}

export function formatStatusForStats(s: NonNullable<Awaited<ReturnType<typeof statusForStats>>>): string {
  const lines = ["", STATUS_SECTION_TITLE, `  command: ${s.command}`];
  if (s.notRun) lines.push(`  not run: ${s.notRun}`);
  else lines.push(...(s.output ? s.output.split("\n") : ["no output"]).map((l) => `  ${l}`), ...(s.failure ? [`  ${s.failure}`] : []));
  return `${lines.join("\n")}\n`;
}
