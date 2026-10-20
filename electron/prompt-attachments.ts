import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { runSsh, type SshRun } from "./ssh";
import { shellQuote } from "./pane-command";

export const MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENT_BATCH_BYTES = 50 * 1024 * 1024;
export const PROMPT_ATTACHMENT_TIMEOUT_MS = 30_000;
export const PROMPT_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ATTACHMENT_FOLDER = "prompt-attachments";
const REMOTE_PATH_MARKER = "AYA_ATTACHMENT_PATH=";

/** This source is the entire remote command. No project, path, filename, or dropped name is interpolated into it. */
export const REMOTE_ATTACHMENT_RECEIVER = [
  "set -eu",
  "umask 077",
  "IFS= read -r project_id || exit 20",
  "IFS= read -r filename || exit 20",
  "IFS= read -r expected_size || exit 20",
  "case $project_id in ''|*[!a-z0-9_-]*) exit 21;; esac",
  "case $filename in ''|*[!a-z0-9._-]*) exit 22;; esac",
  "prefix=${filename%%-*}",
  "[ ${#prefix} -eq 32 ] || exit 22",
  "case $prefix in *[!a-f0-9]*) exit 22;; esac",
  "suffix=${filename#\"$prefix\"-}",
  "[ -n \"$suffix\" ] && [ ${#suffix} -le 90 ] || exit 22",
  "case $suffix in *[!a-z0-9._-]*) exit 22;; .*|*..*|*-|*.) exit 22;; esac",
  "case $expected_size in ''|*[!0-9]*) exit 23;; esac",
  ` [ \"$expected_size\" -le ${MAX_PROMPT_ATTACHMENT_BYTES} ] || exit 24`.trim(),
  "uid=$(id -u)",
  "owner_of() { stat -c %u \"$1\" 2>/dev/null || stat -f %u \"$1\" 2>/dev/null; }",
  "ensure_base_dir() {",
  "  [ ! -L \"$1\" ] || exit 25",
  "  if [ ! -e \"$1\" ]; then mkdir -m 700 \"$1\" 2>/dev/null || :; fi",
  "  [ -d \"$1\" ] && [ ! -L \"$1\" ] || exit 26",
  "  [ \"$(owner_of \"$1\")\" = \"$uid\" ] || exit 27",
  "}",
  "ensure_dir() {",
  "  ensure_base_dir \"$1\"",
  "  chmod 700 \"$1\"",
  "}",
  "if [ -n \"${XDG_RUNTIME_DIR:-}\" ]; then root=$XDG_RUNTIME_DIR; else root=$HOME/.cache; fi",
  "case $root in /*) :;; *) exit 28;; esac",
  "ensure_base_dir \"$root\"",
  "ensure_dir \"$root/aya\"",
  "ensure_dir \"$root/aya/attachments\"",
  "directory=$root/aya/attachments/$project_id",
  "ensure_dir \"$directory\"",
  "find \"$directory\" -type f -mmin +10080 -exec rm -f {} \\; >/dev/null 2>&1",
  "output=$directory/$filename",
  "trap 'rm -f \"$output\"' 0",
  "(set -C; cat > \"$output\")",
  "actual_size=$(wc -c < \"$output\" | tr -d ' ')",
  "if [ \"$actual_size\" != \"$expected_size\" ]; then rm -f \"$output\"; exit 29; fi",
  "trap - 0",
  `printf '${REMOTE_PATH_MARKER}%s\\n' \"$output\"`,
].join("\n");

