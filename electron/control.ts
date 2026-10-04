import type { BrowserWindow } from "electron";
import { oneAtATime } from "./keyed-queue";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { recordAgentStatus } from "./agent-status";
import { STATUS_TABLE_SHARE_MS, daemonIdentity, foreignPaneIdentity, paneAbove, processTable, unprovenIdentity } from "./caller-proof";
import { capabilitiesDocument } from "./capabilities";
import {
  parseControlCaller,
  parseControlRequest,
  type ControlCaller,
  type ControlRequest,
} from "./control-protocol";
import {
  formatPaneList,
  listPanes,
  resolvePaneTarget,
  tailForPaneRead,
} from "./pane-target";
import { AYA_HOME, CONTROL_SOCKET_PATH, SOCKET_FILE_PERMISSIONS } from "./paths";
import { handleMachinesRequest, type MachinesDeps } from "./machines";
import { confirmAddInAya } from "./machines-dialog";
import { handleTeamAuthorRequest } from "./team-author";
import { HOLD_BUSY, HOLD_DRAFT, isDialogHold } from "./pane-holds";
import { debugAnswer } from "./team-debug";
import { handleTeamRequest, oneLine, PaneHeldError, TEAMS_UNAVAILABLE, TextPastedError, TryAgainError, type TeamControlDeps } from "./team-control";
import { handleTeamPanesRequest, THIS_PANE, type TeamPaneDeps } from "./team-panes";
import type { TeamRunner } from "./team-runner";
import type { ControlStatusUpdate, ProjectConfig, PtyEvent } from "./types";

// Max control-socket message size before rejecting the request (bytes).
export const CONTROL_REQUEST_MAX_SIZE_BYTES = 64_000;

/** Idle window before an unfinished request is reaped; a dispatched pane-send
 *  is exempt, so this only drops peers that never finish a frame. */
export const CONTROL_CONNECTION_IDLE_MS = 30_000;

/** How long the caller waits for an open to reach a loaded page; after that it
 *  hears ok:false, but delivery goes on (dropping a cold-start open is worse). */
export const OPEN_DELIVERY_TIMEOUT_MS = 15_000;

/** Backstop linger after our FIN, for a peer still writing. */
export const CONTROL_LINGER_MS = 2_000;

/** 150 ms idle gap before pane-send's Enter: in one chunk it reads as a paste and
 *  never submits. Measured: codex-cli 0.153.4 needs 50 ms, Claude Code 120 ms. */
export const PANE_SEND_SUBMIT_DELAY_MS = 150;

// Claude redraws its composer a moment after Enter: until then the screen still shows our line.
export const SUBMIT_ECHO_GRACE_MS = 3000;
const SUBMIT_ECHO_POLL_MS = 50;

/** How long after its Enter a team message has to show that it started a turn. No recorded submit
 *  measures it (no model calls); twice the most Claude takes to redraw its composer. */
export const TURN_START_WINDOW_MS = 2 * SUBMIT_ECHO_GRACE_MS;
const TURN_START_POLL_MS = 100;
export const TURN_NOT_SEEN = "typed, not seen to start a turn";
const TURN_MET_DIALOG = (hold: string) => `typed, but a dialog came up after its Enter: ${hold}`;

