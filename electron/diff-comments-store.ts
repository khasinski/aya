import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { oneAtATime } from "./keyed-queue";
import { writeFileAtomic } from "./atomic-write";

export interface DiffComment {
  id: string;
  file: string;
  hunk: string;
  line: string;
  newLine: number | null;
  oldLine: number | null;
  occurrence: number;
  checkout: string;
  note: string;
  createdAt: string;
  sentAt: string | null;
  sentTo: string | null;
}

export const DIFF_COMMENTS_DIR = "diff-comments";
export const MAX_DIFF_COMMENTS = 200;
export const MAX_DIFF_COMMENT_CHARS = 8_000;
export const MAX_DIFF_COMMENT_FILE_BYTES = 2 * 1024 * 1024;
const FORMAT_VERSION = 1;
const serial = oneAtATime();

export function diffCommentsFile(ayaHome: string, projectSlug: string): string {
  if (!/^[a-z0-9_-]{1,80}$/.test(projectSlug)) throw new Error("Invalid project for saved comments.");
  return path.join(ayaHome, DIFF_COMMENTS_DIR, `${projectSlug}.json`);
}

function isComment(value: unknown): value is DiffComment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return typeof c.id === "string" && /^[a-f0-9]{16,64}$/i.test(c.id) &&
    typeof c.file === "string" && c.file.length > 0 && c.file.length <= 2048 &&
    typeof c.hunk === "string" && c.hunk.startsWith("@@") && c.hunk.length <= 4096 &&
    typeof c.line === "string" && c.line.length <= 8192 && /^[+\- ]/.test(c.line) &&
    (c.newLine === null || (Number.isSafeInteger(c.newLine) && Number(c.newLine) > 0)) &&
    (c.oldLine === null || (Number.isSafeInteger(c.oldLine) && Number(c.oldLine) > 0)) &&
    Number.isSafeInteger(c.occurrence) && Number(c.occurrence) >= 0 &&
    typeof c.checkout === "string" && c.checkout.length <= 4096 &&
    typeof c.note === "string" && c.note.trim().length > 0 && c.note.length <= MAX_DIFF_COMMENT_CHARS &&
    typeof c.createdAt === "string" && Number.isFinite(Date.parse(c.createdAt)) &&
    (c.sentAt === null || (typeof c.sentAt === "string" && Number.isFinite(Date.parse(c.sentAt)))) &&
    (c.sentTo === null || (typeof c.sentTo === "string" && c.sentTo.length <= 512));
}

export function validateDiffComment(value: unknown): DiffComment {
  if (!isComment(value)) throw new Error("That comment could not be saved. Check its text and try again.");
  return value;
}

async function checkDirectory(directory: string, create: boolean): Promise<void> {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let st;
  try { st = await fs.lstat(directory); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !create) return;
    throw err;
  }
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) {
    throw new Error("Saved comments are in an unsafe Aya folder. Nothing was changed.");
  }
}

async function readFile(ayaHome: string, slug: string): Promise<DiffComment[]> {
  const file = diffCommentsFile(ayaHome, slug);
  const dir = path.dirname(file);
  await checkDirectory(dir, false);
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Aya could not read this project's saved comments. Nothing was changed.");
  }
  let raw: string;
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0 || st.size > MAX_DIFF_COMMENT_FILE_BYTES) {
      throw new Error("This project's saved comments are not a private, regular file. Nothing was changed.");
    }
    const buffer = Buffer.alloc(MAX_DIFF_COMMENT_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_DIFF_COMMENT_FILE_BYTES) throw new Error("This project's saved comments are too large. Nothing was changed.");
    raw = buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Aya could not read this project's saved comments. Nothing was changed."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Aya could not read this project's saved comments. Nothing was changed.");
  const record = parsed as Record<string, unknown>;
  if (record.version !== FORMAT_VERSION || record.projectSlug !== slug || !Array.isArray(record.comments) || record.comments.length > MAX_DIFF_COMMENTS || !record.comments.every(isComment)) {
    throw new Error("Aya could not read this project's saved comments. Nothing was changed.");
  }
  const comments = record.comments as DiffComment[];
  if (new Set(comments.map((c) => c.id)).size !== comments.length) throw new Error("Aya could not read this project's saved comments. Nothing was changed.");
  return comments;
}

