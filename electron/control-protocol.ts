import type { ControlStatusUpdate } from "./types";

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
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