export const REMOTE_ATTACHMENT_CLEANUP = [
  "set -eu",
  "umask 077",
  "IFS= read -r project_id || exit 20",
  "case $project_id in ''|*[!a-z0-9_-]*) exit 21;; esac",
  "uid=$(id -u)",
  "owner_of() { stat -c %u \"$1\" 2>/dev/null || stat -f %u \"$1\" 2>/dev/null; }",
  "if [ -n \"${XDG_RUNTIME_DIR:-}\" ]; then root=$XDG_RUNTIME_DIR; else root=$HOME/.cache; fi",
  "[ -d \"$root\" ] && [ ! -L \"$root\" ] && [ \"$(owner_of \"$root\")\" = \"$uid\" ] || exit 24",
  "[ -d \"$root/aya\" ] && [ ! -L \"$root/aya\" ] && [ \"$(owner_of \"$root/aya\")\" = \"$uid\" ] || exit 25",
  "[ -d \"$root/aya/attachments\" ] && [ ! -L \"$root/aya/attachments\" ] && [ \"$(owner_of \"$root/aya/attachments\")\" = \"$uid\" ] || exit 26",
  "[ -d \"$root/aya/attachments/$project_id\" ] && [ ! -L \"$root/aya/attachments/$project_id\" ] || exit 0",
  "[ \"$(owner_of \"$root/aya/attachments/$project_id\")\" = \"$uid\" ] || exit 22",
  "directory=$root/aya/attachments/$project_id",
  "while IFS= read -r filename; do",
  "  case $filename in *[!a-z0-9._-]*) exit 23;; esac",
  "  prefix=${filename%%-*}",
  "  [ ${#prefix} -eq 32 ] || exit 23",
  "  case $prefix in *[!a-f0-9]*) exit 23;; esac",
  "  rm -f -- \"$directory/$filename\"",
  "done",
].join("\n");

export function remoteAttachmentCommand(): string {
  return `sh -c ${shellQuote(REMOTE_ATTACHMENT_RECEIVER)}`;
}

export function remoteAttachmentCleanupCommand(): string {
  return `sh -c ${shellQuote(REMOTE_ATTACHMENT_CLEANUP)}`;
}

export function safeAttachmentExtension(name: string, mimeType = ""): string {
  if (mimeType.toLowerCase() === "image/png") return ".png";
  const extension = path.extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : "";
}

function safeRemoteBasename(name: string): string {
  const leaf = name.split(/[\\/]/).at(-1) ?? "";
  const stem = path.basename(leaf, path.extname(leaf))
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .toLowerCase();
  return stem || "attachment";
}

export function attachmentFilename(extension: string, originalName = ""): string {
  const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
  return `${randomBytes(16).toString("hex")}-${safeRemoteBasename(originalName)}${safeExtension}`;
}

export function attachmentPathsInput(paths: string[]): string {
  if (paths.length === 0) throw new Error("Aya could not find a file to add to the prompt.");
  for (const value of paths) assertNoControlPath(value);
  return ` ${paths.map(shellQuote).join(" ")} `;
}

function safeProjectId(projectId: string): string {
  if (!/^[a-z0-9_-]{1,80}$/.test(projectId)) throw new Error("Aya could not prepare a private folder for this project.");
  return projectId;
}

function assertNoControlPath(value: string): void {
  if (!value || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error("Aya could not use the attachment folder path safely.");
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Aya could not use the attachment folder because it is not a private folder owned by you.");
  }
  await fs.chmod(directory, 0o700);
}

async function ensureLocalAttachmentDirectory(ayaHome: string, projectId: string): Promise<string> {
  assertNoControlPath(ayaHome);
  const root = path.resolve(ayaHome);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (process.getuid && rootStat.uid !== process.getuid())) {
    throw new Error("Aya could not use its private attachment folder.");
  }
  const parent = path.join(root, ATTACHMENT_FOLDER);
  await ensurePrivateDirectory(parent);
  const directory = path.join(parent, safeProjectId(projectId));
  await ensurePrivateDirectory(directory);
  return directory;
}

async function cleanLocalAttachments(directory: string, now = Date.now()): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(directory, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs > PROMPT_ATTACHMENT_RETENTION_MS) {
      await fs.unlink(file).catch(() => {});
    }
  }
}

