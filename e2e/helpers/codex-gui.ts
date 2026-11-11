import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seedEnv } from './seed';
import type { SeededEnv } from './seed';

/** Install the fake Codex binary into an isolated environment. */
export function installFakeCodexGui(seed: SeededEnv): void {
  const bin = join(seed.root, 'gui-bin');
  mkdirSync(bin);
  copyFileSync(resolve('tests/helpers/fake-codex-gui.cjs'), join(bin, 'codex'));
  chmodSync(join(bin, 'codex'), 0o755);
  seed.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, 'codex') };
}

/** Create the standard single-tab Codex GUI environment. */
export function seedCodexGui(): SeededEnv {
  const seed = seedEnv({ singleTab: { presetId: 'gui', name: 'Codex GUI' }, presetList: [{ id: 'gui', name: 'Codex GUI', icon: '◆', color: '', command: 'codex', agent: 'codex', interfaceMode: 'gui' }] });
  installFakeCodexGui(seed);
  return seed;
}
