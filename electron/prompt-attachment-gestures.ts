export interface PromptAttachmentGestureReport {
  terminalId: string;
  kind: "files" | "image";
  count: number;
  phase: "started" | "finished";
  result?: unknown;
  error?: unknown;
}

export interface PromptAttachmentGestureDeps {
  document: Document;
  getPathForFile(file: File): string;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  report(value: PromptAttachmentGestureReport): void;
}

function terminalForEvent(event: Event): { element: Element; id: string } | null {
  const target = event.target;
  if (!target || typeof (target as Element).closest !== "function") return null;
  const element = (target as Element).closest("[data-terminal-id]");
  const id = element?.getAttribute("data-terminal-id");
  if (!element || !id) return null;
  return { element, id };
}

function hasFileTransfer(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  if ((dataTransfer.files?.length ?? 0) > 0) return true;
  const types = dataTransfer.types as { includes?: (value: string) => boolean } | readonly string[] | undefined;
  return typeof types?.includes === "function" ? types.includes("Files") : false;
}

/** Installed in preload's isolated world; renderer-created DOM events carry no authority. */
export function installPromptAttachmentGestures(deps: PromptAttachmentGestureDeps): () => void {
  const dragover = (event: Event) => {
    const value = event as DragEvent;
    if (!value.isTrusted || !hasFileTransfer(value.dataTransfer)) return;
    value.preventDefault();
  };
  const drop = (event: Event) => {
    const value = event as DragEvent;
    if (!value.isTrusted) return;
    if (!value.dataTransfer?.files.length) {
      if (hasFileTransfer(value.dataTransfer)) value.preventDefault();
      return;
    }
    value.preventDefault();
    const pane = terminalForEvent(value);
    if (!pane) return;
    value.stopImmediatePropagation();
    const files = Array.from(value.dataTransfer.files).map((file) => ({
      name: file.name,
      mimeType: file.type,
      path: deps.getPathForFile(file),
    }));
    deps.report({ terminalId: pane.id, kind: "files", count: files.length, phase: "started" });
    void (async () => {
      try {
        const token = await deps.invoke("prompt-attachments:register-drop", pane.id, files);
        const result = await deps.invoke("prompt-attachments:drop", token);
        deps.report({ terminalId: pane.id, kind: "files", count: files.length, phase: "finished", result });
      } catch (error) {
        deps.report({ terminalId: pane.id, kind: "files", count: files.length, phase: "finished", error });
      }
    })();
  };
  const paste = (event: Event) => {
    const value = event as ClipboardEvent;
    const pane = terminalForEvent(value);
    if (!value.isTrusted || !pane || !value.clipboardData) return;
    const active = deps.document.activeElement;
    if (!active || !pane.element.contains(active)) return;
    const pastedFiles = Array.from(value.clipboardData.files ?? [])
      .map((file) => ({
        name: file.name,
        mimeType: file.type,
        path: deps.getPathForFile(file),
      }))
      .filter((file) => Boolean(file.path));
    if (pastedFiles.length > 0) {
      value.preventDefault();
      value.stopImmediatePropagation();
      deps.report({ terminalId: pane.id, kind: "files", count: pastedFiles.length, phase: "started" });
      void (async () => {
        try {
          const token = await deps.invoke("prompt-attachments:register-drop", pane.id, pastedFiles);
          const result = await deps.invoke("prompt-attachments:drop", token);
          deps.report({ terminalId: pane.id, kind: "files", count: pastedFiles.length, phase: "finished", result });
        } catch (error) {
          deps.report({ terminalId: pane.id, kind: "files", count: pastedFiles.length, phase: "finished", error });
        }
      })();
      return;
    }
    if (value.clipboardData.getData("text/plain")) return;
    // Some platforms expose clipboard images without advertising an image MIME
    // type in the DOM event. Main inspects the clipboard only after this trusted,
    // focused-pane paste gesture and returns not-image if it contains no image.
    value.preventDefault();
    value.stopImmediatePropagation();
    deps.report({ terminalId: pane.id, kind: "image", count: 1, phase: "started" });
    void (async () => {
      try {
        const token = await deps.invoke("prompt-attachments:register-paste", pane.id);
        const result = await deps.invoke("prompt-attachments:clipboard-image", token);
        deps.report({ terminalId: pane.id, kind: "image", count: 1, phase: "finished", result });
      } catch (error) {
        deps.report({ terminalId: pane.id, kind: "image", count: 1, phase: "finished", error });
      }
    })();
  };
  const contextPaste = (event: Event) => {
    const value = event as MouseEvent;
    const pane = terminalForEvent(value);
    const target = value.target as Element | null;
    if (!value.isTrusted || !pane || !target?.closest("[data-aya-terminal-paste]")) return;
    deps.report({ terminalId: pane.id, kind: "image", count: 1, phase: "started" });
    void (async () => {
      try {
        const token = await deps.invoke("prompt-attachments:register-paste", pane.id);
        const result = await deps.invoke("prompt-attachments:context-menu-image", token);
        deps.report({ terminalId: pane.id, kind: "image", count: 1, phase: "finished", result });
      } catch (error) {
        deps.report({ terminalId: pane.id, kind: "image", count: 1, phase: "finished", error });
      }
    })();
  };
  deps.document.addEventListener("dragover", dragover, true);
  deps.document.addEventListener("drop", drop, true);
  deps.document.addEventListener("paste", paste, true);
  deps.document.addEventListener("click", contextPaste, true);
  return () => {
    deps.document.removeEventListener("dragover", dragover, true);
    deps.document.removeEventListener("drop", drop, true);
    deps.document.removeEventListener("paste", paste, true);
    deps.document.removeEventListener("click", contextPaste, true);
  };
}
