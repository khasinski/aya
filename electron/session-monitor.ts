import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MonitoredSession, MonitoredSessionLevel } from "./types";

interface CctopSessionFile {
  session_id?: unknown;
  project_path?: unknown;
  cwd?: unknown;
  project_name?: unknown;
  session_name?: unknown;
  source?: unknown;
  status?: unknown;
  last_activity?: unknown;
  started_at?: unknown;
  last_tool?: unknown;
  last_tool_detail?: unknown;
  notification_message?: unknown;
  hidden?: unknown;
  is_subagent?: unknown;
  ended_at?: unknown;
}

const CCTOP_SESSIONS_DIR = path.join(os.homedir(), ".cctop", "sessions");
const SUPPORTED_SOURCES = new Set(["cc", "codex"]);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readTimestamp(value: unknown): number | null {
  const text = optionalString(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

function mapCctopStatus(status: string): MonitoredSessionLevel {
  switch (status) {
    case "waiting_permission":
    case "waiting_input":
    case "needs_attention":
      return "waiting";
    case "idle":
      return "done";
    case "working":
    case "compacting":
      return "active";
    default:
      return status.includes("waiting") ? "waiting" : "active";
  }
}

function describeSession(raw: CctopSessionFile, level: MonitoredSessionLevel) {
  const notification = optionalString(raw.notification_message);
  if (notification) return notification;
  const tool = optionalString(raw.last_tool);
  const detail = optionalString(raw.last_tool_detail);
  if (tool && detail) return `${tool}: ${detail}`;
  if (tool) return tool;
  switch (level) {
    case "active":
      return "Working";
    case "waiting":
      return "Waiting";
    case "done":
      return "Idle";
    case "error":
      return "Error";
  }
}

export async function listMonitoredSessions(): Promise<MonitoredSession[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(CCTOP_SESSIONS_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry): Promise<MonitoredSession | null> => {
        const filePath = path.join(CCTOP_SESSIONS_DIR, entry);
        try {
          const raw = JSON.parse(
            await fs.readFile(filePath, "utf8"),
          ) as CctopSessionFile;
          if (raw.hidden === true || raw.is_subagent === true) return null;
          if (optionalString(raw.ended_at)) return null;
          const cwd = optionalString(raw.project_path) ?? optionalString(raw.cwd);
          if (!cwd) return null;
          const source = optionalString(raw.source) ?? "cc";
          if (!SUPPORTED_SOURCES.has(source)) return null;
          const status = optionalString(raw.status) ?? "working";
          const level = mapCctopStatus(status);
          const lastActivity =
            readTimestamp(raw.last_activity) ??
            readTimestamp(raw.started_at) ??
            0;
          const id = optionalString(raw.session_id) ?? entry.replace(/\.json$/, "");
          return {
            id,
            source,
            cwd,
            projectName: optionalString(raw.project_name),
            sessionName: optionalString(raw.session_name),
            level,
            text: describeSession(raw, level),
            updatedAt: lastActivity || Date.now(),
          };
        } catch {
          return null;
        }
      }),
  );

  return sessions
    .filter((session): session is MonitoredSession => !!session)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
