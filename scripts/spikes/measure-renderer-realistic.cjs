// Offline recordings replayed through the same per-chunk display transforms.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{StringDecoder}=require('node:string_decoder');
const {createRendererVt,captureRendererVt}=require('../../dist-test/terminal-vt-checkpoint.js');
const {stripScrollbackErase,normalizeTerminalLinkUnderline}=require('../../dist-test/terminal-rendering.js');
const {extractAyaOsc}=require('../../dist-electron/osc-extractor.js');
const {parseRendererCheckpoint,MAX_RENDERER_TOTAL_BYTES}=require('../../dist-electron/renderer-vt-checkpoint.js');
const root=path.resolve('tests/fixtures/own-screens'),budget=Math.floor(MAX_RENDERER_TOTAL_BYTES/25);
(async()=>{
 const names=fs.readdirSync(root).filter(n=>n.endsWith('.meta.json')).map(n=>n.slice(0,-10)).sort();
 const mix=[...names,...['claude-idle','claude-offer','codex-idle','codex-skip','grok-busy','grok-idle','hermes-idle','opencode-idle'],'shell-git-log'];
 if(mix.length!==25)throw Error('Expected exactly 25 panes');
 const samples=[];
 for(const name of mix){
  const shell=name==='shell-git-log';
  const meta=shell?{cols:120,rows:40,seconds:null}:JSON.parse(fs.readFileSync(path.join(root,name+'.meta.json')));
  const raw=shell?execFileSync('/usr/bin/git',['--no-pager','log','--no-color','--oneline','-n','500'],{cwd:path.resolve('.')}):fs.readFileSync(path.join(root,name+'.raw'));
  const frames=shell?[{len:raw.length}]:fs.readFileSync(path.join(root,name+'.chunks.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(c=>c.len!==undefined);
  const term=createRendererVt({cols:meta.cols,rows:meta.rows,scrollback:10000,cursorBlink:true,scrollOnEraseInDisplay:true,allowProposedApi:true});
  try{
   let offset=0,carry='';const decoder=new StringDecoder('utf8');
   for(const frame of frames){
    const text=decoder.write(raw.subarray(offset,offset+frame.len));offset+=frame.len;
    const result=extractAyaOsc(text,carry);carry=result.carry;
    const displayed=normalizeTerminalLinkUnderline(stripScrollbackErase(result.cleaned));
    await new Promise(resolve=>term.write(displayed,resolve));
   }
   const start=performance.now(),checkpoint=await captureRendererVt(term,budget,1000),captureMs=performance.now()-start;
   const bytes=Buffer.from(JSON.stringify(checkpoint));parseRendererCheckpoint(bytes,budget);
   samples.push({name,cols:meta.cols,rows:meta.rows,recordedSeconds:meta.seconds,inputBytes:raw.length,normalLines:term.buffer.normal.length,historyLines:term.buffer.normal.baseY,alternateLines:term.buffer.alternate.length,bytes:bytes.length,cutLines:checkpoint.cutLines,retainedNormalLines:term.buffer.normal.length-checkpoint.cutLines,viewportClamped:checkpoint.viewportClamped,captureMs});
  }finally{term.dispose();}
 }
 const result={platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron??null,panes:25,scrollbackLimit:10000,perPaneBudget:budget,totalBudget:MAX_RENDERER_TOTAL_BYTES,totalBytes:samples.reduce((n,s)=>n+s.bytes,0),historyLines:samples.reduce((n,s)=>n+s.historyLines,0),cutLines:samples.reduce((n,s)=>n+s.cutLines,0),scope:'16 recorded startup/idle/busy sessions + 8 named repeats + actual local git log500 shell output, not hours-long history; sequential capture, no DOM/PTY/host',samples};
 fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/renderer-checkpoint-realistic.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
