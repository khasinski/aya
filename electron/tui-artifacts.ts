// Artifacts for TUI panes: what `aya present` hands over, kept per pane and shown in a preview window. The GUI
// conversation keeps its own artifacts beside the messages (gui-artifact-tools.ts); this is the same set of kinds
// (html, image, table, metric) for an agent that only has a terminal. Pure of Electron, so plain Node tests import it.
import * as path from "node:path";
import { presentArtifact } from "./gui-artifact-tools";
import { retainArtifactMedia, releaseArtifactMedia } from './gui-artifact-media';
import { scheduleConversationAssetCollection } from './gui-conversation-store';
import type { GuiArtifact } from "../shared/codex-gui";

export interface TuiArtifactInput {
  kind: "html" | "image" | "table" | "metric";
  title: string;
  html?: string;
  htmlBaseDir?: string;
  workspaceDir?: string;
  assets?: string[];
  imagePath?: string;
  columns?: string[];
  rows?: string[][];
  value?: string;
  description?: string;
  artifactId?: string;
}
export interface StoredArtifact { artifact: GuiArtifact; terminalId?: string; updatedAt: number }

export const MAX_TUI_ARTIFACTS = 100;

export class TuiArtifactStore {
  private readonly items = new Map<string, StoredArtifact>();
  constructor(private readonly max = MAX_TUI_ARTIFACTS, private readonly now = () => Date.now()) {}

  /** Validates and stores; with artifactId it replaces that artifact's content and bumps its revision. */
  async present(input: TuiArtifactInput, terminalId?: string): Promise<{ stored: StoredArtifact; updated: boolean }> {
    const previous = input.artifactId ? this.items.get(input.artifactId) : undefined;
    if (input.artifactId && !previous) throw new Error(`no artifact "${input.artifactId}"; list them with aya artifact list`);
    if (previous && previous.terminalId !== terminalId) throw new Error(`artifact "${input.artifactId}" belongs to another pane`);
    let root = input.imagePath ? path.dirname(path.resolve(input.imagePath)) : input.workspaceDir || input.htmlBaseDir || process.cwd();
    if (input.htmlBaseDir && path.relative(root, input.htmlBaseDir).split(path.sep).includes('..')) root = input.htmlBaseDir;
    const built = await presentArtifact(root, {
      kind: input.kind, title: input.title, html: input.html, path: input.imagePath ? path.basename(input.imagePath) : undefined,
      columns: input.columns, rows: input.rows, value: input.value, description: input.description, assets: input.assets,
    }, { htmlBaseDir: input.htmlBaseDir });
    const artifact = { ...built, id: previous ? previous.artifact.id : built.id, revision: previous ? (previous.artifact.revision ?? 1) + 1 : 1 } as GuiArtifact;
    this.items.delete(artifact.id);
    this.items.set(artifact.id, { artifact, ...(terminalId ? { terminalId } : {}), updatedAt: this.now() });
    retainArtifactMedia('tui:' + artifact.id, artifact.kind === 'html' ? artifact.media || [] : []);
    if (artifact.kind === 'html' && artifact.media?.length) scheduleConversationAssetCollection();
    while (this.items.size > this.max) { const id = this.items.keys().next().value!; this.items.delete(id); releaseArtifactMedia('tui:' + id); }
    return { stored: this.items.get(artifact.id)!, updated: Boolean(previous) };
  }

  get(id: string): StoredArtifact | undefined { return this.items.get(id); }

  /** Newest first; a pane sees only its own, a caller outside Aya sees all. */
  list(terminalId?: string): StoredArtifact[] {
    return [...this.items.values()].filter((item) => !terminalId || item.terminalId === terminalId).reverse();
  }

  forget(terminalId: string): void {
    for (const [id, item] of this.items) if (item.terminalId === terminalId) { this.items.delete(id); releaseArtifactMedia('tui:' + id); }
  }
}

export function describeArtifact(item: StoredArtifact): string {
  const { artifact } = item;
  return `${artifact.id}  ${artifact.kind}  r${artifact.revision ?? 1}  ${artifact.title}`;
}
