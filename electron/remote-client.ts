import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  Preset,
  ProjectConfig,
  RemoteDirectoryEntry,
  RemoteDirectoryListing,
  RemoteHealthResult,
  RemoteHostInfo,
  RemoteProjectCreateResult,
} from "./types";
import type { RemoteMessage } from "./remote-protocol";

const REQUEST_TIMEOUT_MS = 15_000;
// Cap on the base64 bridge child's stdout - bounds the remote snapshot size.
const REMOTE_BRIDGE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const REMOTE_NODE_BRIDGE = `
const net = require("node:net");
const id = process.argv[1];
const payload = Buffer.from(process.argv[2], "base64").toString("utf8");
const socketPath = process.env.AYA_REMOTE_SOCKET ||
  (process.env.AYA_HOME ? process.env.AYA_HOME + "/aya-remote.sock" : process.env.HOME + "/.aya/aya-remote.sock");
const client = net.createConnection(socketPath);
let buffer = "";
let settled = false;
let requestSent = false;
function write(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
function sendRequest() {
  if (requestSent) return;
  requestSent = true;
  client.write(payload + "\\n");
}
function finish(code) {
  if (settled) return;
  settled = true;
  client.end();
  setTimeout(() => process.exit(code), 250);
}
client.setEncoding("utf8");
client.on("data", (chunk) => {
  process.stdout.write(chunk);
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const idx = buffer.indexOf("\\n");
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message && (message.type === "snapshot" || message.code === "snapshot_failed")) {
      sendRequest();
    }
    if (message && message.id === id) finish(0);
  }
});
client.on("error", (err) => {
  write({
    type: "error",
    protocol: 1,
    id,
    code: "app_unavailable",
    message: "Aya is not accepting remote connections at " + socketPath,
    detail: err.code || err.message,
  });
  finish(1);
});
setTimeout(() => {
  write({
    type: "error",
    protocol: 1,
    id,
    code: "timeout",
    message: "Remote Aya timed out.",
  });
  finish(1);
}, ${REQUEST_TIMEOUT_MS});
`.trim();

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireHost(value: unknown): RemoteHostInfo {
  if (!isRecord(value)) throw new Error("Remote host info is invalid.");
  const { id, name, platform, user } = value;
  if (
    typeof id !== "string" ||
    !id ||
    typeof name !== "string" ||
    !name ||
    typeof platform !== "string" ||
    !platform ||
    typeof user !== "string" ||
    !user
  ) {
    throw new Error("Remote host info is invalid.");
  }
  return {
    id,
    name,
    platform: platform as NodeJS.Platform,
    user,
  };
}

function requireDirectoryEntries(value: unknown): RemoteDirectoryEntry[] {
  if (!Array.isArray(value)) throw new Error("Remote directory list is invalid.");
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.path !== "string" ||
      entry.kind !== "directory"
    ) {
      throw new Error("Remote directory entry is invalid.");
    }
    return { name: entry.name, path: entry.path, kind: "directory" };
  });
}

function isProjectConfig(value: unknown): value is ProjectConfig {
  if (!isRecord(value)) return false;
  return (
    typeof value.slug === "string" &&
    typeof value.name === "string" &&
    typeof value.directory === "string" &&
    Array.isArray(value.tabs)
  );
}

function requireProject(value: unknown): ProjectConfig {
  if (!isProjectConfig(value)) {
    throw new Error("Remote project result is invalid.");
  }
  return value;
}

function requireProjects(value: unknown): ProjectConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isProjectConfig);
}

function requireRecentProjectSlugs(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.recent)) return [];
  return value.recent.filter((slug): slug is string => typeof slug === "string");
}

function orderRecentProjects(
  projects: ProjectConfig[],
  recentSlugs: string[],
): ProjectConfig[] {
  const bySlug = new Map(projects.map((project) => [project.slug, project]));
  const ordered = recentSlugs
    .map((slug) => bySlug.get(slug))
    .filter((project): project is ProjectConfig => !!project);
  return ordered.length > 0 ? ordered : projects;
}

function requirePresets(value: unknown): Preset[] {
  if (!Array.isArray(value)) throw new Error("Remote presets are invalid.");
  return value.filter(
    (preset): preset is Preset =>
      isRecord(preset) &&
      typeof preset.id === "string" &&
      typeof preset.name === "string" &&
      typeof preset.icon === "string" &&
      typeof preset.color === "string" &&
      typeof preset.command === "string",
  );
}

