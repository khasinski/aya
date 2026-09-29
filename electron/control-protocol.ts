import type { ControlStatusUpdate } from "./types";

export type TeamRequest =
  | { type: "team-whoami" }
  | { type: "team-inbox" }
  | { type: "team-send"; role: string; text: string };

/** Where `aya team new|save` was run, when it is not a pane: AYA_PROJECT_SLUG, cwd. */
interface TeamAuthorScope {
  projectSlug?: string;
  cwd?: string;
}

export type TeamAuthorRequest =
  | ({ type: "team-guide"; description?: string } & TeamAuthorScope)
  | ({ type: "team-save"; text: string; replace: boolean } & TeamAuthorScope);

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
  | TeamAuthorRequest;

/** The calling pane (AYA_TERMINAL_ID / AYA_PRESET_ID), sent with every request
 *  to measure adoption per harness (#117); absent outside Aya. */
export interface ControlCaller {
  terminalId?: string;
  presetId?: string;
  /** "hook" when the call comes from Aya's automatic-status hook, not the agent. */
  via?: string;
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
  return {
    ...(terminalId ? { terminalId } : {}),
    ...(presetId ? { presetId } : {}),
    ...(via ? { via } : {}),
  };
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
    return { type, role, text };
  }
  if (type === "team-guide" || type === "team-save") {
    const scope = { projectSlug: optionalString(value.projectSlug), cwd: optionalString(value.cwd) };
    if (type === "team-guide") return { type, description: optionalString(value.description), ...scope };
    const text = optionalString(value.text);
    if (!text) throw new Error("team-save needs the team file's text");
    return { type, text, replace: value.replace === true, ...scope };
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
