// What each pane's agent last set with `aya status`: a team lead that asked the user holds the
// rounds. The questions (waiting) are also kept on disk, so a restart does not lose them.

import * as fs from "node:fs";
import * as path from "node:path";
import { HOOK_VIA } from "./constants";
import { AYA_HOME } from "./paths";
import { isDialogHold } from "./pane-holds";
import { PANE_HOLD_UNKNOWN } from "./pty-host-client";
import type { ControlStatusLevel, ControlStatusUpdate, QuestionRestart } from "./types";

const WAITING_FILE = "agent-waiting.json";
// Marks a question the agent asked, not a hook's idle composer (older files hold those too).
const ASKED_BY = "agent";

type Level = ControlStatusLevel | "clear";
interface Latest {
  level: Level;
  at: number;
  text: string;
  /** The pane's session when the agent asked: a question belongs to that agent life. */
  session?: string;
  /** Read from the last life's file: it holds only while the pane runs `session` (settleRestored); "unconfirmed"
   *  once it runs another or an unknown one, then it holds no round and stays only for the user to see. */
  restored?: QuestionRestart;
}
let latest: Map<string, Latest> | null = null;
let unconfirmedListener: ((update: ControlStatusUpdate) => void) | null = null;

const waitingFile = () => path.join(process.env.AYA_HOME?.trim() ? path.resolve(process.env.AYA_HOME) : AYA_HOME, WAITING_FILE);

/** The statuses of this life, with the questions the last life left on disk (a damaged file reads as none). */
function statuses(): Map<string, Latest> {
  if (latest) return latest;
  latest = new Map();
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(waitingFile(), "utf-8"));
    for (const [id, v] of Object.entries(saved && typeof saved === "object" ? saved : {})) {
      const { text, since, by, session, unconfirmed } = v as { text?: unknown; since?: unknown; by?: unknown; session?: unknown; unconfirmed?: unknown };
      if (by === ASKED_BY && typeof text === "string" && typeof since === "number" && Number.isFinite(since)) {
        const restored = unconfirmed === true ? "unconfirmed" : "restored";
        latest.set(id, { level: "waiting", at: since, text, restored, ...(typeof session === "string" && session ? { session } : {}) });
      }
    }
  } catch {
    // no file yet, or not ours: nothing was outstanding
  }
  return latest;
}

function persistWaiting(): void {
  const waiting = Object.fromEntries(
    [...statuses()].flatMap(([id, s]) =>
      s.level === "waiting" ? [[id, { text: s.text, since: s.at, by: ASKED_BY, ...(s.session ? { session: s.session } : {}), ...(s.restored === "unconfirmed" ? { unconfirmed: true } : {}) }]] : [],
    ),
  );
  try {
    if (Object.keys(waiting).length === 0) fs.rmSync(waitingFile(), { force: true });
    else {
      fs.mkdirSync(path.dirname(waitingFile()), { recursive: true });
      fs.writeFileSync(waitingFile(), JSON.stringify(waiting));
    }
  } catch (err) {
    console.warn("[aya] agent questions not saved:", err instanceof Error ? err.message : err);
  }
}

/** Records a status; returns what the windows are told, or null for nothing. Aya's own hooks (`via` hook) report turns:
 *  their Notification fires on an idle composer too, so it is a finished turn, and none ends a question the agent asked. */
export function recordAgentStatus(
  terminalId: string,
  level: Level,
  at: number = Date.now(),
  text = "",
  via?: string,
  session?: string,
): { level: Level; text: string } | null {
  if (via === HOOK_VIA && agentWaitingSince(terminalId) !== null) return null;
  const hadQuestion = statuses().get(terminalId)?.level === "waiting";
  const recorded = via === HOOK_VIA && level === "waiting" ? "done" : level;
  statuses().set(terminalId, { level: recorded, at, text, ...(session ? { session } : {}) });
  if (hadQuestion || recorded === "waiting") persistWaiting();
  return { level: recorded, text };
}

/** When the pane's agent asked the user (`aya status waiting`) and has set nothing else since (epoch ms), else null.
 *  An unconfirmed question from before a restart is not one: it holds nothing. */
export function agentWaitingSince(terminalId: string): number | null {
  const status = statuses().get(terminalId);
  return status?.level === "waiting" && status.restored !== "unconfirmed" ? status.at : null;
}

/** The questions to the user that no one has answered yet, by pane, those from before a restart marked: for a
 *  window that opens (or reopens) later. */
export function outstandingWaiting(): Record<string, { text: string; since: number; restart?: QuestionRestart }> {
  return Object.fromEntries(
    [...statuses()].flatMap(([id, s]) => (s.level === "waiting" ? [[id, { text: s.text, since: s.at, ...(s.restored ? { restart: s.restored } : {}) }]] : [])),
  );
}

export function onQuestionUnconfirmed(listener: (update: ControlStatusUpdate) => void): void {
  unconfirmedListener = listener;
}

/** A question read back after a restart whose pane no longer runs the asking session (or either is unknown) stays shown
 *  but holds no round; its text is returned once, for the team log, else null. */
export function settleRestored(terminalId: string, currentSession: string | undefined): string | null {
  const question = statuses().get(terminalId);
  if (question?.level !== "waiting" || question.restored !== "restored") return null;
  if (question.session && question.session === currentSession) return null;
  question.restored = "unconfirmed";
  persistWaiting();
  unconfirmedListener?.({ terminalId, level: "waiting", text: question.text, updatedAt: question.at, restart: "unconfirmed" });
  return question.text;
}

/** Tests only: read the file again, as a restarted main process does. */
export function __reloadAgentStatusForTests(): void {
  latest = null;
}

/** Tests only: forget this life's statuses and the file. */
export function __resetAgentStatusForTests(): void {
  latest = new Map();
  unconfirmedListener = null;
  fs.rmSync(waitingFile(), { force: true });
}

/** Enter in a pane whose agent asked the user answers it (like `aya status clear`), unless the screen shows the CLI's
 *  own dialog or could not be read (an old host): a later Enter ends it then. Returns the windows' update, or null. */
export async function noteUserAnswer(
  terminalId: string,
  typed: string,
  screenHold: () => Promise<string | null>,
  at: number = Date.now(),
): Promise<ControlStatusUpdate | null> {
  if (statuses().get(terminalId)?.level !== "waiting" || !/[\r\n]/.test(typed)) return null;
  const hold = await screenHold().catch(() => PANE_HOLD_UNKNOWN);
  if (hold === PANE_HOLD_UNKNOWN || isDialogHold(hold)) return null;
  recordAgentStatus(terminalId, "clear", at);
  return { terminalId, level: "clear", updatedAt: at };
}