function runRemoteRequest(
  sshTarget: string,
  request: Record<string, unknown>,
): Promise<{
  host: RemoteHostInfo;
  presets: Preset[];
  recentProjects: ProjectConfig[];
  response: RemoteMessage;
}> {
  const target = sshTarget.trim();
  if (!target) throw new Error("Remote SSH target is required.");
  const id = randomUUID();
  const payload = Buffer.from(
    JSON.stringify({ ...request, id }),
    "utf8",
  ).toString("base64");
  const remoteCommand = `node -e ${shellQuote(REMOTE_NODE_BRIDGE)} ${shellQuote(
    id,
  )} ${shellQuote(payload)}`;

  return new Promise((resolve, reject) => {
    let host: RemoteHostInfo | null = null;
    let presets: Preset[] = [];
    let recentProjects: ProjectConfig[] = [];
    // Every remote project in the snapshot (unfiltered, unlike recentProjects
    // which collapses to the recent subset). Lets a caller recover from a
    // command error that still carried a valid snapshot - e.g. an old remote
    // Aya rejecting "project already exists" (see createRemoteProjectOnHost).
    let allProjects: ProjectConfig[] = [];
    execFile(
      "ssh",
      [target, remoteCommand],
      {
        encoding: "utf8",
        timeout: REQUEST_TIMEOUT_MS,
        maxBuffer: REMOTE_BRIDGE_MAX_BUFFER_BYTES,
      },
      (err, stdout, stderr) => {
        let matchedError: Error | null = null;
        for (const line of stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let message: RemoteMessage;
          try {
            message = JSON.parse(trimmed) as RemoteMessage;
          } catch {
            reject(new Error("Remote Aya returned invalid JSON."));
            return;
          }
          if (message.type === "hello") {
            host = requireHost(message.host);
            continue;
          }
          if (message.type === "snapshot") {
            presets = requirePresets(message.snapshot.presets);
            allProjects = requireProjects(message.snapshot.projects);
            recentProjects = orderRecentProjects(
              allProjects,
              requireRecentProjectSlugs(message.snapshot.projectState),
            );
            continue;
          }
          if (message.type === "error" && message.id === id) {
            matchedError = new Error(message.message || message.code);
            continue;
          }
          if ("id" in message && message.id === id) {
            if (!host) {
              reject(new Error("Remote Aya response arrived before hello."));
              return;
            }
            resolve({ host, presets, recentProjects, response: message });
            return;
          }
        }
        if (matchedError) {
          // Carry the snapshot context (parsed before the error) so callers can
          // recover from a benign command failure without a second round-trip.
          if (host) {
            (matchedError as RemoteRequestError).remoteContext = {
              host,
              presets,
              projects: allProjects,
            };
          }
          reject(matchedError);
          return;
        }
        const detail = stderr.trim();
        if (
          detail &&
          /node: command not found|command not found: node|node: not found/i.test(
            detail,
          )
        ) {
          reject(
            new Error(
              `Node is not available on ${target}. Install Node or make it available over ssh.`,
            ),
          );
          return;
        }
        if (
          detail &&
          /aya: command not found|command not found: aya|aya: not found/i.test(
            detail,
          )
        ) {
          reject(
            new Error(
              `Aya is not installed on ${target}. Install Aya there and make sure it has been started.`,
            ),
          );
          return;
        }
        if (err) {
          reject(
            new Error(
              detail ||
                err.message ||
                `Remote Aya connection failed for ${target}.`,
            ),
          );
          return;
        }
        reject(new Error(`Remote Aya connection closed before response (0).`));
      },
    );
  });
}

export async function listRemoteDirectory(
  sshTarget: string,
  directory?: string,
): Promise<RemoteDirectoryListing> {
  const { host, presets, recentProjects, response } = await runRemoteRequest(sshTarget, {
    type: "fs:list",
    ...(directory ? { path: directory } : {}),
  });
  if (response.type !== "fs:list-result") {
    throw new Error("Remote Aya returned an unexpected response.");
  }
  return {
    host,
    presets,
    recentProjects,
    path: response.path,
    entries: requireDirectoryEntries(response.entries),
  };
}

export async function createRemoteDirectory(
  sshTarget: string,
  directory: string,
): Promise<string> {
  const { response } = await runRemoteRequest(sshTarget, {
    type: "fs:mkdir",
    path: directory,
  });
  if (response.type !== "fs:mkdir-result") {
    throw new Error("Remote Aya returned an unexpected response.");
  }
  return response.path;
}

