import { createHash, randomBytes } from "node:crypto";
import { reviewPtyPayload } from "./diff-comments-prompt";
import { runGh } from "./git-publish";
import { printable } from "./printable";

export const MAX_CI_LOG_TAIL_BYTES = 8 * 1024;
export const MAX_STORED_CI_PREVIEWS = 128;
const GH_TIMEOUT_MS = 20_000;
const GH_POLL_TIMEOUT_MS = 12_000;

export interface PullRequestCheck {
  name: string;
  state: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel" | "unknown";
  url: string | null;
}

export interface PullRequestChecks {
  pullRequestUrl: string | null;
  pullRequestState: "open" | "merged" | "closed" | "unknown" | "none";
  checks: PullRequestCheck[];
}

export interface CiFailurePreview {
  token: string;
  checkName: string;
  checkUrl: string;
  prompt: string;
}

type Gh = (directory: string, args: string[], timeout?: number, signal?: AbortSignal) => Promise<string>;

const runGhWithSignal: Gh = (directory, args, timeout, signal) =>
  runGh(directory, args, timeout, undefined, undefined, signal);

function parseJson<T>(raw: string, label: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new Error(`GitHub returned an invalid ${label}.`); }
}

function safeUrl(value: unknown, origin: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === origin ? url.toString() : null;
  } catch { return null; }
}

function safeName(value: unknown): string {
  if (typeof value !== "string") return "Unnamed check";
  return printable(value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")).trim().slice(0, 240) || "Unnamed check";
}

export async function getPullRequestChecks(directory: string, branch: string, gh: Gh = runGhWithSignal, signal?: AbortSignal): Promise<PullRequestChecks> {
  let repoUrl: string;
  try {
    repoUrl = (await gh(directory, ["repo", "view", "--json", "url", "--jq", ".url"], GH_POLL_TIMEOUT_MS, signal)).trim();
  } catch (error) {
    throw friendlyGhError(error);
  }
  let origin: string;
  try {
    const repo = new URL(repoUrl);
    if (repo.protocol !== "https:") throw new Error();
    origin = repo.origin;
  } catch { throw new Error("GitHub did not return a valid repository link."); }

  let pr: { url?: unknown; state?: unknown; isDraft?: unknown };
  try {
    pr = parseJson(await gh(directory, ["pr", "view", branch, "--json", "url,state,isDraft"], GH_POLL_TIMEOUT_MS, signal), "pull request status");
  } catch (error) {
    const raw = error as { code?: unknown; stderr?: unknown };
    if (raw?.code === 1 && /no pull requests found/i.test(String(raw.stderr ?? ""))) {
      return { pullRequestUrl: null, pullRequestState: "none", checks: [] };
    }
    throw friendlyGhError(error);
  }
  const pullRequestUrl = safeUrl(pr.url, origin);
  if (!pullRequestUrl) throw new Error("GitHub did not return a pull request link for this repository.");
  const state = String(pr.state ?? "").toUpperCase();
  if (state === "MERGED") return { pullRequestUrl, pullRequestState: "merged", checks: [] };
  if (state === "CLOSED") return { pullRequestUrl, pullRequestState: "closed", checks: [] };
  let rows: unknown;
  try {
    rows = parseJson(await gh(directory, ["pr", "checks", branch, "--json", "name,state,bucket,link"], GH_POLL_TIMEOUT_MS, signal), "check status");
  } catch (error) {
    // gh exits 8 when checks are still pending, while returning valid JSON.
    const raw = error as { code?: unknown; stdout?: unknown };
    if (raw?.code === 8 && typeof raw.stdout === "string") rows = parseJson(raw.stdout, "check status");
    else throw friendlyGhError(error);
  }
  if (!Array.isArray(rows)) throw new Error("GitHub returned an invalid check list.");
  const checks = rows.slice(0, 500).map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const bucket = ["pass", "fail", "pending", "skipping", "cancel"].includes(String(row.bucket))
      ? row.bucket as PullRequestCheck["bucket"] : "unknown";
    return { name: safeName(row.name), state: safeName(row.state), bucket, url: safeUrl(row.link, origin) };
  });
  return { pullRequestUrl, pullRequestState: "open", checks };
}

function friendlyGhError(error: unknown): Error {
  const value = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  if (value?.code === "ETIMEDOUT" || value?.killed || value?.signal === "SIGTERM" || /timed out|ETIMEDOUT/i.test(String(value?.message ?? ""))) {
    return new Error("GitHub did not respond in time.");
  }
  if (/ENOENT|not found/i.test(String(value?.message ?? ""))) return new Error("GitHub CLI is not installed. Install gh, then try again.");
  return new Error("Aya could not load pull request checks.");
}