/** What the pane shows after a team message's Enter: whether the agent took it. */
export interface TurnProbe {
  /** The terminal host's own hold (not settledAfterSubmit's: that one waits out Aya's echo). */
  hold: (terminalId: string, pasted?: string) => Promise<string | null>;
  /** Moves whenever the pane writes output. */
  outputMark: (terminalId: string) => number;
  /** Whether the pane's output paused within the last second: only then is output after Enter a sign. */
  outputPaused: (terminalId: string) => boolean;
  windowMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Bracketed-paste markers; src/snippet-payload.ts names the same pair. */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** Anywhere a status update can be delivered: real BrowserWindows plus the
 *  Aya Web server's virtual sink (which fans out to WebSocket clients). */
export interface ControlStatusSink {
  isDestroyed(): boolean;
  webContents: {
    send(channel: "control:status", update: ControlStatusUpdate): void;
  };
}

export interface ControlServerOptions {
  /** Target for focus/notification actions (the focused/last-focused window). */
  getWindow: () => BrowserWindow | null;
  /** On-disk project configs, for resolving a pane name to a terminal id. */
  listProjects?: () => Promise<ProjectConfig[]>;
  /** Recent output of one pane. Backed by the pty-host's rolling buffer. */
  readPane?: (terminalId: string) => Promise<string>;
  /** Write bytes to one pane's PTY. Only `false` means not delivered; anything
   *  else - including `undefined` - counts as delivered. */
  writePane?: (terminalId: string, data: string) => Promise<boolean | void>;
  /** All live windows (and window-like sinks); status updates are broadcast
   *  because the terminal they describe may be in an unfocused window. */
  getWindows?: () => ControlStatusSink[];
  /** Settles once the open reached a loaded page; rejects with the reason. */
  openProject: (directory: string) => Promise<void> | void;
  /** Every parsed request, with the pane it came from (adoption, #117); awaited before the request runs. */
  onRequest?: (request: ControlRequest, caller: ControlCaller) => void | Promise<void>;
  /** What `aya team` runs on (the same deps as the team runner); teams are off without it. */
  team?: TeamControlDeps;
  /** Told of a team saved with aya team save, as after the Teams window's Save. */
  teamRunner?: Pick<TeamRunner, "refresh" | "pause">;
  /** What aya presets and aya team open run on, as the Teams window's Apply panes. */
  teamPanes?: TeamPaneDeps;
  /** The process a pane runs: null when it has none, undefined when the host cannot say (it predates the request). */
  panePid?: (terminalId: string) => Promise<number | null | undefined>;
  /** Where aya machines keeps its registry, finds ~/.ssh/config and asks the user; by default the Aya config home, the user's home and Aya's dialog. */
  machines?: MachinesDeps;
  /** Test-only override of the process table read for the ancestry check. */
  processTable?: typeof processTable;
  /** Test-only override of the idle reap window. */
  idleTimeoutMs?: number;
  /** Test-only override of OPEN_DELIVERY_TIMEOUT_MS. */
  openTimeoutMs?: number;
}

function focusWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

/** Whether the reply was handed to the socket: false when the peer is gone (EPIPE) or the socket closed. */
function sendJson(socket: net.Socket, value: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve(false);
    socket.write(`${JSON.stringify(value)}\n`, (err) => resolve(!err));
  });
}

/** pane-read / pane-send: let one terminal observe or drive another. Both
 *  resolve their target the same way and fail loudly on an ambiguous name. */
async function handlePaneRequest(
  request: Extract<ControlRequest, { type: "pane-read" | "pane-send" }>,
  options: ControlServerOptions,
): Promise<Record<string, unknown> | void> {
  if (!options.listProjects || !options.readPane || !options.writePane) {
    throw new Error("pane control is not available");
  }
  const projects = await options.listProjects();
  const resolved = resolvePaneTarget(projects, {
    terminalId: request.targetId,
    name: request.target,
    projectSlug: request.projectSlug,
  });
  if (!resolved.ok) throw new Error(resolved.error);
  const { terminalId, projectSlug, name } = resolved.match;

  if (request.type === "pane-read") {
    const output = await options.readPane(terminalId);
    return { terminalId, projectSlug, name, output: tailForPaneRead(output) };
  }
  await deliverToPane(options.writePane, terminalId, name, request.text, request.submit === true);
  return { terminalId, projectSlug, name };
}

const lastSubmitted = new Map<string, { text: string; at: number }>();

/** A hold read that does not take Aya's own just-submitted line, still on screen, for the
 *  user's draft: it waits (up to the grace) for the composer to clear, and reports a real draft at once. */
export function settledAfterSubmit(
  hold: (terminalId: string, pasted?: string) => Promise<string | null>,
  { graceMs = SUBMIT_ECHO_GRACE_MS, pollMs = SUBMIT_ECHO_POLL_MS }: { graceMs?: number; pollMs?: number } = {},
): typeof hold {
  return async (terminalId, pasted) => {
    let reason = await hold(terminalId, pasted);
    while (pasted === undefined && reason === HOLD_DRAFT) {
      const echo = lastSubmitted.get(terminalId);
      if (!echo || Date.now() - echo.at >= graceMs || (await hold(terminalId, echo.text)) !== null) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      reason = await hold(terminalId);
    }
    return reason;
  };
}

/** A team message as a bracketed paste (typed raw, Codex swallowed the Enter), then Enter; holds and Pause are checked
 *  under the pane lock and again before Enter, which on a dialog approves it. `probe`: resolves to why no turn was seen. */