async function writeFile(ayaHome: string, slug: string, comments: DiffComment[]): Promise<void> {
  if (comments.length > MAX_DIFF_COMMENTS || !comments.every(isComment) || new Set(comments.map((c) => c.id)).size !== comments.length) {
    throw new Error("Saved comments are invalid or exceed the limit.");
  }
  const file = diffCommentsFile(ayaHome, slug);
  await checkDirectory(path.dirname(file), true);
  const text = `${JSON.stringify({ version: FORMAT_VERSION, projectSlug: slug, comments }, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_DIFF_COMMENT_FILE_BYTES) throw new Error("Saved comments are too large. Remove or shorten some comments.");
  await writeFileAtomic(file, text, 0o600);
}

export function listDiffComments(ayaHome: string, slug: string): Promise<DiffComment[]> {
  return serial(slug, () => readFile(ayaHome, slug));
}

export function addDiffComment(ayaHome: string, slug: string, comment: DiffComment): Promise<DiffComment[]> {
  return serial(slug, async () => {
    const comments = await readFile(ayaHome, slug);
    if (comments.some((c) => c.id === comment.id)) throw new Error("This comment was already saved.");
    const next = [...comments, comment];
    await writeFile(ayaHome, slug, next);
    return next;
  });
}

export function editDiffComment(ayaHome: string, slug: string, id: string, note: string): Promise<DiffComment[]> {
  return serial(slug, async () => {
    const comments = await readFile(ayaHome, slug);
    const found = comments.find((c) => c.id === id);
    if (!found) throw new Error("That comment is no longer saved.");
    const next = comments.map((c) => c.id === id ? { ...c, note, sentAt: null, sentTo: null } : c);
    await writeFile(ayaHome, slug, next);
    return next;
  });
}

export function deleteDiffComment(ayaHome: string, slug: string, id: string): Promise<DiffComment[]> {
  return serial(slug, async () => {
    const comments = await readFile(ayaHome, slug);
    const next = comments.filter((c) => c.id !== id);
    if (next.length === comments.length) return comments;
    await writeFile(ayaHome, slug, next);
    return next;
  });
}

export function clearSentDiffComments(ayaHome: string, slug: string): Promise<DiffComment[]> {
  return serial(slug, async () => {
    const comments = await readFile(ayaHome, slug);
    const next = comments.filter((c) => !c.sentAt);
    if (next.length !== comments.length) await writeFile(ayaHome, slug, next);
    return next;
  });
}

export function markDiffCommentsSent(ayaHome: string, slug: string, ids: string[], paneName: string): Promise<DiffComment[]> {
  return serial(slug, async () => {
    const comments = await readFile(ayaHome, slug);
    const selected = new Set(ids);
    if (!selected.size || [...selected].some((id) => !comments.some((c) => c.id === id && !c.sentAt))) {
      throw new Error("The comments changed before they could be marked sent. Check the pane before retrying.");
    }
    const sentAt = new Date().toISOString();
    const next = comments.map((c) => selected.has(c.id) ? { ...c, sentAt, sentTo: paneName } : c);
    await writeFile(ayaHome, slug, next);
    return next;
  });
}

/** Keep selection, delivery, and the sent marker in one per-project critical
 * section so two windows cannot deliver the same comments concurrently. */
export function sendDiffComments(
  ayaHome: string,
  slug: string,
  ids: string[],
  paneName: string,
  deliver: (comments: DiffComment[]) => Promise<void>,
): Promise<DiffComment[]> {
  return serial(slug, async () => {
    const comments = await readFile(ayaHome, slug);
    const selected = new Set(ids);
    if (!selected.size || selected.size !== ids.length || [...selected].some((id) => !comments.some((c) => c.id === id && !c.sentAt))) {
      throw new Error("The selected comments changed. Review them and try again.");
    }
    const chosen = comments.filter((comment) => selected.has(comment.id));
    await deliver(chosen);
    const sentAt = new Date().toISOString();
    const next = comments.map((comment) => selected.has(comment.id) ? { ...comment, sentAt, sentTo: paneName } : comment);
    await writeFile(ayaHome, slug, next);
    return next;
  });
}
