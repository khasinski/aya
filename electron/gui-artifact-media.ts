import { Parser } from 'htmlparser2';
import { createHash,randomUUID } from 'node:crypto';
import { constants,createReadStream,createWriteStream } from 'node:fs';
import { mkdir,open,readdir,realpath,rename,stat,unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable,Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { GuiArtifactMedia } from '../shared/codex-gui';
import { AYA_HOME } from './paths';

export const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_MEDIA_FILES = 32;
const directory = () => path.join(AYA_HOME, 'conversations', 'media');
const hashPattern = /^[a-f0-9]{64}$/;
const extensions: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'text/vtt': 'vtt' };
const leases = new Map<string, Set<string>>();
export function retainArtifactMedia(owner: string, media: readonly GuiArtifactMedia[]) { leases.set(owner, new Set(media.map(m => m.hash))); }
export function releaseArtifactMedia(owner: string) { leases.delete(owner); }
export function validArtifactMedia(media: readonly GuiArtifactMedia[]): boolean {
  return media.length <= MAX_MEDIA_FILES && media.every(m => m && hashPattern.test(m.hash) && extensions[m.mime] && Number.isSafeInteger(m.size) && m.size > 0 && m.size <= MAX_MEDIA_BYTES && typeof m.name === 'string');
}
function contained(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function sniff(data: Buffer): string | null {
  if (data.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && data.includes(Buffer.from('webm'))) return 'video/webm';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (data.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (data.toString('ascii', 0, 3) === 'ID3' || (data[0] === 255 && (data[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (/^(?:\ufeff)?WEBVTT(?:\s|$)/.test(data.toString('utf8'))) return 'text/vtt';
  return null;
}
async function importMedia(root: string, base: string, name: string): Promise<GuiArtifactMedia> {
  const source = await realpath(name.startsWith('file:') ? fileURLToPath(name) : path.resolve(base, name));
  if (!contained(root, source)) throw Error('Artifact media must be inside the selected workspace: ' + name);
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let temp: string | undefined;
  try {
    const info = await file.stat();
    if (!info.isFile() || !info.size || info.size > MAX_MEDIA_BYTES) throw Error('Artifact media must be a non-empty regular file up to 256 MiB: ' + name);
    const header = Buffer.alloc(Math.min(4096, info.size)); await file.read(header, 0, header.length, 0);
    const mime = sniff(header);
    if (!mime) throw Error('Unsupported artifact media. Use MP4 or WebM video, MP3/WAV/Ogg audio, PNG/JPEG/WebP posters or WebVTT captions: ' + name);
    await mkdir(directory(), { recursive: true });
    temp = path.join(directory(), randomUUID() + '.tmp');
    const hash = createHash('sha256'); let bytes = 0;
    await pipeline(file.createReadStream({ start: 0, autoClose: false }), new Transform({ transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_MEDIA_BYTES) { done(Error('Artifact media grew beyond 256 MiB')); return; }
      hash.update(chunk); done(null, chunk);
    } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    if (bytes !== info.size) throw Error('Artifact media changed while being copied. Retry presenting it.');
    const digest = hash.digest('hex');
    await rename(temp, path.join(directory(), digest + '.bin')); temp = undefined;
    return { hash: digest, mime, size: bytes, name };
  } finally { await file.close(); if (temp) await unlink(temp).catch(() => {}); }
}
const escape = (s: string) => s.replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!);
/** Parse real tags, not text inside scripts/comments. Local media is copied once,
 * leaving only hashes in HTML and snapshot JSON. Never mount a workspace directory. */
export async function attachArtifactMedia(root: string, base: string, html: string, explicit: string[] = []) {
  const replacements: { start: number; end: number; tag: string; attrs: Record<string, string>; keys: string[] }[] = [];
  const parser = new Parser({ onopentag(tag, attrs) {
    const keys = (['video', 'audio', 'source', 'track'].includes(tag) && attrs.src ? ['src'] : []).concat(tag === 'video' && attrs.poster ? ['poster'] : []);
    const player = tag === 'video' || tag === 'audio';
    // The sandbox has an opaque origin. Anonymous CORS permits caption tracks
    // and canvas frame analysis against our explicitly attached, CORS-enabled media.
    if (keys.length || player) replacements.push({ start: parser.startIndex, end: parser.endIndex + 1, tag, attrs: { ...(player ? { crossorigin: 'anonymous' } : {}), ...attrs }, keys });
  } }, { decodeEntities: true });
  parser.write(html); parser.end();
  const imported = new Map<string, GuiArtifactMedia>();
  let resolvedRoot: string | undefined;
  let total = 0;
  const attach = async (name: string) => {
    if (imported.has(name)) return imported.get(name)!;
    if (imported.size >= MAX_MEDIA_FILES) throw Error('An artifact supports up to 32 local media files');
    resolvedRoot ||= await realpath(root);
    const media = await importMedia(resolvedRoot, base, name);
    total += media.size;
    if (total > MAX_TOTAL_BYTES) throw Error('Artifact media exceeds the 512 MiB total limit');
    imported.set(name, media); return media;
  };
  for (const name of explicit) await attach(name);
  for (const replacement of replacements) {
    for (const key of replacement.keys) {
      const ref = replacement.attrs[key].trim();
      if (!ref || ref.startsWith('#') || (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith('file:')) || ref.startsWith('//')) continue;
      const fragment = ref.includes('#') ? ref.slice(ref.indexOf('#')) : '';
      const raw = ref.split(/[?#]/)[0];
      const name = raw.startsWith('file:') ? raw : decodeURIComponent(raw);
      const media = await attach(name);
      replacement.attrs[key] = 'aya-media:' + media.hash + fragment;
    }
  }
  for (const r of replacements.reverse()) html = html.slice(0, r.start) + '<' + r.tag + Object.entries(r.attrs).map(([key, value]) => ' ' + key + '="' + escape(value) + '"').join('') + '>' + html.slice(r.end);
  return { html, ...(imported.size ? { media: [...imported.values()] } : {}) };
}
export function mediaUrls(html: string, resolve: (hash: string) => string): string {
  return html.replace(/aya-media:([a-f0-9]{64})/g, (_match, hash: string) => resolve(hash));
}
/** A single byte range, including suffix ranges. Chromium uses this to seek. */
export function mediaRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && start < size ? { start, end } : null;
}
export async function artifactMediaResponse(request: Request, media: GuiArtifactMedia): Promise<Response> {
  if (!validArtifactMedia([media])) return new Response('Invalid media', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  const file = await open(path.join(directory(), media.hash + '.bin'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== media.size) throw Error('Stored artifact media is missing or damaged');
    const range = mediaRange(request.headers.get('range'), info.size);
    if (!range) { await file.close(); return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + info.size } }); }
    const partial = request.headers.has('range');
    const headers = { 'Content-Type': media.mime, 'Content-Length': String(range.end - range.start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...(partial ? { 'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + info.size } : {}) };
    if (request.method === 'HEAD') { await file.close(); return new Response(null, { status: partial ? 206 : 200, headers }); }
    const body = Readable.toWeb(file.createReadStream({ start: range.start, end: range.end }));
    return new Response(body as ReadableStream, { status: partial ? 206 : 200, headers });
  } catch (error) { await file.close().catch(() => {}); throw error; }
}
export async function exportArtifactMedia(html: string, media: readonly GuiArtifactMedia[], target: string): Promise<string> {
  if (!validArtifactMedia(media)) throw Error('Invalid artifact media');
  if (!media.length) return html;
  const folder = path.basename(target, path.extname(target)) + '.assets';
  const destination = path.join(path.dirname(target), folder);
  if (media.length) await mkdir(destination, { recursive: true });
  const urls = new Map<string, string>();
  for (const item of media) {
    const name = item.hash + '.' + extensions[item.mime], temp = path.join(destination, randomUUID() + '.tmp');
    try {
      await pipeline(createReadStream(path.join(directory(), item.hash + '.bin')), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      await rename(temp, path.join(destination, name));
    } finally { await unlink(temp).catch(() => {}); }
    urls.set(item.hash, encodeURIComponent(folder) + '/' + name);
  }
  const portable = mediaUrls(html, hash => { const url = urls.get(hash); if (!url) throw Error('Missing artifact media'); return url; });
  // JS-created players use the same API in exported files as in Aya.
  const mapping = Object.fromEntries(media.map(item => [item.name, urls.get(item.hash)]));
  return '<script>window.ayaWidget=Object.freeze({...window.ayaWidget,asset:name=>(' + JSON.stringify(mapping).replace(/</g, '\\u003c') + ')[name]});</script>' + portable;
}
export async function collectUnusedArtifactMedia(referenced: Set<string>, now: number, remove: (file: string) => Promise<unknown> = unlink): Promise<number> {
  const retained = new Set([...referenced, ...[...leases.values()].flatMap(set => [...set])]);
  let names: string[];
  try { names = await readdir(directory()); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  let removed = 0;
  for (const name of names.filter(n => /^[a-f0-9]{64}\.bin$/.test(n))) {
    if (retained.has(name.slice(0, -4))) continue;
    const target = path.join(directory(), name), info = await stat(target);
    if (now - info.mtimeMs < 7 * 24 * 60 * 60 * 1000) continue;
    await remove(target); removed++;
  }
  return removed;
}
