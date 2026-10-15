// Two separate runtimes exchange the production DTO, without a PTY/network.
const fs = require('node:fs'), assert = require('node:assert/strict');
const {VtCheckpointTerminal} = require('../../dist-electron/vt-checkpoint.js');
const {capture} = require('../../dist-electron/vt-checkpoint-binding.js');
const write = (p, data) => new Promise(resolve => p.write(data, resolve));
const suffix = '12;34;56m完成界\x1b[?1049l\x1b8\tAFTER\x1b[6n';
(async () => {
  if (process.argv[2] === 'produce') {
    const p = new VtCheckpointTerminal({cols:100,rows:30,scrollback:64,allowProposedApi:true});
    try {
      await write(p, 'history\r\n'.repeat(90)+'\x1b7\x1b[?1049hALT\x1b]4;1;#123456\x07');
      await write(p, '\x1b[38;2;');
      const checkpoint = await p.checkpoint({generation:'cross-runtime',composerSeen:true,osc9001Carry:'\x1b]9001;half'});
      await write(p, suffix);
      fs.writeFileSync(process.argv[3], JSON.stringify({checkpoint,expected:JSON.parse(capture(p.terminal))}));
    } finally { p.dispose(); }
  } else {
    const {checkpoint,expected} = JSON.parse(fs.readFileSync(process.argv[3]));
    const p = await VtCheckpointTerminal.import(checkpoint);
    try { await write(p, suffix); assert.deepEqual(JSON.parse(capture(p.terminal)), expected); assert.equal(checkpoint.metadata.composerSeen,true); }
    finally { p.dispose(); }
  }
  console.log(JSON.stringify({mode:process.argv[2],node:process.versions.node,electron:process.versions.electron??null,passed:true}));
})().catch(error => { console.error(error); process.exitCode=1; });