export function deliverTeamMessage(
  writePane: NonNullable<ControlServerOptions["writePane"]>,
  terminalId: string,
  text: string,
  holdReason?: (terminalId: string, pasted?: string) => Promise<string | null>,
  cancelled?: () => boolean,
  probe?: TurnProbe,
  entered?: () => Promise<void>,
  pasting?: () => Promise<void>,
): Promise<string | null> {
  const pasted = oneLine(text);
  const guard = async () => {
    const hold = await holdReason?.(terminalId);
    if (hold) throw new PaneHeldError(hold);
    await pasting?.();
    // Paused or changed while this waited for the pane lock: nothing is typed (no await between here and the paste).
    if (cancelled?.()) throw new PaneHeldError("the team was paused or changed before it was typed; nothing typed", false);
  };
  const beforeEnter = async () => {
    if (cancelled?.()) throw new PaneHeldError("the team was paused or changed while it was typed; text left in the composer, Enter not sent", true);
    const hold = await holdReason?.(terminalId, pasted);
    if (hold && hold !== HOLD_DRAFT) {
      throw new PaneHeldError(`${hold}; it appeared after the text was typed; text left in the composer, Enter not sent`, true);
    }
  };
  let before: { draft: boolean; mark: number; paused: boolean } | undefined;
  const snapshot = probe
    ? async () => {
        await beforeEnter();
        before = { draft: (await probe.hold(terminalId)) === HOLD_DRAFT, mark: probe.outputMark(terminalId), paused: probe.outputPaused(terminalId) };
      }
    : beforeEnter;
  let unseen: string | null = null;
  const afterEnter = async () => {
    await entered?.();
    if (probe) unseen = await turnUnseen(probe, terminalId, pasted, before!);
  };
  return deliverToPane(writePane, terminalId, terminalId, `${PASTE_START}${pasted}${PASTE_END}`, true, guard, snapshot, afterEnter).then(() => {
    // Text the agent did not take still sits there: the next read must see it as a draft at once.
    if (!unseen) lastSubmitted.set(terminalId, { text: pasted, at: Date.now() });
    return unseen;
  });
}

/** Why the Enter just sent started no turn, or null: a dialog came up, or for the whole window the composer kept the
 *  text (when shown) or a pane whose output had paused wrote nothing (Grok idle writes ~14 times a second). */
async function turnUnseen(probe: TurnProbe, terminalId: string, pasted: string, before: { draft: boolean; mark: number; paused: boolean }): Promise<string | null> {
  const sleep = probe.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited < (probe.windowMs ?? TURN_START_WINDOW_MS); waited += TURN_START_POLL_MS) {
    await sleep(TURN_START_POLL_MS);
    const shown = await probe.hold(terminalId, pasted);
    if (isDialogHold(shown)) return TURN_MET_DIALOG(shown);
    if (before.draft ? tookTheText(await probe.hold(terminalId)) : before.paused && probe.outputMark(terminalId) !== before.mark) return null;
  }
  return TURN_NOT_SEEN;
}

// The composer no longer holds the text: free, or busy (agy draws its turn without its composer).
const tookTheText = (hold: string | null): boolean => hold === null || hold === HOLD_BUSY;

/** A gap in a pane's output this long is a pause; output after Enter is a sign only within OUTPUT_PAUSE_WITHIN_MS of one. */
export const OUTPUT_PAUSE_MS = 300;
export const OUTPUT_PAUSE_WITHIN_MS = 1_000;

/** Counts each pane's output from the host's event stream, and when its last pause ended, for TurnProbe. */
export function paneOutputMarks(now: () => number = Date.now): {
  sink: { isDestroyed(): boolean; send(channel: "pty:event", event: PtyEvent): void };
  mark: (terminalId: string) => number;
  outputPaused: (terminalId: string) => boolean;
} {
  const marks = new Map<string, { count: number; last: number; pauseEnded: number }>();
  return {
    sink: {
      isDestroyed: () => false,
      send: (_channel, event) => {
        if (event.type === "data" && !event.replay) {
          const at = now();
          const prior = marks.get(event.ptyId);
          const pauseEnded = !prior || at - prior.last >= OUTPUT_PAUSE_MS ? at : prior.pauseEnded;
          marks.set(event.ptyId, { count: (prior?.count ?? 0) + 1, last: at, pauseEnded });
        } else if (event.type === "exit") marks.delete(event.ptyId);
      },
    },
    mark: (terminalId) => marks.get(terminalId)?.count ?? 0,
    outputPaused: (terminalId) => {
      const m = marks.get(terminalId);
      return !m || now() - m.last >= OUTPUT_PAUSE_MS || now() - m.pauseEnded <= OUTPUT_PAUSE_WITHIN_MS;
    },
  };
}

