// Explicit test-main launches use the same inherited authentication pipe as
// product main. The host never creates/reads a capability file itself.
const {spawn}=require('node:child_process');
const {createHostAuthKey,readHostAuthKey}=require('../../dist-electron/pty-host-auth-key.js');
const {authenticateHostSocket}=require('../../dist-electron/pty-host-auth-transport.js');
const {ownerProcessStartIdentity}=require('../../dist-electron/pty-owner-client.js');
function spawnAuthenticatedHost(executable,args,options){
 const home=options?.env?.AYA_HOME;if(typeof home!=='string'||!home)throw Error('Fixture host requires an explicit disposable AYA_HOME');
 const key=createHostAuthKey(home),requested=options.stdio??'pipe';
 const stdio=Array.isArray(requested)?[...requested]:[requested,requested,requested];
 if(stdio[5]!==undefined)throw Error('Fixture authentication descriptor is already reserved');
 while(stdio.length<5)stdio.push('ignore');stdio[5]='pipe';
 const child=spawn(executable,args,{...options,stdio,env:{...options.env,AYA_PTY_AUTH_FD:'5'}});
 const pipe=child.stdio[5];pipe.on('error',()=>{});pipe.end(key,()=>key.fill(0));return child;
}
async function authenticateFixtureSocket(socket,home){
 const key=readHostAuthKey(home),startIdentity=ownerProcessStartIdentity(process.pid);
 try{
  if(!startIdentity)throw Error('Fixture main process identity is unavailable');
  return await authenticateHostSocket(socket,key,{pid:process.pid,startIdentity});
 }finally{key.fill(0);}
}
module.exports={spawnAuthenticatedHost,authenticateFixtureSocket};
