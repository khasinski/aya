import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{InstalledBuild,installedBuildFile}=require('../dist-electron/installed-build.js');
fs.mkdirSync('test-results',{recursive:true});

test('a packaged host script is checked by its app.asar, a plain one by itself',()=>{
  const asar=path.join('/Applications','Aya.app','Contents','Resources','app.asar');
  assert.equal(installedBuildFile(path.join(asar,'dist-electron','pty-host.js')),asar);
  assert.equal(installedBuildFile('/repo/dist-electron/pty-host.js'),'/repo/dist-electron/pty-host.js');
});

test('a build moved away and another put in its place is replaced; the same file is not',()=>{
  const dir=fs.mkdtempSync(path.resolve('test-results/installed-build-')),file=path.join(dir,'app.asar');
  fs.writeFileSync(file,'build A');
  const build=new InstalledBuild(file);
  assert.equal(build.replaced(),false);
  fs.renameSync(file,path.join(dir,'trashed.asar'));
  fs.writeFileSync(file,'build A');
  assert.equal(build.replaced(),true);
});

test('a file that cannot be read, at start or at quit, is never a new build',()=>{
  let fail=false;const stamp={dev:1,ino:2,size:3,mtimeMs:4};
  const later=new InstalledBuild('x',()=>{if(fail)throw Error('gone');return stamp;});
  fail=true;assert.equal(later.replaced(),false);
  const never=new InstalledBuild('x',()=>{throw Error('gone');});
  assert.equal(never.replaced(),false);
});
