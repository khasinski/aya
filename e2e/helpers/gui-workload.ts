import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seedEnv } from './seed';

export const GUI_WORKLOAD = { messages: 2500, artifacts: 32, artifactBytes: 256 * 1024, terminals: 4 };
export function seedGuiWorkload() {
  const seed = seedEnv({ split: false, singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [
    { id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' },
    { id: 'shell', name: 'Shell', icon: '$', color: '', command: 'cat' },
  ] });
  const bin = join(seed.root, 'gui-bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(resolve('tests/helpers/fake-codex-gui.cjs'))});\n`, { mode: 0o755 });
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex') };
  const projectFile = join(seed.ayaHome, 'projects', 'e2e-proj.json'), project = JSON.parse(readFileSync(projectFile, 'utf8'));
  for (let i = 0; i < GUI_WORKLOAD.terminals; i++) project.tabs.push({ id: `workload-shell-${i}`, name: `Workload shell ${i}`, presetId: 'shell' });
  writeFileSync(projectFile, JSON.stringify(project));
  const directory = join(seed.ayaHome, 'conversations'), assets = join(directory, 'assets'); mkdirSync(assets, { recursive: true });
  const artifacts = Array.from({ length: GUI_WORKLOAD.artifacts }, (_, i) => {
    const artifact = { id: `workload-widget-${i}`, title: `Benchmark widget ${i}`, revision: 1, kind: 'html', html: `<h2>Benchmark widget ${i}</h2><!--${'x'.repeat(GUI_WORKLOAD.artifactBytes)}-->` };
    const data = JSON.stringify(artifact), hash = createHash('sha256').update(data).digest('hex');
    writeFileSync(join(assets, hash + '.json'), data);
    return { id: artifact.id, title: artifact.title, revision: 1, kind: artifact.kind, $ayaArtifact: hash };
  });
  const messages = Array.from({ length: GUI_WORKLOAD.messages }, (_, i) => ({ id: `history-${i}`, type: 'assistant', text: `History needle ${i}: ` + 'A historical message with enough text to exercise layout and selection. '.repeat(12) }));
  writeFileSync(join(directory, createHash('sha256').update(seed.tabIds.left).digest('hex') + '.json'), JSON.stringify({ cwd: seed.projectDir, agent: 'codex', threadId: 'workload-thread', storageVersion: 2, view: { messages, artifacts, artifactHistory: Object.fromEntries(artifacts.map(a => [a.id, [a]])), seenArtifactRevisions: Object.fromEntries(artifacts.map(a => [a.id, 1])), selected: artifacts[0].id, drawer: false, prompt: '', turnOutcome: 'complete' } }));
  return seed;
}
