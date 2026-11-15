import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, truncate, stat, unlink, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const home = await mkdtemp(path.join(tmpdir(), 'aya-media-test-'));
process.env.AYA_HOME = path.join(home, 'aya');
after(() => rm(home, { recursive: true, force: true }));
const { presentArtifact } = await import('../dist-electron/gui-artifact-tools.js');
const { artifactMediaResponse, mediaRange, exportArtifactMedia, collectUnusedArtifactMedia, MAX_MEDIA_BYTES } = await import('../dist-electron/gui-artifact-media.js');
const { saveConversation, loadConversation, collectUnusedConversationAssets } = await import('../dist-electron/gui-conversation-store.js');
const webm = await readFile(new URL('./fixtures/artifact-video.webm', import.meta.url));
const workspace = path.join(home, 'project'); await mkdir(path.join(workspace, 'reports'), { recursive: true });
await writeFile(path.join(workspace, 'clip.webm'), webm);

test('HTML video paths are resolved beside the HTML file, copied and restored without the source', async () => {
  await writeFile(path.join(workspace, 'reports', 'video.html'), '<video controls><source src="../clip.webm" type="video/webm"></video>');
  const artifact = await presentArtifact(workspace, { kind: 'html', title: 'Video', path: 'reports/video.html' });
  assert.equal(artifact.media[0].mime, 'video/webm');
  assert.match(artifact.html, /src="aya-media:[a-f0-9]{64}"/);
  assert.ok(JSON.stringify(artifact).length < 1000, 'binary content is not embedded in HTML or JSON');
  const snapshot = { cwd: workspace, view: { artifacts: [artifact], artifactHistory: { [artifact.id]: [artifact] } } };
  await saveConversation('video', snapshot);
  await unlink(path.join(workspace, 'clip.webm'));
  const restored = (await loadConversation('video')).view.artifacts[0];
  assert.deepEqual(restored, artifact);
  const response = await artifactMediaResponse(new Request('http://test/', { headers: { Range: 'bytes=5-23' } }), restored.media[0]);
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 5-23/' + webm.length);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), webm.subarray(5, 24));
  await writeFile(path.join(workspace, 'clip.webm'), webm);
});
test('HTML parsing ignores script and comment text and decodes attribute entities and URL escapes', async () => {
  await writeFile(path.join(workspace, 'clip & demo.webm'), webm);
  const artifact = await presentArtifact(workspace, { kind: 'html', title: 'Encoded', html: '<!-- <video src="missing.webm"> --><script>const example = \'<video src="missing.webm">\';</script><video src="clip%20%26%20demo.webm" controls></video>' });
  assert.equal(artifact.media.length, 1);
  assert.equal(artifact.media[0].name, 'clip & demo.webm');
  assert.match(artifact.html, /const example = '<video src="missing.webm">'/);
  assert.equal((await presentArtifact('/nonexistent', { kind: 'html', title: 'Inline', html: '<p>No assets</p>' })).html, '<p>No assets</p>');
});
test('local media cannot escape the workspace or silently attach invalid/oversized files', async () => {
  const outside = path.join(home, 'outside.webm'); await writeFile(outside, webm);
  await symlink(outside, path.join(workspace, 'escape.webm'));
  await assert.rejects(presentArtifact(workspace, { kind: 'html', title: 'Escape', html: '<video src="escape.webm"></video>' }), /inside the selected workspace/);
  await writeFile(path.join(workspace, 'bad.webm'), 'not a video');
  await assert.rejects(presentArtifact(workspace, { kind: 'html', title: 'Invalid', html: '<video src="bad.webm"></video>' }), /Unsupported artifact media/);
  await writeFile(path.join(workspace, 'large.webm'), webm); await truncate(path.join(workspace, 'large.webm'), MAX_MEDIA_BYTES + 1);
  await assert.rejects(presentArtifact(workspace, { kind: 'html', title: 'Large', html: '<video src="large.webm"></video>' }), /256 MiB/);
});
test('byte ranges, suffixes, HEAD and unsatisfiable ranges have exact HTTP semantics', async () => {
  assert.deepEqual(mediaRange('bytes=2-7', 10), { start: 2, end: 7 });
  assert.deepEqual(mediaRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(mediaRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(mediaRange('bytes=0-999', 10), { start: 0, end: 9 });
  for (const range of ['bytes=-0', 'bytes=10-', 'bytes=5-2', 'bytes=0-1,4-5', 'bad']) assert.equal(mediaRange(range, 10), null);
  const artifact = await presentArtifact(workspace, { kind: 'html', title: 'Ranges', html: '<video src="clip.webm"></video>' });
  const head = await artifactMediaResponse(new Request('http://test/', { method: 'HEAD' }), artifact.media[0]);
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(webm.length)); assert.equal(await head.text(), '');
  const invalid = await artifactMediaResponse(new Request('http://test/', { headers: { Range: 'bytes=999999-' } }), artifact.media[0]);
  assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), 'bytes */' + webm.length);
});
test('HTML export creates portable sibling assets and includes explicitly declared JS media', async () => {
  const artifact = await presentArtifact(workspace, { kind: 'html', title: 'Export', html: '<video src="clip.webm"></video>', assets: ['clip.webm'] });
  const target = path.join(home, 'saved video.html');
  const html = await exportArtifactMedia(artifact.html, artifact.media, target);
  assert.doesNotMatch(html, /aya-media:/); assert.match(html, /saved%20video\.assets\/[a-f0-9]{64}\.webm/);
  assert.match(html, /asset:name/);
  assert.deepEqual(await readFile(path.join(home, 'saved video.assets', artifact.media[0].hash + '.webm')), webm);
});
test('cleanup keeps media referenced by saved artifact revisions and removes old orphans', async () => {
  const mediaDir = path.join(home, 'aya', 'conversations', 'media');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  for (const name of await readdir(mediaDir)) await utimes(path.join(mediaDir, name), old, old);
  const referenced = (await loadConversation('video')).view.artifacts[0].media[0];
  const orphan = 'a'.repeat(64) + '.bin'; await writeFile(path.join(mediaDir, orphan), 'orphan'); await utimes(path.join(mediaDir, orphan), old, old);
  await collectUnusedConversationAssets();
  assert.ok((await stat(path.join(mediaDir, referenced.hash + '.bin'))).isFile());
  await assert.rejects(stat(path.join(mediaDir, orphan)), { code: 'ENOENT' });
  // Active preview leases are covered by WidgetDocumentCache; a caller can also retain explicit references.
  assert.equal(await collectUnusedArtifactMedia(new Set([referenced.hash]), Date.now()), 0);
});

