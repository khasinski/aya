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

/** Installed in preload's isolated world; renderer-created DOM events carry no authority. */
export function installPromptAttachmentGestures(deps: PromptAttachmentGestureDeps): () => void {
  const drop = (event: Event) => {
    const value = event as DragEvent;
    const pane = terminalForEvent(value);
    if (!value.isTrusted || !pane || !value.dataTransfer?.files.length) return;
    value.preventDefault();
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
    if (!value.isTrusted || !pane || !value.clipboardData || value.clipboardData.getData("text/plain")) return;
    const active = deps.document.activeElement;
    // Some platforms expose clipboard images without advertising an image MIME
    // type in the DOM event. Main inspects the clipboard only after this trusted,
    // focused-pane paste gesture and refuses if it contains no image.
    if (!active || !pane.element.contains(active)) return;
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
  deps.document.addEventListener("drop", drop, true);
  deps.document.addEventListener("paste", paste, true);
  return () => {
    deps.document.removeEventListener("drop", drop, true);
    deps.document.removeEventListener("paste", paste, true);
  };
}
