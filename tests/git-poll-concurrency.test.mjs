import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeExecutable } from './helpers/executable.mjs';
const root = mkdtempSync(path.join(tmpdir(), 'aya-git-polls-'));
const previousPath = process.env.PATH;
const log = path.join(root, 'events');
const trees = Array.from({ length: 12 }, (_, index) => path.join(root, `tree-${index}`));
for (const tree of trees) mkdirSync(tree);
writeFileSync(log, ''); writeFileSync(path.join(root, 'branch'), 'main');
writeExecutable(path.join(root, 'git'), `#!${process.execPath}
const fs=require('node:fs');
const root=${JSON.stringify(root)},log=${JSON.stringify(log)};
if(process.argv.includes('worktree')) { console.log(${JSON.stringify(trees.map(tree => `worktree ${tree}\nHEAD abc\nbranch refs/heads/main\n`).join('\n'))}); }
else {
 fs.appendFileSync(log,JSON.stringify({event:'start',pid:process.pid})+'\\n');
 setTimeout(()=>{fs.appendFileSync(log,JSON.stringify({event:'end',pid:process.pid})+'\\n');console.log('## '+fs.readFileSync(root+'/branch','utf8')+'\\n?? scratch');},80);
}
`);
process.env.PATH = root + path.delimiter + previousPath;
const { getGitInfo, listWorktreeStatus } = await import('../dist-electron/git.js');
test.after(() => { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); });
const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
test('many simultaneous consumers share one Git process, while the next poll observes new state', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => getGitInfo(root)));
  assert.equal(events().filter(event => event.event === 'start').length, 1);
  assert.ok(results.every(result => result.branch === 'main' && result.dirty === 1));
  results[0].branch = 'mutated'; assert.equal(results[1].branch, 'main');
  writeFileSync(path.join(root, 'branch'), 'feature');
  assert.equal((await getGitInfo(root)).branch, 'feature');
  assert.equal(events().filter(event => event.event === 'start').length, 2);
});
test('a worktree refresh bounds the number of simultaneous Git subprocesses', async () => {
  writeFileSync(log, '');
  const result = await listWorktreeStatus(root);
  let active = 0, peak = 0;
  for (const event of events()) { active += event.event === 'start' ? 1 : -1; peak = Math.max(peak, active); }
  assert.equal(result.length, 12); assert.ok(result.every(tree => tree.dirty === 1));
  assert.ok(peak > 1); assert.ok(peak <= 4, `peak Git processes: ${peak}`); assert.equal(active, 0);
});