export async function listRemotePresets(sshTarget: string): Promise<Preset[]> {
  const { presets } = await runRemoteRequest(sshTarget, {
    type: "fs:list",
  });
  return presets;
}

function healthFailureStage(
  message: string,
): "ssh" | "node" | "aya-remote" | "snapshot" {
  if (/node is not available|node: command not found|node: not found/i.test(message)) {
    return "node";
  }
  if (
    /not accepting remote connections|Aya is not installed|app_unavailable|aya-remote/i.test(
      message,
    )
  ) {
    return "aya-remote";
  }
  if (/snapshot|presets|projects/i.test(message)) {
    return "snapshot";
  }
  return "ssh";
}

export async function checkRemoteHealth(
  sshTarget: string,
): Promise<RemoteHealthResult> {
  const target = sshTarget.trim();
  const checkedAt = new Date().toISOString();
  if (!target) {
    return {
      ok: false,
      sshTarget,
      checkedAt,
      checks: [
        { stage: "ssh", ok: false, message: "Remote SSH target is required." },
      ],
    };
  }
  try {
    const { host, presets, recentProjects } = await runRemoteRequest(target, {
      type: "fs:list",
    });
    return {
      ok: true,
      sshTarget: target,
      checkedAt,
      host,
      presetsCount: presets.length,
      recentProjectsCount: recentProjects.length,
      checks: [
        { stage: "ssh", ok: true, message: `Connected to ${target}.` },
        { stage: "node", ok: true, message: "Remote Node bridge started." },
        { stage: "aya-remote", ok: true, message: "Remote Aya socket responded." },
        { stage: "snapshot", ok: true, message: "Remote presets and projects loaded." },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stage = healthFailureStage(message);
    const order: Array<"ssh" | "node" | "aya-remote" | "snapshot"> = [
      "ssh",
      "node",
      "aya-remote",
      "snapshot",
    ];
    return {
      ok: false,
      sshTarget: target,
      checkedAt,
      checks: order
        .slice(0, order.indexOf(stage) + 1)
        .map((item) =>
          item === stage
            ? { stage: item, ok: false, message }
            : {
                stage: item,
                ok: true,
                message:
                  item === "ssh"
                    ? `Connected to ${target}.`
                    : item === "node"
                      ? "Remote Node bridge started."
                      : "Remote Aya socket responded.",
              },
        ),
    };
  }
}

/** An Error from runRemoteRequest that still carried a usable snapshot (the
 *  request reached the host and got a hello + snapshot before the command
 *  itself failed). */
interface RemoteRequestError extends Error {
  remoteContext?: {
    host: RemoteHostInfo;
    presets: Preset[];
    projects: ProjectConfig[];
  };
}

/** Recover an "open" from a remote "project already exists" rejection. Older
 *  remote Aya builds (before open-or-create) reject re-opening an existing
 *  project instead of returning it. But the project IS there - which is exactly
 *  what opening it needs - and the failed request already carried the host's
 *  full project snapshot. The error names the colliding slug, so we look that
 *  project up and return it as if the create had succeeded. Returns null when
 *  the error is anything else, so the caller rethrows. Exported for tests. */
export function recoverExistingRemoteProject(
  err: unknown,
): RemoteProjectCreateResult | null {
  if (!(err instanceof Error)) return null;
  const ctx = (err as RemoteRequestError).remoteContext;
  if (!ctx) return null;
  const slug = /Project "([^"]+)" already exists/.exec(err.message)?.[1];
  if (!slug) return null;
  const existing = ctx.projects.find((p) => p.slug === slug && !p.remote);
  if (!existing) return null;
  return { host: ctx.host, presets: ctx.presets, project: existing };
}

export async function createRemoteProjectOnHost(
  sshTarget: string,
  directory: string,
  name?: string,
): Promise<RemoteProjectCreateResult> {
  try {
    const { host, presets, response } = await runRemoteRequest(sshTarget, {
      type: "project:create",
      directory,
      ...(name ? { name } : {}),
    });
    if (response.type !== "project:create-result") {
      throw new Error("Remote Aya returned an unexpected response.");
    }
    return {
      host,
      presets,
      project: requireProject(response.project),
    };
  } catch (err) {
    const recovered = recoverExistingRemoteProject(err);
    if (recovered) return recovered;
    throw err;
  }
}