export async function saveLocalAttachment(ayaHome: string, projectId: string, bytes: Buffer, extension: string): Promise<string> {
  if (bytes.byteLength > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("This file is too large for Aya to add to the prompt (25 MB limit).");
  const directory = await ensureLocalAttachmentDirectory(ayaHome, projectId);
  await cleanLocalAttachments(directory);
  const file = path.join(directory, attachmentFilename(extension));
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  return file;
}

export async function readDroppedFile(sourcePath: string): Promise<{ bytes: Buffer; name: string }> {
  assertNoControlPath(sourcePath);
  if (!path.isAbsolute(sourcePath)) throw new Error("Aya could not read that dropped file safely. Nothing was typed.");
  const handle = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Aya could not read that dropped file safely. Nothing was typed.");
    if (stat.size > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("This file is too large for Aya to copy to the remote project (25 MB limit).");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_PROMPT_ATTACHMENT_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_PROMPT_ATTACHMENT_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("This file is too large for Aya to copy to the remote project (25 MB limit).");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { bytes: Buffer.concat(chunks, total), name: path.basename(sourcePath) };
  } finally {
    await handle.close().catch(() => {});
  }
}

function remoteInput(projectId: string, filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${safeProjectId(projectId)}\n${filename}\n${bytes.byteLength}\n`, "utf8"),
    bytes,
  ]);
}

export async function uploadRemoteAttachment(
  sshTarget: string,
  projectId: string,
  bytes: Buffer,
  extension: string,
  hostLabel = "remote project",
  runner: typeof runSsh = runSsh,
  originalName = "",
): Promise<string> {
  const safeHost = hostLabel.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 100) || "remote host";
  if (bytes.byteLength > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error(`This file is too large for Aya to copy to ${safeHost} (25 MB limit).`);
  const filename = attachmentFilename(extension, originalName);
  const command = remoteAttachmentCommand();
  const run = await runner(sshTarget, [command], {
    input: remoteInput(projectId, filename, bytes),
    deadlineMs: PROMPT_ATTACHMENT_TIMEOUT_MS,
    maxOutputBytes: 16 * 1024,
  });
  if (run.timedOut) throw new Error(`Aya could not copy the file to ${safeHost}: the connection took too long. Nothing was typed.`);
  if (run.spawnError) throw new Error(`Aya could not copy the file to ${safeHost}: SSH is unavailable. Nothing was typed.`);
  if (run.code !== 0) throw new Error(remoteCopyFailure(run, safeHost));
  const pathLine = run.stdout.split(/\r?\n/).find((line) => line.startsWith(REMOTE_PATH_MARKER));
  if (!pathLine) throw new Error("Aya could not confirm the file was copied to the remote project. Nothing was typed.");
  const remotePath = pathLine.slice(REMOTE_PATH_MARKER.length);
  assertNoControlPath(remotePath);
  const expectedSuffix = `/aya/attachments/${safeProjectId(projectId)}/${filename}`;
  if (!remotePath.startsWith("/") || !remotePath.endsWith(expectedSuffix)) {
    throw new Error("Aya could not confirm the file was copied to the remote project. Nothing was typed.");
  }
  return remotePath;
}

export async function deleteRemoteAttachments(
  sshTarget: string,
  projectId: string,
  filenames: string[],
  runner: typeof runSsh = runSsh,
): Promise<void> {
  if (!filenames.length) return;
  const safeNames = filenames.filter((name) => /^[a-f0-9]{32}(?:-[a-z0-9_-]{1,72})?(?:\.[a-z0-9]{1,10})?$/.test(name));
  if (safeNames.length !== filenames.length) return;
  const input = Buffer.from(`${safeProjectId(projectId)}\n${safeNames.join("\n")}\n`, "utf8");
  await runner(sshTarget, [remoteAttachmentCleanupCommand()], { input, deadlineMs: 5_000, maxOutputBytes: 1024 });
}

function remoteCopyFailure(run: SshRun, hostLabel: string): string {
  const safeHost = hostLabel.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 100) || "remote host";
  const detail = `${run.stderr}\n${run.stdout}`;
  if (/permission denied|password/i.test(detail)) {
    return `Aya could not copy the file to ${safeHost}: it needs a password. Copy it yourself or set up key login. Nothing was typed.`;
  }
  if (/host key verification failed|authenticity of host|are you sure you want to continue/i.test(detail)) {
    return `Aya could not copy the file to ${safeHost} because SSH needs host approval. Set up the host first. Nothing was typed.`;
  }
  if (/could not resolve hostname|connection refused|network is unreachable/i.test(detail)) {
    return `Aya could not copy the file to ${safeHost}. Check its SSH connection and try again. Nothing was typed.`;
  }
  return `Aya could not safely copy the file to ${safeHost}. Nothing was typed.`;
}

