// Offline retained-state measurement. Populate BufferLines directly after one
// real parsed true-colour row: this measures capture/restore, not parser or DOM.
const fs=require('node:fs');
const {Terminal}=require('@xterm/xterm');
const {createRendererVt,captureRendererVt,restoreRendererVt}=require('../../dist-test/terminal-vt-checkpoint.js');
const {parseRendererCheckpoint,MAX_RENDERER_TOTAL_BYTES}=require('../../dist-electron/renderer-vt-checkpoint.js');
const now=()=>performance.now();
const write=(t,s)=>new Promise(resolve=>t.write(s,resolve));
const create=()=>createRendererVt({cols:240,rows:80,scrollback:10000,allowProposedApi:true,cursorBlink:true,scrollOnEraseInDisplay:true});
(async()=>{
 const samples=[],baseline=process.memoryUsage(),budget=Math.floor(MAX_RENDERER_TOTAL_BYTES/25);let peakRss=baseline.rss;
 for(let i=0;i<25;i++){
  const t=create(),b=t._core._bufferService.buffers.normal;
  let row='';for(let x=0;x<240;x++)row+=`\x1b[38;2;${x};${(x*17)%256};${(x*37)%256}m\x1b[48;2;${(x*7)%256};${(x*11)%256};${(x*23)%256}m${String.fromCharCode(33+x%90)}`;
  await write(t,row);const template=b.lines.get(0);
  b.lines.maxLength=10080;b.lines.length=0;
  for(let n=0;n<10080;n++){const line=template.clone();line._data[0]=(line._data[0]&~0x1fffff)|(33+(i+n)%90);b.lines.push(line);}
  b.ybase=10000;b.ydisp=9950;b.y=79;b.x=0;t._core._bufferService.isUserScrolling=true;
  let start=now();const full=await captureRendererVt(t,64*1024*1024,30000),fullCaptureMs=now()-start;
  const fullBytes=Buffer.byteLength(JSON.stringify(full));
  start=now();const capped=await captureRendererVt(t,budget,30000),captureMs=now()-start;
  const bytes=Buffer.from(JSON.stringify(capped));start=now();const valid=parseRendererCheckpoint(bytes,budget),validateMs=now()-start;
  const restored=create();start=now();restoreRendererVt(restored,valid);const restoreMs=now()-start;
  if(t.buffer.active.getLine(t.buffer.active.viewportY).translateToString()!==restored.buffer.active.getLine(restored.buffer.active.viewportY).translateToString())throw Error('Viewport differs');
  peakRss=Math.max(peakRss,process.memoryUsage().rss);
  samples.push({pane:i,fullBytes,fullCaptureMs,bytes:bytes.length,cutLines:capped.cutLines,viewportClamped:capped.viewportClamped,captureMs,validateMs,restoreMs});
  restored.dispose();t.dispose();global.gc?.();
 }
 const result={platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron??null,panes:25,cols:240,rows:80,scrollback:10000,workload:'Direct dense retained BufferLine population; one pane at a time; no DOM/PTY/host; not simultaneous 25-pane peak memory',perPaneBudget:budget,totalBudget:MAX_RENDERER_TOTAL_BYTES,fullBytes:samples.reduce((n,s)=>n+s.fullBytes,0),cappedBytes:samples.reduce((n,s)=>n+s.bytes,0),captureTotalMs:samples.reduce((n,s)=>n+s.captureMs,0),restoreTotalMs:samples.reduce((n,s)=>n+s.restoreMs,0),baseline,peakSampledRss:peakRss,samples};
 fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/renderer-checkpoint-measurement.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
