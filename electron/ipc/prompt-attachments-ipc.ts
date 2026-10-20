import type { Clipboard, IpcMain, IpcMainInvokeEvent } from "electron";
import { assertAttachmentPaneCanReceiveInput, typeAttachmentPaths } from "../control";
import {
  MAX_PROMPT_ATTACHMENT_BATCH_BYTES,
  MAX_PROMPT_ATTACHMENT_BYTES,
  attachmentPathsInput,
  safeAttachmentExtension,
  saveLocalAttachment,
  uploadRemoteAttachment,
} from "../prompt-attachments";
import type { ProjectConfig } from "../types";

export interface PromptAttachmentIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  clipboard: Pick<Clipboard, "readText" | "readImage">;
  ayaHome: string;
  listProjects(): Promise<ProjectConfig[]>;
  holdReason(terminalId: string): Promise<string | null>;
  writePane(terminalId: string, data: string): Promise<boolean | void>;
  /** Test seam; production uses the hardened SSH runner. */
  upload?: typeof uploadRemoteAttachment;
}

interface IncomingAttachment { name: string; mimeType?: string; bytes: Buffer }

function incomingAttachments(value: unknown): IncomingAttachment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("Choose between 1 and 16 files.");
  const result: IncomingAttachment[] = [];
  let total = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("Aya could not read one of those files.");
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length < 1 || record.name.length > 512) throw new Error("Aya could not read one of those files.");
    let bytes: Buffer;
    if (record.bytes instanceof Uint8Array) bytes = Buffer.from(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength);
    else if (record.bytes instanceof ArrayBuffer) bytes = Buffer.from(record.bytes);
    else throw new Error("Aya could not read one of those files.");
    if (bytes.byteLength > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("A file is too large to add to the prompt (25 MB per file limit).");
    total += bytes.byteLength;
    if (total > MAX_PROMPT_ATTACHMENT_BATCH_BYTES) throw new Error("These files are too large to add together (50 MB total limit).");
    result.push({ name: record.name, ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}), bytes: Buffer.from(bytes) });
  }
  return result;
}

async function projectAndPane(deps: PromptAttachmentIpcDeps, terminalId: string): Promise<{ project: ProjectConfig; pane: ProjectConfig["tabs"][number] }> {
  const matches = (await deps.listProjects()).flatMap((project) => project.tabs
    .filter((pane) => pane.id === terminalId)
    .map((pane) => ({ project, pane })));
  if (matches.length !== 1) throw new Error("Aya could not find that terminal in an open project. Nothing was typed.");
  return matches[0];
}

async function addAttachmentsToPane(deps: PromptAttachmentIpcDeps, terminalId: unknown, value: unknown): Promise<void> {
  if (typeof terminalId !== "string" || !terminalId || terminalId.length > 128) throw new Error("Aya could not find that terminal. Nothing was typed.");
  const attachments = incomingAttachments(value);
  const { project, pane } = await projectAndPane(deps, terminalId);
  await assertAttachmentPaneCanReceiveInput(deps.holdReason, terminalId, pane.name);

  const paths: string[] = [];
  const hostLabel = project.remote?.label.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 100) || "remote host";
  for (const attachment of attachments) {
    const extension = safeAttachmentExtension(attachment.name, attachment.mimeType);
    const file = project.remote
      ? await (deps.upload ?? uploadRemoteAttachment)(project.remote.sshTarget, project.slug, attachment.bytes, extension, hostLabel)
      : await saveLocalAttachment(deps.ayaHome, project.slug, attachment.bytes, extension);
    paths.push(file);
  }
  await typeAttachmentPaths(deps.writePane, deps.holdReason, terminalId, pane.name, attachmentPathsInput(paths));
}

export function registerPromptAttachmentIpc(deps: PromptAttachmentIpcDeps): void {
  deps.ipcMain.handle("prompt-attachments:drop", async (_event: IpcMainInvokeEvent, terminalId: unknown, files: unknown) => {
    try { await addAttachmentsToPane(deps, terminalId, files); }
    catch (error) { throw safeAttachmentError(error); }
  });
  deps.ipcMain.handle("prompt-attachments:clipboard-image", async (_event: IpcMainInvokeEvent, terminalId: unknown) => {
    try {
      if (deps.clipboard.readText()) throw new Error("The clipboard contains text. Copy the image again, then paste it into the terminal.");
      const image = deps.clipboard.readImage();
      if (image.isEmpty()) throw new Error("There is no image in the clipboard to add to the prompt.");
      const bytes = image.toPNG();
      if (bytes.byteLength > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("The clipboard image is too large to add to the prompt (25 MB limit).");
      await addAttachmentsToPane(deps, terminalId, [{ name: "clipboard.png", mimeType: "image/png", bytes }]);
    } catch (error) { throw safeAttachmentError(error); }
  });
}

function safeAttachmentError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  const userFacing = /^(?:Not sent:|Aya could not|This file is too large|These files are too large|Choose between|The clipboard contains text|There is no image|The clipboard image is too large)/.test(message);
  return new Error(userFacing ? message : "Aya could not add the file to the prompt. Check the pane and try again. Nothing was typed.");
}
