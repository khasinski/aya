import { BrowserWindow, Menu, dialog, type WebContents } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { GuiArtifact } from '../shared/codex-gui';

export async function saveGuiArtifact(artifact: GuiArtifact, contents: WebContents) {
  if (artifact.kind !== 'html' && artifact.kind !== 'image') throw Error('Only widgets and graphics can be saved');
  const extension = artifact.kind === 'html' ? 'html' : artifact.dataUrl.startsWith('data:image/svg+xml') ? 'svg' : artifact.dataUrl.startsWith('data:image/jpeg') ? 'jpg' : artifact.dataUrl.startsWith('data:image/webp') ? 'webp' : 'png';
  const owner = BrowserWindow.fromWebContents(contents);
  if (!owner) throw Error('Window is closed');
  const result = await dialog.showSaveDialog(owner, { defaultPath: `${artifact.title.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80)}.${extension}`, filters: [{ name: 'Artifact', extensions: [extension] }] });
  if (result.canceled || !result.filePath) return false;
  await writeFile(result.filePath, artifact.kind === 'html' ? artifact.html : Buffer.from(artifact.dataUrl.split(',')[1], 'base64'));
  return true;
}

/** Chromium copies the rendered image, including SVG, into the native clipboard. */
export function installArtifactImageMenu(contents: WebContents, findImage: (url: string) => GuiArtifact | undefined | Promise<GuiArtifact | undefined>) {
  contents.on('context-menu', (_event, params) => {
    void (async () => {
    if (params.mediaType !== 'image') return;
    const artifact = await findImage(params.srcURL);
    const owner = BrowserWindow.fromWebContents(contents);
    if (artifact?.kind !== 'image' || !owner || contents.isDestroyed()) return;
    Menu.buildFromTemplate([
      { label: 'Copy image', click: () => { if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y); } },
      { label: 'Save image…', click: () => { void saveGuiArtifact(artifact, contents).catch(error => {
        if (!owner.isDestroyed()) void dialog.showMessageBox(owner, { type: 'error', message: 'Could not save image', detail: error instanceof Error ? error.message : String(error) });
      }); } },
    ]).popup({ window: owner });
    })().catch(error => console.warn('Artifact image menu failed', error));
  });
}
