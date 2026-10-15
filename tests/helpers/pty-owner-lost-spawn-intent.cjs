const fs=require('node:fs'), path=require('node:path');
const {getOwnerRuntime}=require('../../dist-electron/pty-owner-runtime.js');
const {OwnerPty}=require('../../dist-electron/pty-owner-adapter.js');
(async()=>{
 const owner=await getOwnerRuntime(), spawn=owner.client.spawn.bind(owner.client);
 owner.client.spawn=async spec=>{
  const pane=await spawn(spec); let data='';
  const fd=owner.client.takeMaster(pane.fd), buffer=Buffer.alloc(4096);
  while(!data.includes('READY')) { try { data+=buffer.subarray(0,fs.readSync(fd,buffer,0,buffer.length,null)).toString(); } catch(e) { if(e.code!=='EAGAIN') throw e; } await new Promise(r=>setTimeout(r,5)); }
  fs.writeFileSync(path.join(process.env.AYA_HOME,'forked.json'),JSON.stringify({pid:owner.record.pid,pane}));
  process.kill(process.pid,'SIGKILL');
 };
 await OwnerPty.spawn({id:'intent',command:process.execPath,argv:[process.execPath,'-e',"process.on('SIGHUP',()=>{}); console.log('READY'); setInterval(()=>{},1000)"],cwd:process.env.AYA_HOME,cols:80,rows:24,env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin'}});
})().catch(e=>{console.error(e); process.exitCode=1;});