/** Types text into a pane, then Enter when `submit`. Serialized per terminal:
 *  the 150 ms submit gap splits a send into two writes that must not interleave. */
function deliverToPane(
  writePane: NonNullable<ControlServerOptions["writePane"]>,
  terminalId: string,
  name: string,
  text: string,
  submit: boolean,
  guard?: () => Promise<void>,
  beforeEnter?: () => Promise<void>,
  afterEnter?: () => Promise<void>,
): Promise<void> {
  return withPaneLock(terminalId, async () => {
    await guard?.();
    // Raw bytes, unlike the snippet drawer's bracketed paste: macOS bash 3.2 has
    // none and would take the markers as command text. "\r" is Enter, not "\n".
    if ((await writePane(terminalId, text)) === false) {
      throw new Error(
        `pane "${name}" did not accept the text - it may have exited, or be starting up with a full input queue. Nothing was submitted; check the pane before retrying.`,
      );
    }
    if (submit) {
      try {
        await new Promise((resolve) =>
          setTimeout(resolve, PANE_SEND_SUBMIT_DELAY_MS),
        );
        await beforeEnter?.();
        if ((await writePane(terminalId, "\r")) === false) throw new TextPastedError(`pane "${name}" exited before the text was submitted`);
      } catch (err) {
        if (err instanceof TextPastedError || err instanceof PaneHeldError) throw err;
        throw new TextPastedError(`pane "${name}" did not take the Enter after the text: ${err instanceof Error ? err.message : err}`);
      }
      // Under the lock: the next paste must not be read as this one's composer.
      await afterEnter?.();
    }
  });
}

/** One pane-send per terminal at a time: each finishes its text, gap and Enter before the next begins. */
const withPaneLock = oneAtATime();

/** Requests that speak as the pane's role, so its id must be proven, not just carried. */
const SPEAKS_AS_PANE = new Set<ControlRequest["type"]>(["team-whoami", "team-inbox", "team-send", "team-pause"]);

/** Also team-open when a role goes to "this": the caller's id picks the pane that gets it. */
const speaksAsPane = (request: ControlRequest): boolean =>
  SPEAKS_AS_PANE.has(request.type) || (request.type === "team-open" && request.panes.some((p) => p.target === THIS_PANE));

/** Requests that act on the pane or project whose id they carry: a Codex daemon's id may be another project's pane.
 *  `status` too: a question is a team's signal, it holds the named pane's rounds. */
const ACTS_ON_PANE_PROJECT = new Set<ControlRequest["type"]>(["team-save", "team-open", "team-start", "status"]);

async function daemonRefusal(caller: ControlCaller, options: ControlServerOptions, shareMs?: number): Promise<string | null> {
  if (!caller.terminalId || !caller.pid) return null;
  const read = options.processTable ?? ((pid: number) => processTable(pid, undefined, shareMs));
  const table = await read(caller.pid);
  return table ? daemonIdentity(caller, table) : null;
}

/** Why the caller's process does not run under its pane's process, else null; also null
 *  when nothing can be shown (older CLI, unknown pane, `ps` silent). */
async function identityRefusal(caller: ControlCaller, options: ControlServerOptions): Promise<string | null> {
  const { terminalId: id, pid: callerPid } = caller;
  if (!id || !callerPid || !options.panePid) return null;
  const pid = await options.panePid(id);
  if (pid === undefined) return null;
  const hasLocalTab = async () => (await options.listProjects?.())?.some((p) => !p.remote && p.tabs.some((t) => t.id === id));
  if (pid === null && !(await hasLocalTab())) return null;
  const table = await (options.processTable ?? processTable)(callerPid);
  return table ? unprovenIdentity(caller, pid, table) : null;
}

/** The session the pane's agent runs, as the project file has it, when known. */
async function paneSession(terminalId: string, options: ControlServerOptions): Promise<string | undefined> {
  const projects = await options.listProjects?.().catch(() => []);
  return projects?.flatMap((p) => p.tabs).find((t) => t.id === terminalId)?.sessionId;
}

