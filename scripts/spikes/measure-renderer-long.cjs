// Full-history workload from real project source, with ordinary per-token
// colours. Repetition fills the retained history; not a recorded hours-long run.
const fs=require('node:fs');
const {gzipSync}=require('node:zlib');
const {createRendererVt,captureRendererVt,restoreRendererVt}=require('../../dist-test/terminal-vt-checkpoint.js');
const {parseRendererCheckpoint,MAX_RENDERER_TOTAL_BYTES}=require('../../dist-electron/renderer-vt-checkpoint.js');
const budget=Math.floor(MAX_RENDERER_TOTAL_BYTES/25),write=(t,s)=>new Promise(r=>t.write(s,r));
const source=fs.readFileSync('src/components/TerminalView.tsx','utf8').split('\n');
(async()=>{
 const samples=[];
 for(let pane=0;pane<25;pane++){
  const options={cols:120,rows:40,scrollback:10000,allowProposedApi:true,cursorBlink:true,scrollOnEraseInDisplay:true};
  const term=createRendererVt(options);let restored;
  try{
   const lines=Array.from({length:10040},(_,n)=>'\x1b[90m'+String(n+1).padStart(5)+' \x1b[36m'+source[(n+pane*17)%source.length].replaceAll('\t','  ').slice(0,105)+'\x1b[0m\r\n');
   await write(term,lines.join(''));term.scrollToLine(term.buffer.normal.baseY-20);
   let start=performance.now();const full=await captureRendererVt(term,64*1024*1024,30000),fullCaptureMs=performance.now()-start;
   start=performance.now();const capped=await captureRendererVt(term,budget,30000),captureMs=performance.now()-start;
   const fullBytes=Buffer.from(JSON.stringify(full)),data=Buffer.from(JSON.stringify(capped));
   const validated=parseRendererCheckpoint(data,budget);restored=createRendererVt(options);start=performance.now();restoreRendererVt(restored,validated);const restoreMs=performance.now()-start;
   for(let n=0;n<term.rows;n++)if(term.buffer.active.getLine(term.buffer.active.viewportY+n).translateToString()!==restored.buffer.active.getLine(restored.buffer.active.viewportY+n).translateToString())throw Error('Retained viewport differs');
   samples.push({pane,historyLines:term.buffer.normal.baseY,fullBytes:fullBytes.length,fullGzipBytes:gzipSync(fullBytes).length,cappedBytes:data.length,cappedGzipBytes:gzipSync(data).length,cutLines:capped.cutLines,viewportClamped:capped.viewportClamped,fullCaptureMs,captureMs,restoreMs});
  }finally{restored?.dispose();term.dispose();global.gc?.();}
 }
 const sum=key=>samples.reduce((n,s)=>n+s[key],0),result={platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron??null,panes:25,cols:120,rows:40,scrollback:10000,perPaneBudget:budget,totalBudget:MAX_RENDERER_TOTAL_BYTES,scope:'Real project source rows repeated to full retained scrollback, ordinary line-number/source colours; sequential/no DOM/PTY/host',fullBytes:sum('fullBytes'),fullGzipBytes:sum('fullGzipBytes'),cappedBytes:sum('cappedBytes'),cappedGzipBytes:sum('cappedGzipBytes'),historyLines:sum('historyLines'),cutLines:sum('cutLines'),captureMs:sum('captureMs'),restoreMs:sum('restoreMs'),samples};
 fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync(process.argv[2]||'test-results/renderer-long.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
