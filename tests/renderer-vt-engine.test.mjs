import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const codec=require('../dist-test/terminal-vt-checkpoint.js');

test('Vite client resolves the reviewed artifact and hashes exactly those bytes',async()=>{
 const {createServer}=await import('vite');
 fs.mkdirSync('test-results',{recursive:true});
 const cache=fs.mkdtempSync(path.resolve('test-results/browser-engine-'));
 const server=await createServer({configFile:path.resolve('vite.config.ts'),cacheDir:cache,server:{middlewareMode:true,hmr:false,watch:null},optimizeDeps:{noDiscovery:true,include:[]}});
 try {
  const resolved=await server.environments.client.pluginContainer.resolveId('@xterm/xterm',path.resolve('src/terminal-vt-checkpoint.ts'));
  const artifact=resolved.id.split('?')[0];
  assert.equal(fs.realpathSync(artifact),fs.realpathSync(require.resolve('@xterm/xterm')));
  assert.equal(JSON.parse(server.config.define.__AYA_XTERM_ENGINE__),createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'));
  assert.equal(JSON.parse(server.config.define.__AYA_XTERM_ENGINE__),codec.SUPPORTED_BROWSER_ENGINE);
 }finally{await server.close();fs.rmSync(cache,{recursive:true,force:true});}
});
test('a changed bundled-artifact digest disables checkpoint capture and restore',async()=>{
 const exports={};
 const context=vm.createContext({exports,require,__AYA_XTERM_ENGINE__:'0'.repeat(64),TextEncoder,Uint8Array,btoa,atob,setTimeout,clearTimeout,performance});
 vm.runInContext(fs.readFileSync('dist-test/terminal-vt-checkpoint.js','utf8'),context);
 const term=exports.createRendererVt({cols:80,rows:24,allowProposedApi:true});
 try {
  await assert.rejects(exports.captureRendererVt(term),/tracked from construction/);
  assert.throws(()=>exports.restoreRendererVt(term,{format:1,browserEngine:codec.SUPPORTED_BROWSER_ENGINE}),/engine/);
 }finally{term.dispose();}
});
