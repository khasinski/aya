import type { BrowserWindow, Clipboard, IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { assertAttachmentPaneCanReceiveInput, PaneInputChangedError, typeAttachmentPaths } from "../control";
import { paneInputRevision } from "../pane-input-queue";
import { PaneHeldError } from "../team-control";
import {
  MAX_PROMPT_ATTACHMENT_BATCH_BYTES,
  MAX_PROMPT_ATTACHMENT_BYTES,
  attachmentPathsInput,
  deleteRemoteAttachments,
  readDroppedFile,
  safeAttachmentExtension,
  saveLocalAttachment,
  uploadRemoteAttachment,
} from "../prompt-attachments";
import type { ProjectConfig, PromptAttachmentResult } from "../types";

export interface PromptAttachmentIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  clipboard: Pick<Clipboard, "readText" | "readImage">;
  ayaHome: string;
  /** Accept only an attached, top-level renderer belonging to an Aya window. */
  trustedWindow(event: IpcMainInvokeEvent): BrowserWindow | null;
  listProjects(): Promise<ProjectConfig[]>;
  holdReason(terminalId: string): Promise<string | null>;
  writePane(terminalId: string, data: string): Promise<boolean | void>;
  /** Test seam; production uses the hardened SSH runner. */
  upload?: typeof uploadRemoteAttachment;
  /** Test seam; production removes remote copies after a failed batch. */
  cleanup?: typeof deleteRemoteAttachments;
}

interface IncomingAttachment { name: string; mimeType?: string; sourcePath?: string; bytes?: Buffer }

function incomingAttachments(value: unknown): IncomingAttachment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("Choose between 1 and 16 files.");
  const result: IncomingAttachment[] = [];
  let total = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("Aya could not read one of those files.");
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length < 1 || record.name.length > 512) throw new Error("Aya could not read one of those files.");
    let sourcePath: string | undefined;
    let bytes: Buffer | undefined;
    if (typeof record.path === "string" && path.isAbsolute(record.path) && !/[\x00-\x1f\x7f-\x9f]/.test(record.path)) sourcePath = record.path;
    else if (record.bytes instanceof Uint8Array) bytes = Buffer.from(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength);
    else if (record.bytes instanceof ArrayBuffer) bytes = Buffer.from(record.bytes);
    else throw new Error("Aya could not read one of those files.");
    if (bytes) {
      if (bytes.byteLength > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("A file is too large to add to the prompt (25 MB per file limit).");
      total += bytes.byteLength;
      if (total > MAX_PROMPT_ATTACHMENT_BATCH_BYTES) throw new Error("These files are too large to add together (50 MB total limit).");
    }
    result.push({ name: record.name, ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}), ...(sourcePath ? { sourcePath } : {}), ...(bytes ? { bytes: Buffer.from(bytes) } : {}) });
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

