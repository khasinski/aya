const fs=require('node:fs'),assert=require('node:assert/strict');
const {CompactVt,capture,write}=require('./vt-checkpoint.cjs');
const suffix='12;34;56m完成界\x1b[?1049l\x1b8\tAFTER\x1b[6n';
(async()=>{
 if(process.argv[2]==='produce'){
  const p=new CompactVt({cols:100,rows:30,scrollback:64},{generation:'cross-runtime',composerSeen:true,osc9001Carry:'\x1b]9001;half'});
  try{await p.write('history\r\n'.repeat(90)+'\x1b7\x1b[?1049hALT\x1b]4;1;#123456\x07');await p.write('\x1b[38;2;');const checkpoint=p.checkpoint();await p.write(suffix);fs.writeFileSync(process.argv[3],JSON.stringify({checkpoint,expected:JSON.parse(capture(p.term))}));}finally{p.term.dispose();}
 }else{
  const {checkpoint,expected}=JSON.parse(fs.readFileSync(process.argv[3]));const p=await CompactVt.import(checkpoint);
  try{await write(p.term,suffix);assert.deepEqual(JSON.parse(capture(p.term)),expected);assert.equal(p.metadata.composerSeen,true);}finally{p.term.dispose();}
 }
 console.log(JSON.stringify({mode:process.argv[2],node:process.versions.node,electron:process.versions.electron??null,passed:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});
