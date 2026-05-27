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
  throw new Error("unknown control request type");
}
