import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('native fullscreen removes the title-bar hit surface and restores windowed chrome', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'aya-window-chrome-'));
  try {
    const source = join(dir, 'test.mm'), binary = join(dir, 'test');
    writeFileSync(source, `#include "macos-window-chrome.h"
#include <cassert>
int main() {
  const auto controls = NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
  auto mask = controls | NSWindowStyleMaskTitled;
  for (int i = 0; i < 3; ++i) {
    mask = AyaWindowChromeStyleMask(mask | NSWindowStyleMaskFullScreen);
    assert(!(mask & NSWindowStyleMaskTitled));
    assert(mask & NSWindowStyleMaskFullScreen);
    assert((mask & controls) == controls);
    assert(AyaWindowChromeStyleMask(mask) == mask);
    mask = AyaWindowChromeStyleMask(mask & ~NSWindowStyleMaskFullScreen);
    assert(mask & NSWindowStyleMaskTitled);
    assert(mask & NSWindowStyleMaskFullSizeContentView);
    assert((mask & controls) == controls);
  }
}
`);
    const build = spawnSync('clang++', ['-std=c++17', '-fobjc-arc', '-framework', 'Cocoa', '-I', resolve('electron/native'), source, '-o', binary], { encoding: 'utf8', timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
