// Failure-only, read-only evidence for disposable fixtures. Never read a
// capability, handover ticket or file payload beyond these allowlisted records.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
function errorText(error){return String(error?.stack??error);}
function readRecord(file,limit){
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>limit)throw Error('record type/size refused');
  const bytes=Buffer.alloc(limit+1);let used=0;while(used<bytes.length){const count=fs.readSync(fd,bytes,used,bytes.length-used,used);if(!count)break;used+=count;}if(used>limit)throw Error('record grew beyond limit');
  const value=JSON.parse(bytes.subarray(0,used).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('not a record');return value;
 }catch(error){return {readError:`${error?.name??'Error'}:${error?.code??'unreadable or invalid record'}`};}finally{if(fd!==undefined)fs.closeSync(fd);}
}
// Records may be stale or PIDs reused: report executable name, never argv.
function processSnapshot(known){
 const identities=[],pids=[...new Set(known.map(item=>item.pid).filter(pid=>Number.isSafeInteger(pid)&&pid>1))].slice(0,32);
 let identity;
 try{identity=require('../../dist-electron/pty-owner-client.js').ownerProcessStartIdentity;}catch{/* Report unavailable below. */}
 for(const pid of pids){try{identities.push({pid,kernelStartIdentity:identity?identity(pid):'probe unavailable'});}catch(error){identities.push({pid,probeError:errorText(error)});}}
 let ps;
 try{ps=cp.execFileSync('ps',['-p',pids.join(','),'-o','pid=,ppid=,pgid=,stat=,lstart=,comm='],{encoding:'utf8',timeout:1000,maxBuffer:65536,env:{...process.env,LC_ALL:'C',TZ:'UTC'}});}
 catch(error){ps={error:errorText(error),stdout:String(error.stdout??'').slice(0,65536)};}
 return {known,identities,ps};
}
function remainingFiles(directory){
 const entries=[];
 const visit=(dir,depth)=>{
  if(depth>3||entries.length>=128)return;
  let names;try{names=fs.readdirSync(dir).sort();}catch(error){entries.push({path:path.relative(directory,dir),error:errorText(error)});return;}
  for(const name of names){if(entries.length>=128)break;const file=path.join(dir,name);try{const s=fs.lstatSync(file);entries.push({path:path.relative(directory,file),type:s.isDirectory()?'directory':s.isFile()?'file':s.isSymbolicLink()?'link':'other',dev:s.dev,ino:s.ino,mode:s.mode&0o7777,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs});if(s.isDirectory())visit(file,depth+1);}catch(error){entries.push({path:path.relative(directory,file),error:errorText(error)});}}
 };
 visit(directory,0);return entries;
}
function emit(label,make){try{console.error(label+' '+JSON.stringify({at:new Date().toISOString(),monotonicMs:performance.now(),...make()}));}catch(error){console.error(label+' diagnostic failed: '+errorText(error));}}
function cleanupFailure(home,known,error){emit('PTY_FIXTURE_CLEANUP_FAILURE',()=>{
 let openFiles;const pids=[...new Set(known.map(p=>p.pid).filter(p=>Number.isSafeInteger(p)&&p>1))].slice(0,32);
 try{openFiles=cp.execFileSync('lsof',['-nP',...(pids.length?['-p',pids.join(',')]:[]),'+D',home],{encoding:'utf8',timeout:1000,maxBuffer:65536});}catch(e){openFiles={error:errorText(e),stdout:String(e.stdout??'').slice(0,65536)};}
 return {error:errorText(error),home,remaining:remainingFiles(home),processes:processSnapshot(known),openFiles};
});}
function creationFailure(home,proof,error){emit('PTY_FIXTURE_CREATION_REFUSAL',()=>{
 const directory=path.join(home,'pty-hosts'),records=[];let names=[];
 try{names=fs.readdirSync(directory).sort().slice(0,128);}catch(e){records.push({readError:errorText(e)});}
 for(const name of names){const file=path.join(directory,name);let stat;try{const s=fs.lstatSync(file);stat={ino:s.ino,dev:s.dev,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,mode:s.mode&0o7777};}catch(e){stat={error:errorText(e)};}
  const r=readRecord(file,4096);records.push({file:name,stat,pid:r.pid,pgid:r.pgid,startTime:r.startTime,version:r.version,scriptHash:r.scriptHash,authProtocol:r.authProtocol,readError:r.readError});}
 const r=readRecord(path.join(home,'pty-owner/record.json'),65536),owner={pid:r.pid,startTime:r.startTime,startIdentity:r.startIdentity,instanceId:r.instanceId,jsPid:r.jsPid,jsStartTime:r.jsStartTime,readError:r.readError};
 const known=[...(proof?.hosts??[]),...records.map(r=>({pid:r.pid,startTime:r.startTime})),{pid:owner.pid,startIdentity:owner.startIdentity,startTime:owner.startTime},{pid:owner.jsPid,startTime:owner.jsStartTime}];
 return {error:errorText(error),home,refusalProof:proof,records,owner,processes:processSnapshot(known)};
});}
module.exports={cleanupFailure,creationFailure};