/** The local pane the caller's process runs under, from the process tree; null when none or unknown. */
async function paneUnder(caller: ControlCaller, options: ControlServerOptions): Promise<string | null> {
  if (!caller.pid || !options.panePid || !options.listProjects) return null;
  const table = await (options.processTable ?? processTable)(caller.pid);
  if (!table) return null;
  const pids = new Map<number, string>();
  for (const project of await options.listProjects()) {
    if (project.remote) continue;
    for (const tab of project.tabs) {
      const pid = await options.panePid(tab.id);
      if (pid) pids.set(pid, tab.id);
    }
  }
  return paneAbove(caller.pid, table, pids);
}

/** Requests that act as the role of the pane whose id they carry (start resumes its pause, save replaces its team file). */
const ACTS_AS_PANE_ROLE = new Set<ControlRequest["type"]>(["team-save", "team-start"]);

async function handleRequest(
  request: ControlRequest,
  caller: ControlCaller,
  options: ControlServerOptions,
): Promise<Record<string, unknown> | void> {
  try {
    await options.onRequest?.(request, caller);
  } catch {
    // measurement must never fail a command
  }
  const refusal = speaksAsPane(request)
    ? await identityRefusal(caller, options)
    : ACTS_ON_PANE_PROJECT.has(request.type)
      ? await daemonRefusal(caller, options, request.type === "status" ? STATUS_TABLE_SHARE_MS : undefined)
      : null;
  if (refusal) throw new Error(refusal);
  const under = ACTS_AS_PANE_ROLE.has(request.type) ? await paneUnder(caller, options) : null;
  const foreign = foreignPaneIdentity(caller.terminalId, under);
  if (foreign) throw new Error(foreign);
  const win = options.getWindow();
  if (request.type === "capabilities") {
    return {
      output: `${JSON.stringify(capabilitiesDocument(caller), null, 2)}\n`,
    };
  }
  if (request.type === "open") {
    const limitMs = options.openTimeoutMs ?? OPEN_DELIVERY_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        options.openProject(path.resolve(request.path)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Aya is still loading after ${limitMs / 1000} s; the project will open once it has loaded`,
                ),
              ),
            limitMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  if (request.type === "machines") {
    const pane = caller.terminalId ? (await options.listProjects?.().catch(() => []))?.flatMap((p) => p.tabs).find((t) => t.id === caller.terminalId)?.name : undefined;
    const deps = options.machines ?? { ayaHome: AYA_HOME, userHome: os.homedir(), confirmAdd: (ask) => confirmAddInAya(ask, options.getWindow()) };
    return { ...(await handleMachinesRequest(request, deps, pane)) };
  }
  if (request.type === "pane-list") {
    if (!options.listProjects) throw new Error("pane control is not available");
    const projects = await options.listProjects();
    const entries = listPanes(projects, {
      projectSlug: request.projectSlug,
      selfTerminalId: request.selfTerminalId,
    });
    return { output: formatPaneList(entries) };
  }
  if (request.type === "pane-read" || request.type === "pane-send") {
    return handlePaneRequest(request, options);
  }
  if (request.type === "team-whoami" || request.type === "team-send" || request.type === "team-inbox" || request.type === "team-pause") {
    if (!options.team) throw new Error(TEAMS_UNAVAILABLE);
    const { teamRunner } = options;
    return handleTeamRequest(request, caller.terminalId, options.team, teamRunner && ((slug, name, by) => teamRunner.pause(slug, name, by)));
  }
  if (request.type === "team-guide" || request.type === "team-save") {
    const { team, teamRunner } = options;
    if (!team || !teamRunner) throw new Error(TEAMS_UNAVAILABLE);
    return handleTeamAuthorRequest(request, caller.terminalId, team, (slug, name) => teamRunner.refresh(slug, name), under !== null);
  }
  if (request.type === "presets" || request.type === "team-open" || request.type === "team-start") {
    if (!options.teamPanes) throw new Error(TEAMS_UNAVAILABLE);
    // A role's pane may not resume a pause that is not its own: the process tree tells it, even with its id unset
    // (an id naming another pane than the tree's was refused above).
    const from = caller.terminalId ?? under;
    const panes = request.type === "team-start" ? (from ? [from] : []) : undefined;
    return handleTeamPanesRequest(request, caller.terminalId, options.teamPanes, panes);
  }
  if (request.type === "focus") {
    focusWindow(win);
    return;
  }
  if (request.type === "notify") {
    // Lazy: plain Node tests import this module and must not load Electron.
    const { Notification } = require("electron") as typeof import("electron");
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: request.title || "Aya",
      body: request.body,
      silent: false,
    });
    notification.on("click", () => {
      const current = options.getWindow();
      focusWindow(current);
      if (
        current &&
        !current.isDestroyed() &&
        request.terminalId &&
        request.projectSlug
      ) {
        current.webContents.send("notification:select-terminal", {
          projectSlug: request.projectSlug,
          terminalId: request.terminalId,
        });
      }
    });
    notification.show();
    return;
  }
  if (request.type === "status") {
    // A question belongs to the agent life that asked it: the pane's session goes with it (agent-status settleRestored).
    const session = request.terminalId && request.level === "waiting" ? await paneSession(request.terminalId, options) : undefined;
    const told = request.terminalId ? recordAgentStatus(request.terminalId, request.level, Date.now(), request.text, caller.via, session) : request;
    if (!told) return;
    const update: ControlStatusUpdate = {
      terminalId: request.terminalId,
      projectSlug: request.projectSlug,
      cwd: request.cwd,
      level: told.level,
      text: request.text,
      updatedAt: Date.now(),
    };
    const targets = options.getWindows?.() ?? (win ? [win] : []);
    for (const target of targets) {
      if (!target.isDestroyed()) {
        target.webContents.send("control:status", update);
      }
    }
  }
}

/** Boot the control server on an explicit socket path, with no Electron
 *  lifecycle dependency, so tests can drive it against a tmp socket. */
export function startControlServerOn(
  socketPath: string,
  options: ControlServerOptions,
): () => void {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    // best effort
  }

  // allowHalfOpen: a client that does `socket.end(frame)` FINs immediately, and
  // without this its FIN ends our writable side and drops the reply 150 ms later.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = "";
    // One request per connection; otherwise later bytes re-run the same request.
    let handled = false;
    // Answer written and our FIN sent; nothing more is owed.
    let replied = false;
    socket.setEncoding("utf8");
    // Unlistened "error" is an uncaught exception in the Electron main process.
    socket.on("error", () => {
      handled = true;
    });
    socket.on("end", () => {
      // Destroy unless we still owe a reply - that window is why allowHalfOpen is on.
      if (!handled || replied) socket.destroy();
    });
    socket.setTimeout(options.idleTimeoutMs ?? CONTROL_CONNECTION_IDLE_MS, () => {
      if (!handled) socket.destroy();
    });
    /** Reply + FIN, then let the peer drain (destroying now would EPIPE a client
     *  still pushing an oversized frame); linger backstops a peer that never ends. */
    const finish = (): void => {
      replied = true;
      socket.end();
      socket.setTimeout(CONTROL_LINGER_MS, () => socket.destroy());
    };
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > CONTROL_REQUEST_MAX_SIZE_BYTES) {
        // handled FIRST: later chunks of the oversized frame would otherwise
        // write onto the socket we just ended (ERR_STREAM_WRITE_AFTER_END).
        handled = true;
        buffer = "";
        void sendJson(socket, { ok: false, error: "request too large" });
        finish();
        return;
      }
      if (!buffer.includes("\n")) return;
      const line = buffer.slice(0, buffer.indexOf("\n")).trim();
      handled = true;
      buffer = "";
      void (async () => {
        try {
          const raw: unknown = JSON.parse(line);
          const [request, caller] = [parseControlRequest(raw), parseControlCaller(raw)];
          const { undo, ...payload } = (await debugAnswer(options.team, request, caller, handleRequest(request, caller, options))) ?? {};
          if (!(await sendJson(socket, { ok: true, ...payload })) && typeof undo === "function") await undo();
        } catch (err) {
          void sendJson(socket, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            ...(err instanceof TryAgainError ? { retry: true } : {}),
          });
        } finally {
          finish();
        }
      })();
    });
  });

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, SOCKET_FILE_PERMISSIONS);
    } catch {
      // best effort
    }
  });

  return () => {
    server.close();
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      // best effort
    }
  };
}

export function startControlServer(options: ControlServerOptions): () => void {
  const { app } = require("electron") as typeof import("electron");
  const stop = startControlServerOn(CONTROL_SOCKET_PATH, options);
  app.once("before-quit", stop);
  return stop;
}
