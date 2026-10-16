// A disposable main that exits normally while its host and pane stay alive.
const path=require('node:path');
const {PtyHostClient}=require('../../dist-electron/pty-host-client.js');
const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
(async()=>{
 const request={ptyId:'continued',agent:'custom',command:`stty -echo; printf 'CONTINUITY_READY\\n'; while IFS= read -r line; do if [ "$line" = quit ]; then exit 23; fi; printf 'R:%s:%s\\n' "$$" "$line"; done`,cwd:process.env.AYA_HOME,cols:80,rows:24};
 await client.spawn(request);
 const deadline=Date.now()+7000;
 while(!(await client.getBuffer('continued')).includes('CONTINUITY_READY')){if(Date.now()>deadline)throw Error('continuity fixture ready timeout');await new Promise(resolve=>setTimeout(resolve,5));}
 await client.spawn({...request,ptyId:'hidden'});
 while(!(await client.getBuffer('hidden')).includes('CONTINUITY_READY')){if(Date.now()>deadline)throw Error('hidden continuity fixture ready timeout');await new Promise(resolve=>setTimeout(resolve,5));}
 const status=await client.hostStatus(),pid=await client.getPid('continued'),hiddenPid=await client.getPid('hidden');
 if(!await client.announceOrdinaryQuit())throw Error('Ordinary continuity announcement failed');
 process.stdout.write(JSON.stringify({request,status,pid,hiddenPid})+'\n');client.dispose();process.exit(0);
})().catch(error=>{console.error(error);client.dispose();process.exit(1);});
