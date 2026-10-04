import type { ControlStatusUpdate, PanePick } from "./types";

export type TeamRequest =
  | { type: "team-whoami" }
  | { type: "team-inbox" }
  | { type: "team-send"; role: string; text: string }
  | { type: "team-pause"; text?: string };

/** Where `aya team new|save` was run, when it is not a pane: AYA_PROJECT_SLUG, cwd. */
interface TeamAuthorScope {
  projectSlug?: string;
  cwd?: string;
}

export type TeamAuthorRequest =
  | ({ type: "team-guide"; description?: string } & TeamAuthorScope)
  | ({ type: "team-save"; text: string; replace: boolean } & TeamAuthorScope);

/** Read-only: no team names the caller pane's team, else the project's only saved one. */
export type TeamShowRequest = { type: "team-show"; team?: string; json: boolean } & TeamAuthorScope;

export type TeamPanesRequest =
  | { type: "presets"; json: boolean }
  | ({ type: "team-open"; team: string; panes: PanePick[]; replace: boolean } & TeamAuthorScope)
  | ({ type: "team-start"; team: string; task?: string; to?: string } & TeamAuthorScope);

export type ControlRequest =
  | { type: "open"; path: string }
  | { type: "focus" }
  | {
      type: "notify";
      title?: string;
      body: string;
      terminalId?: string;
      projectSlug?: string;
    }
  | {
      type: "status";
      level: ControlStatusUpdate["level"];
      text?: string;
      terminalId?: string;
      projectSlug?: string;
      cwd?: string;
    }
  // Read another pane's recent output. `target`/`targetId` name the pane; the
  // caller's own project scopes a name lookup.
  | {
      type: "pane-read";
      target?: string;
      targetId?: string;
      projectSlug?: string;
    }
  // Type into another pane. `submit` appends a carriage return, i.e. presses
  // Enter — without it the text is left on the pane's input line.
  | {
      type: "pane-send";
      target?: string;
      targetId?: string;
      projectSlug?: string;
      text: string;
      submit?: boolean;
    }
  // List the panes/agents in the caller's project (or all projects when no
  // slug). `selfTerminalId` marks the caller's own pane in the output.
  | {
      type: "pane-list";
      projectSlug?: string;
      selfTerminalId?: string;
    }
  | { type: "capabilities" }
  | TeamRequest
  | TeamAuthorRequest
  | TeamShowRequest
  | TeamPanesRequest;

/** The calling pane (AYA_TERMINAL_ID / AYA_PRESET_ID), sent with every request
 *  to measure adoption per harness (#117); absent outside Aya. */