async function addAttachmentsToPane(deps: PromptAttachmentIpcDeps, terminalId: unknown, value: unknown): Promise<PromptAttachmentResult> {
  if (typeof terminalId !== "string" || !terminalId || terminalId.length > 128) throw new Error("Aya could not find that terminal. Nothing was typed.");
  const startedAtInputRevision = paneInputRevision(terminalId);
  const attachments = incomingAttachments(value);
  const { project, pane } = await projectAndPane(deps, terminalId);
  await assertAttachmentPaneCanReceiveInput(deps.holdReason, terminalId, pane.name);

  const paths: string[] = [];
  const copiedToLocal = !project.remote && attachments.some((attachment) => attachment.bytes);
  const inputChangedResult = (hostLabel?: string): Extract<PromptAttachmentResult, { status: "copied-not-added" }> => ({
    status: "copied-not-added",
    message: hostLabel
      ? `File copied to ${hostLabel} but not added, because you typed in the pane meanwhile.`
      : copiedToLocal
        ? "Image saved but not added, because you typed in the pane meanwhile."
        : "File path not added, because you typed in the pane meanwhile.",
    copyText: attachmentPathsInput(paths),
  });
  const hostLabel = project.remote?.label.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 100) || "remote host";
  if (!project.remote) {
    for (const attachment of attachments) {
      if (attachment.sourcePath) paths.push(attachment.sourcePath);
      else if (attachment.bytes) paths.push(await saveLocalAttachment(deps.ayaHome, project.slug, attachment.bytes, safeAttachmentExtension(attachment.name, attachment.mimeType)));
      else throw new Error("Aya could not read that file. Nothing was typed.");
    }
  } else {
    const prepared: Array<{ name: string; mimeType?: string; bytes: Buffer }> = [];
    let total = 0;
    for (const attachment of attachments) {
      const loaded = attachment.sourcePath ? await readDroppedFile(attachment.sourcePath) : { bytes: attachment.bytes!, name: attachment.name };
      total += loaded.bytes.byteLength;
      if (total > MAX_PROMPT_ATTACHMENT_BATCH_BYTES) throw new Error("These files are too large to copy together (50 MB total limit). Nothing was typed.");
      prepared.push({ name: attachment.name || loaded.name, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}), bytes: loaded.bytes });
    }
    try {
      for (const attachment of prepared) {
        paths.push(await (deps.upload ?? uploadRemoteAttachment)(
          project.remote.sshTarget,
          project.slug,
          attachment.bytes,
          safeAttachmentExtension(attachment.name, attachment.mimeType),
          hostLabel,
          undefined,
          attachment.name,
        ));
      }
      await typeAttachmentPaths(deps.writePane, deps.holdReason, terminalId, pane.name, attachmentPathsInput(paths), startedAtInputRevision);
      return { status: "added" };
    } catch (error) {
      if (error instanceof PaneInputChangedError) {
        return { ...inputChangedResult(hostLabel), copyText: attachmentPathsInput(paths).trim() };
      }
      if (error instanceof PaneHeldError && paths.length) {
        return {
          status: "copied-not-added",
          message: `File copied to ${hostLabel} but not added. ${error.message}`,
          copyText: attachmentPathsInput(paths).trim(),
        };
      }
      await (deps.cleanup ?? deleteRemoteAttachments)(project.remote.sshTarget, project.slug, paths.map((remotePath) => remotePath.split("/").at(-1) ?? "")).catch(() => {});
      throw error;
    }
  }
  try {
    await typeAttachmentPaths(deps.writePane, deps.holdReason, terminalId, pane.name, attachmentPathsInput(paths), startedAtInputRevision);
  } catch (error) {
    if (error instanceof PaneInputChangedError && paths.length) return { ...inputChangedResult(), copyText: attachmentPathsInput(paths).trim() };
    throw error;
  }
  return { status: "added" };
}