function cleanLog(raw: string): string {
  const cleaned = raw
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\](?:(?!\x07|\x1b\\)[\s\S])*(?:\x07|\x1b\\)|[PX^_](?:(?!\x1b\\)[\s\S])*\x1b\\|[@-_])/g, "")
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x9d(?:(?!\x07|\x9c|\x1b\\)[\s\S])*(?:\x07|\x9c|\x1b\\)/g, "")
    .replace(/[\x90\x98\x9e\x9f](?:(?!\x9c|\x1b\\)[\s\S])*(?:\x9c|\x1b\\)/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(?:[A-Z_][A-Z0-9_]*=|export\s+[A-Z_][A-Z0-9_]*=)/.test(line))
    .join("\n")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})\b/g, "[redacted]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
  return printable(cleaned);
}

export function boundedCiLogTail(raw: string, maxBytes = MAX_CI_LOG_TAIL_BYTES): string {
  const clean = cleanLog(raw);
  const buffer = Buffer.from(clean, "utf8");
  if (buffer.length <= maxBytes) return clean;
  let tail = buffer.subarray(buffer.length - maxBytes).toString("utf8");
  while (Buffer.byteLength(tail, "utf8") > maxBytes) tail = tail.slice(1);
  return tail;
}

function jobFromUrl(url: string | null): { runId: string; jobId: string } | null {
  if (!url) return null;
  const match = /\/actions\/runs\/([0-9]+)\/job\/([0-9]+)(?:[/?#]|$)/.exec(url);
  return match ? { runId: match[1], jobId: match[2] } : null;
}

export async function buildCiFailurePrompt(directory: string, branch: string, checkUrl: string, gh: Gh = runGhWithSignal, signal?: AbortSignal): Promise<{ check: PullRequestCheck; prompt: string }> {
  const state = await getPullRequestChecks(directory, branch, gh, signal);
  const check = state.checks.find((item) => item.url === checkUrl && item.bucket === "fail");
  if (!check) throw new Error("That check is no longer failing. Refresh the list and try again.");
  const ids = jobFromUrl(check.url);
  if (!ids) throw new Error("Aya could not open the failed job log for this check.");
  let rawLog: string;
  try { rawLog = await gh(directory, ["run", "view", ids.runId, "--job", ids.jobId, "--log-failed"], GH_TIMEOUT_MS, signal); }
  catch (error) { throw friendlyGhError(error); }
  const tail = boundedCiLogTail(rawLog);
  const prompt = `CI check failed: ${check.name}\n${check.url}\n\nTail of the failed job log (up to 8 KB; earlier output may be omitted):\n${tail || "(No log output was available.)"}`;
  return { check, prompt };
}

interface StoredPreview {
  directory: string;
  branch: string;
  checkUrl: string;
  projectSlug: string;
  targetId: string;
  promptHash: string;
  expiresAt: number;
}
const previews = new Map<string, StoredPreview>();

function prunePreviews(now = Date.now()): void {
  for (const [token, preview] of previews) {
    if (preview.expiresAt <= now) previews.delete(token);
  }
}

function makePreviewRoom(now = Date.now()): void {
  prunePreviews(now);
  while (previews.size >= MAX_STORED_CI_PREVIEWS) {
    const oldest = previews.keys().next().value as string | undefined;
    if (!oldest) break;
    previews.delete(oldest);
  }
}

export async function createCiFailurePreview(input: Omit<StoredPreview, "promptHash" | "expiresAt">, gh: Gh = runGhWithSignal, signal?: AbortSignal): Promise<CiFailurePreview> {
  const result = await buildCiFailurePrompt(input.directory, input.branch, input.checkUrl, gh, signal);
  if (signal?.aborted) throw signal.reason ?? new Error("Check details were cancelled.");
  const token = randomBytes(24).toString("hex");
  const now = Date.now();
  makePreviewRoom(now);
  previews.set(token, { ...input, promptHash: createHash("sha256").update(result.prompt).digest("hex"), expiresAt: now + 5 * 60_000 });
  return { token, checkName: result.check.name, checkUrl: result.check.url!, prompt: result.prompt };
}

export async function sendCiFailurePreview(input: { token: string; projectSlug: string; targetId: string }, send: (projectSlug: string, targetId: string, text: string) => Promise<unknown>, gh: Gh = runGhWithSignal, signal?: AbortSignal): Promise<void> {
  const saved = previews.get(input.token);
  if (!saved || saved.expiresAt <= Date.now() || saved.projectSlug !== input.projectSlug || saved.targetId !== input.targetId) {
    previews.delete(input.token);
    throw new Error("That preview expired. Refresh the check and review it again.");
  }
  // Consume synchronously before any asynchronous refetch so two simultaneous
  // IPC sends cannot both use the same preview token.
  previews.delete(input.token);
  const latest = await buildCiFailurePrompt(saved.directory, saved.branch, saved.checkUrl, gh, signal);
  if (signal?.aborted) throw signal.reason ?? new Error("Check details were cancelled.");
  const digest = createHash("sha256").update(latest.prompt).digest("hex");
  if (digest !== saved.promptHash) {
    throw new Error("The failed job log changed. Review the updated preview before sending.");
  }
  // Match diff comments exactly: one bracketed paste followed by the shared
  // control path's Enter, with no nested paste wrapper.
  await send(saved.projectSlug, saved.targetId, reviewPtyPayload(latest.prompt));
}