export interface ControlCaller {
  terminalId?: string;
  presetId?: string;
  /** "hook" when the call comes from Aya's automatic-status hook, not the agent. */
  via?: string;
  /** The `aya` process itself, so Aya can check it runs under the pane it names (caller-proof.ts). */
  pid?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseControlCaller(value: unknown): ControlCaller {
  if (!isRecord(value) || !isRecord(value.caller)) return {};
  const terminalId = optionalString(value.caller.terminalId);
  const presetId = optionalString(value.caller.presetId);
  const via = optionalString(value.caller.via);
  const pid = value.caller.pid;
  return {
    ...(terminalId ? { terminalId } : {}),
    ...(presetId ? { presetId } : {}),
    ...(via ? { via } : {}),
    ...(typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? { pid } : {}),
  };
}

export function panePick(value: unknown): PanePick {
  const role = isRecord(value) ? optionalString(value.role) : undefined;
  const target = isRecord(value) ? optionalString(value.target) : undefined;
  if (!role || !target) throw new Error("each pane needs a role and a target");
  return { role, target };
}

/** Longest team message or Start task: every one is typed into a pane and kept in the team's log. */
export const TEAM_MESSAGE_MAX_CHARS = 8_000;

export function assertTeamTextFits(text: string, what = "message"): void {
  if (text.length > TEAM_MESSAGE_MAX_CHARS) {
    throw new Error(`the ${what} is ${text.length} characters, the most is ${TEAM_MESSAGE_MAX_CHARS}; shorten it, or put the detail in a file in the repo and send its path; nothing was sent`);
  }
}

export function parseControlRequest(value: unknown): ControlRequest {
  if (!isRecord(value)) throw new Error("request must be an object");
  const type = optionalString(value.type);
  if (type === "open") {
    const target = optionalString(value.path);
    if (!target) throw new Error("open.path is required");
    return { type, path: target };
  }
  if (type === "focus") return { type };
  if (type === "team-whoami" || type === "team-inbox") return { type };
  if (type === "team-send") {
    const role = optionalString(value.role);
    const text = typeof value.text === "string" ? value.text : "";
    if (!role || !text) throw new Error("team-send needs a role and text");
    assertTeamTextFits(text);
    return { type, role, text };
  }
  if (type === "team-pause") {
    const text = optionalString(value.text);
    if (text) assertTeamTextFits(text, "reason");
    return { type, ...(text ? { text } : {}) };
  }
  const scope = { projectSlug: optionalString(value.projectSlug), cwd: optionalString(value.cwd) };
  if (type === "team-guide" || type === "team-save") {
    if (type === "team-guide") return { type, description: optionalString(value.description), ...scope };
    const text = optionalString(value.text);
    if (!text) throw new Error("team-save needs the team file's text");
    return { type, text, replace: value.replace === true, ...scope };
  }
  if (type === "team-show") {
    const team = optionalString(value.team);
    return { type, ...(team ? { team } : {}), json: value.json === true, ...scope };
  }
  if (type === "presets") return { type, json: value.json === true };
  if (type === "team-open") {
    const team = optionalString(value.team);
    const panes = Array.isArray(value.panes) ? value.panes.map(panePick) : [];
    if (!team) throw new Error("team-open needs a team");
    return { type, team, panes, replace: value.replace === true, ...scope };
  }
  if (type === "team-start") {
    const team = optionalString(value.team);
    if (!team) throw new Error("team-start needs a team");
    const task = optionalString(value.task);
    if (task) assertTeamTextFits(task, "task");
    const to = optionalString(value.to);
    return { type, team, ...(task ? { task } : {}), ...(to ? { to } : {}), ...scope };
  }
  if (type === "capabilities") return { type };
  if (type === "notify") {
    const body = optionalString(value.body);
    if (!body) throw new Error("notify.body is required");
    return {
      type,
      body,
      title: optionalString(value.title),
      terminalId: optionalString(value.terminalId),
      projectSlug: optionalString(value.projectSlug),
    };
  }
  if (type === "status") {
    const level = optionalString(value.level);
    if (
      level !== "active" &&
      level !== "waiting" &&
      level !== "done" &&
      level !== "error" &&
      level !== "clear"
    ) {
      throw new Error("status.level must be active, waiting, done, error, or clear");
    }
    return {
      type,
      level,
      text: optionalString(value.text),
      terminalId: optionalString(value.terminalId),
      projectSlug: optionalString(value.projectSlug),
      cwd: optionalString(value.cwd),
    };
  }
  if (type === "pane-list") {
    return {
      type,
      projectSlug: optionalString(value.projectSlug),
      selfTerminalId: optionalString(value.selfTerminalId),
    };
  }
  if (type === "pane-read" || type === "pane-send") {
    const target = optionalString(value.target);
    const targetId = optionalString(value.targetId);
    if (!target && !targetId) {
      throw new Error(`${type} requires target or targetId`);
    }
    const common = {
      target,
      targetId,
      projectSlug: optionalString(value.projectSlug),
    };
    if (type === "pane-read") return { type, ...common };
    // Empty text is rejected rather than treated as a bare Enter: "send
    // nothing" is almost always a caller bug, and a stray Enter into an agent
    // pane can accept whatever prompt happens to be on screen.
    const text = typeof value.text === "string" ? value.text : "";
    if (!text) throw new Error("pane-send.text is required");
    return { type, ...common, text, submit: value.submit === true };
  }
  throw new Error("unknown control request type");
}
