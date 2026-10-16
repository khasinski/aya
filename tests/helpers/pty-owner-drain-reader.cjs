// Fixed-size input oracle for the adapter abort test. Read in chunks rather
// than one million single-byte syscalls; keep one separate sentinel read.
const fs=require('node:fs'),path=require('node:path');
function readExactly(bytes){
 const data=Buffer.alloc(bytes);let at=0;
 while(at<bytes){
  let count;try{count=fs.readSync(0,data,at,Math.min(65536,bytes-at),null);}catch(error){if(error.code==='EINTR')continue;throw error;}
  if(count===0)throw Error('Input ended before the expected byte count');at+=count;
 }
 return data;
}
fs.writeSync(1,'READY');
function readAfterRelease(){
 if(!fs.existsSync(path.join(process.env.HOME,'input-release'))){setTimeout(readAfterRelease,5);return;}
 const bytes=readExactly(1024*1024);fs.writeFileSync(path.join(process.env.HOME,'input-bytes'),bytes);
 fs.writeSync(1,'DRAINED');const next=readExactly(1);fs.writeSync(1,'NEXT:'+next.toString());process.exit(23);
}
readAfterRelease();