export function registerPromptAttachmentIpc(deps: PromptAttachmentIpcDeps): void {
  type Gesture = { sender: WebContents; window: BrowserWindow; terminalId: string; kind: "drop" | "paste"; files?: unknown; expiresAt: number };
  const gestures = new Map<string, Gesture>();
  const authorize = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = deps.trustedWindow(event);
    if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("This action is available only from an Aya terminal window.");
    }
    return window;
  };
  const registerGesture = (event: IpcMainInvokeEvent, kind: Gesture["kind"], terminalId: unknown, files?: unknown): string => {
    const window = authorize(event);
    if (typeof terminalId !== "string" || !terminalId || terminalId.length > 128) throw new Error("Aya could not find that terminal.");
    // Expire abandoned preload requests and cap memory even if a renderer closes mid-flow.
    const now = Date.now();
    for (const [key, value] of gestures) if (value.expiresAt <= now) gestures.delete(key);
    if (gestures.size >= 64) throw new Error("Aya could not add the file to the prompt. Try again.");
    const token = crypto.randomBytes(32).toString("hex");
    gestures.set(token, { sender: event.sender, window, terminalId, kind, ...(kind === "drop" ? { files } : {}), expiresAt: now + 5_000 });
    return token;
  };
  deps.ipcMain.handle("prompt-attachments:register-drop", async (event: IpcMainInvokeEvent, terminalId: unknown, files: unknown) => {
    try {
      // This channel is called only by preload's trusted `drop` listener. The
      // renderer bridge exposes neither this IPC nor the resulting token.
      authorize(event);
      const parsed = incomingAttachments(files).map((file) => ({ name: file.name, mimeType: file.mimeType, path: file.sourcePath }));
      if (parsed.some((file) => !file.path)) throw new Error("Aya could not read one of those files.");
      return registerGesture(event, "drop", terminalId, parsed);
    } catch (error) { throw safeAttachmentError(error); }
  });
  deps.ipcMain.handle("prompt-attachments:register-paste", async (event: IpcMainInvokeEvent, terminalId: unknown) => {
    try {
      authorize(event);
      return registerGesture(event, "paste", terminalId);
    } catch (error) { throw safeAttachmentError(error); }
  });
  const consume = (event: IpcMainInvokeEvent, token: unknown, kind: Gesture["kind"]): Gesture => {
    const window = authorize(event);
    if (typeof token !== "string") throw new Error("Aya could not add the file to the prompt. Nothing was typed.");
    const gesture = gestures.get(token);
    if (gesture?.expiresAt !== undefined && gesture.expiresAt <= Date.now()) gestures.delete(token);
    if (!gesture || gesture.expiresAt <= Date.now() || gesture.sender !== event.sender || gesture.window !== window || gesture.kind !== kind || gesture.window.isDestroyed()) {
      throw new Error("Aya could not add the file to the prompt. Nothing was typed.");
    }
    gestures.delete(token);
    return gesture;
  };
  deps.ipcMain.handle("prompt-attachments:drop", async (event: IpcMainInvokeEvent, token: unknown) => {
    try {
      const gesture = consume(event, token, "drop");
      return await addAttachmentsToPane(deps, gesture.terminalId, gesture.files);
    }
    catch (error) { throw safeAttachmentError(error); }
  });
  deps.ipcMain.handle("prompt-attachments:clipboard-image", async (event: IpcMainInvokeEvent, token: unknown) => {
    try {
      const gesture = consume(event, token, "paste");
      if (deps.clipboard.readText()) throw new Error("The clipboard contains text. Copy the image again, then paste it into the terminal.");
      const image = deps.clipboard.readImage();
      if (image.isEmpty()) throw new Error("There is no image in the clipboard to add to the prompt.");
      const bytes = image.toPNG();
      if (bytes.byteLength > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("The clipboard image is too large to add to the prompt (25 MB limit).");
      return await addAttachmentsToPane(deps, gesture.terminalId, [{ name: "clipboard.png", mimeType: "image/png", bytes }]);
    } catch (error) { throw safeAttachmentError(error); }
  });
  deps.ipcMain.handle("prompt-attachments:context-menu-image", async (event: IpcMainInvokeEvent, token: unknown) => {
    try {
      const gesture = consume(event, token, "paste");
      if (deps.clipboard.readText()) return { status: "not-image" };
      const image = deps.clipboard.readImage();
      if (image.isEmpty()) return { status: "not-image" };
      const bytes = image.toPNG();
      if (bytes.byteLength > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("The clipboard image is too large to add to the prompt (25 MB limit).");
      return await addAttachmentsToPane(deps, gesture.terminalId, [{ name: "clipboard.png", mimeType: "image/png", bytes }]);
    } catch (error) { throw safeAttachmentError(error); }
  });
}

function safeAttachmentError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  const userFacing = /^(?:Not sent:|Aya could not|This file is too large|These files are too large|Choose between|The clipboard contains text|There is no image|The clipboard image is too large)/.test(message);
  return new Error(userFacing ? message : "Aya could not add the file to the prompt. Check the pane and try again. Nothing was typed.");
}
