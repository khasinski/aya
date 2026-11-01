// The artifact tools Aya offers every GUI session (Codex, Pi, Claude, Antigravity):
// their schemas and the code that turns a tool call into an artifact. A leaf: the
// session modules import it, so it imports none of them.
import { realpath, stat, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GuiArtifact } from '../shared/codex-gui';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
export const PRESENT_TOOL = {
  type: 'function', name: 'aya_present',
  description: 'Display a rich artifact in Aya beside the conversation. Use for comparisons/tables, metric cards, a local PNG/JPEG/WebP/SVG image, or an interactive HTML widget. HTML supports inline JavaScript, SVG and canvas, with no network access. Supply html inline, or path to a self-contained workspace HTML file. The user can select a table row and ask a follow-up. Paths are relative to the workspace. Set open=true to open the drawer and select this artifact immediately. Do not print the artifact JSON in chat.',
  inputSchema: {
    type: 'object', properties: {
      artifactId: { type: 'string', description: 'An existing ID returned by aya_present, to update that artifact without creating another card.' },
      html: { type: 'string', description: 'Self-contained HTML/CSS/JavaScript. Use inline scripts and styles, embedded data images, SVG or canvas. No network or file access. Call window.ayaWidget.suggest(text) to prepare a user follow-up; it is never sent automatically.' },
      open: { type: 'boolean', description: 'Open the drawer and select this artifact. Defaults to false.' },
      kind: { type: 'string', enum: ['table', 'metric', 'image', 'html'] }, title: { type: 'string' },
      columns: { type: 'array', items: { type: 'string' } },
      rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      value: { type: 'string' }, description: { type: 'string' }, path: { type: 'string' },
    }, required: ['kind', 'title'], additionalProperties: false,
  },
};
export const OPEN_ARTIFACT_TOOL = {
  type: 'function', name: 'aya_open_artifact',
  description: 'Open an existing artifact in Aya and select it in the artifacts drawer. Use the artifactId returned by aya_present. This does not create another copy.',
  inputSchema: { type: 'object', properties: { artifactId: { type: 'string' } }, required: ['artifactId'], additionalProperties: false },
};
export async function workspaceImage(root: string, file: string): Promise<string> {
  const resolvedRoot = await realpath(root), resolved = await realpath(path.resolve(root, file));
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Image must be a file inside the selected workspace');
  const info = await stat(resolved);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw Error('Image must be a regular file under 8 MB');
  const data = await readFile(resolved);
  if (data.length > 8 * 1024 * 1024) throw Error('Image is too large');
  const mime = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
    : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
    : path.extname(resolved).toLowerCase() === '.svg' && /<svg(?:\s|>)/i.test(data.toString('utf8')) ? 'image/svg+xml' : null;
  if (!mime) throw Error('Supported images: PNG, JPEG, WebP and SVG');
  return `data:${mime};base64,${data.toString('base64')}`;
}
export async function presentArtifact(root: string, args: unknown): Promise<GuiArtifact> {
  const value = object(args), title = text(value.title).slice(0, 200), id = randomUUID();
  if (!title) throw Error('Artifact title is required');
  if (value.kind === 'html') {
    let html = value.html;
    if (typeof html !== 'string' && typeof value.path === 'string') {
      const rootPath = await realpath(root), file = await realpath(path.resolve(root, value.path));
      const relative = path.relative(rootPath, file);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('HTML must be a file inside the workspace');
      const info = await stat(file);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw Error('HTML widgets must be regular files under 2 MiB');
      html = await readFile(file, 'utf8');
    }
    if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024) throw Error('HTML widgets require 1–2097152 bytes of self-contained HTML');
    return { id, kind: 'html', title, html };
  }
  if (value.kind === 'metric') return { id, kind: 'metric', title, value: text(value.value).slice(0, 100), description: text(value.description).slice(0, 2000) };
  if (value.kind === 'image') {
    const file = text(value.path);
    return { id, kind: 'image', title, path: file, dataUrl: await workspaceImage(root, file) };
  }
  if (value.kind === 'table' && Array.isArray(value.columns) && value.columns.length > 0 && value.columns.length <= 12 && value.columns.every(c => typeof c === 'string' && c.length <= 200) && Array.isArray(value.rows) && value.rows.length <= 200 && value.rows.every(r => Array.isArray(r) && r.length === (value.columns as unknown[]).length && r.every(c => typeof c === 'string' && c.length <= 2000))) {
    return { id, kind: 'table', title, columns: value.columns as string[], rows: value.rows as string[][] };
  }
  throw Error('Invalid artifact; tables support up to 12 columns and 200 rows');
}
