import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workspaceLink } from '../shared/workspace-link.cjs';
import { readWorkspaceFile } from '../dist-electron/workspace-file.js';

test('local links retain line numbers and reject URL schemes', () => {
  assert.deepEqual(workspaceLink('/project/file.ts:42'), { path: '/project/file.ts', line: 42 });
  assert.deepEqual(workspaceLink('file.ts:42'), { path: 'file.ts', line: 42 });
  assert.deepEqual(workspaceLink('./with%20space.ts#L12'), { path: './with space.ts', line: 12 });
  assert.deepEqual(workspaceLink('file:///project/a.ts#L3'), { path: '/project/a.ts', line: 3 });
  for (const value of ['https://example.com', 'javascript:123', 'data:text/plain,abc', '//host/file', 'file://host/path', '%00file', '#section']) assert.equal(workspaceLink(value), null, value);
});

test('file preview resolves workspace paths, selects the line and refuses escapes and binary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aya-file-preview-'));
  try {
    await writeFile(join(root, 'example.ts'), Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
    const preview = await readWorkspaceFile(root, 'example.ts:150');
    assert.equal(preview.line, 150);
    assert.equal(preview.lines[150 - preview.firstLine], 'line 150');
    assert.equal(preview.lines.length, 121);
    await symlink(tmpdir(), join(root, 'outside'));
    await assert.rejects(readWorkspaceFile(root, 'outside'), /inside the selected workspace/);
    await assert.rejects(readWorkspaceFile(root, '..'), /inside the selected workspace/);
    await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]));
    await assert.rejects(readWorkspaceFile(root, 'binary'), /not a text file/);
    await writeFile(join(root, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(readWorkspaceFile(root, 'large'), /up to 2 MiB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
