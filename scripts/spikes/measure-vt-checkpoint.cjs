// Offline B3 representation measurement; no PTY, host or network is started.
const fs=require('node:fs'),path=require('node:path'),{StringDecoder}=require('node:string_decoder'),{gzipSync}=require('node:zlib');
const {CompactVt,ENGINE,capture}=require('./vt-checkpoint.cjs');
const time=()=>Number(process.hrtime.bigint())/1e6;
const percentile=(items,p)=>[...items].sort((a,b)=>a-b)[Math.min(items.length-1,Math.ceil(items.length*p)-1)];
function dense(cols,rows,offset){
 let text='\x1b[2J\x1b[H';
 for(let y=0;y<rows;y++){text+=`\x1b[${y+1};1H`;for(let x=0;x<cols;x++){const n=offset+y*cols+x; text+=`\x1b[38;2;${n%256};${(n*17)%256};${(n*37)%256}m\x1b[48;2;${(n*7)%256};${(n*11)%256};${(n*23)%256}m${String.fromCharCode(33+n%90)}`;}}
 return text;
}
(async()=>{
 const panes=[],snapshots=[],wire=[],captureMs=[],restoreMs=[];const baseMemory=process.memoryUsage();
 let fullJournalBytes=0;
 try{
  for(let i=0;i<25;i++){
   const p=new CompactVt({cols:240,rows:80,scrollback:0},{generation:`pane-${i}`,composerSeen:true,osc9001Carry:''});panes.push(p);
   const normal=dense(240,80,i),alt='\x1b[?1049h'+dense(240,80,i+1000);fullJournalBytes+=Buffer.byteLength(normal)+Buffer.byteLength(alt);
   await p.write(normal);await p.write(alt);
   const start=time(),bytes=capture(p.term,p.metadata);captureMs.push(time()-start);snapshots.push(bytes);
  }
  const checkpointMemory=process.memoryUsage();
  for(const p of panes){const checkpoint=p.checkpoint();wire.push(Buffer.from(JSON.stringify(checkpoint)));const start=time(),restored=await CompactVt.import(checkpoint);restoreMs.push(time()-start);if(!capture(restored.term,p.metadata).equals(capture(p.term,p.metadata)))throw Error('Dense round trip differs');restored.term.dispose();}
  const denseResult={panes:25,cols:240,rows:80,scrollback:0,buffers:'both full, alternate active, every cell independently true-colour FG/BG',snapshotBytes:snapshots.reduce((n,b)=>n+b.length,0),gzipBytes:snapshots.reduce((n,b)=>n+gzipSync(b).length,0),transportBytes:wire.reduce((n,b)=>n+b.length,0),transportGzipBytes:wire.reduce((n,b)=>n+gzipSync(b).length,0),referenceJournalInputBytes:fullJournalBytes,captureP50Ms:percentile(captureMs,.5),captureP95Ms:percentile(captureMs,.95),restoreP50Ms:percentile(restoreMs,.5),restoreP95Ms:percentile(restoreMs,.95),restoreTotalMs:restoreMs.reduce((a,b)=>a+b,0),baseMemory,checkpointMemory};
  for(const pane of panes)pane.term.dispose();panes.length=0;
  const sessions=[];
  for(const name of ['grok-busy','grok-idle','opencode-idle','claude-offer','codex-skip']){
   const root=path.resolve('tests/fixtures/own-screens'),meta=JSON.parse(fs.readFileSync(path.join(root,name+'.meta.json'))),raw=fs.readFileSync(path.join(root,name+'.raw')),decoder=new StringDecoder('utf8');
   const frames=fs.readFileSync(path.join(root,name+'.chunks.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(c=>c.len!==undefined),p=new CompactVt({cols:meta.cols,rows:meta.rows,scrollback:0}),samples=[];
   let offset=0,captureWorkMs=0,maxBaseBytes=p.base.length;
   for(const f of frames){const start=time();await p.write(decoder.write(raw.subarray(offset,offset+f.len)));captureWorkMs+=time()-start;offset+=f.len;maxBaseBytes=Math.max(maxBaseBytes,p.base.length);samples.push({t:f.t,consumedBytes:offset,tailBytes:p.tailBytes,snapshotBytes:p.base.length,eligible:!p.overflow});}
   sessions.push({name,recordedSeconds:meta.seconds,cols:meta.cols,rows:meta.rows,reads:frames.length,rawBytes:raw.length,maxBaseBytes,maxTailBytes:p.maxTailBytes,finalTailBytes:p.tailBytes,parseAndCompactMs:captureWorkMs,samples});p.term.dispose();
  }
  const result={engine:ENGINE,node:process.versions.node,electron:process.versions.electron??null,platform:process.platform,arch:process.arch,dense:denseResult,sessions};
  fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync(process.argv[2]||'test-results/vt-checkpoint-measurement.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,sessions:sessions.map(({samples,...rest})=>rest)},null,2));
 }finally{for(const p of panes)p.term.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