test('active TUI artifacts and cached previews protect their media from cleanup', async () => {
  const { TuiArtifactStore } = await import('../dist-electron/tui-artifacts.js');
  const { WidgetDocumentCache } = await import('../dist-electron/widget-document-cache.js');
  await writeFile(path.join(workspace, 'leased.webm'), Buffer.concat([webm, Buffer.from('lease')]));
  const store = new TuiArtifactStore();
  const input = { kind: 'html', title: 'Lease', html: '<video src="leased.webm"></video>', workspaceDir: workspace };
  const artifact = (await store.present(input, 'test-pane')).stored.artifact;
  const location = path.join(home, 'aya', 'conversations', 'media', artifact.media[0].hash + '.bin');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(location, old, old);
  const referenced = new Set((await loadConversation('video')).view.artifacts[0].media.map(m => m.hash));
  assert.equal(await collectUnusedArtifactMedia(referenced, Date.now()), 0);
  const cache = new WidgetDocumentCache(); cache.set('lease', 'preview-owner', artifact.html, artifact.media);
  store.forget('test-pane');
  assert.equal(await collectUnusedArtifactMedia(referenced, Date.now()), 0);
  cache.clearOwner('preview-owner');
  assert.equal(await collectUnusedArtifactMedia(referenced, Date.now()), 1);
  await assert.rejects(stat(location), { code: 'ENOENT' });
});
