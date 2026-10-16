// Explicit fixture-main authority, held only in this test process. Product
// clients never consult this map; each positive fixture opts in to its copy.
const {spawn}=require('node:child_process');
const {newHostAuthCapability}=require('../../dist-electron/pty-host-auth-transfer.js');
const {authenticateHostSocket}=require('../../dist-electron/pty-host-auth-transport.js');
const {ownerProcessStartIdentity}=require('../../dist-electron/pty-owner-client.js');
const fixtureKeys=new Map();
function remember(home,key){const old=fixtureKeys.get(home);old?.fill(0);fixtureKeys.set(home,Buffer.from(key));}
function fixtureHostAuthKey(home=process.env.AYA_HOME){const key=fixtureKeys.get(home);if(!key)throw Error('Fixture must explicitly supply its in-memory authority');return Buffer.from(key);}
function authorizeFixtureClient(client,home=process.env.AYA_HOME){client.hostAuthKey=fixtureHostAuthKey(home);return client;}
function spawnAuthenticatedHost(executable,args,options){
 const home=options?.env?.AYA_HOME;if(typeof home!=='string'||!home)throw Error('Fixture host requires an explicit disposable AYA_HOME');
 const key=newHostAuthCapability();remember(home,key);const requested=options.stdio??'pipe';
 const stdio=Array.isArray(requested)?[...requested]:[requested,requested,requested];
 if(stdio[5]!==undefined)throw Error('Fixture authentication descriptor is already reserved');
 while(stdio.length<5)stdio.push('ignore');stdio[5]='pipe';
 const child=spawn(executable,args,{...options,stdio,env:{...options.env,AYA_PTY_AUTH_FD:'5'}});
 const pipe=child.stdio[5];pipe.on('error',()=>{});pipe.end(key,()=>key.fill(0));return child;
}
async function authenticateFixtureSocket(socket,home,key=fixtureHostAuthKey(home)){
 const copy=Buffer.from(key),startIdentity=ownerProcessStartIdentity(process.pid);
 try{if(!startIdentity)throw Error('Fixture main process identity is unavailable');return await authenticateHostSocket(socket,copy,{pid:process.pid,startIdentity});}
 finally{copy.fill(0);}
}
// A product-launched stand-in consumes the actual inherited FD5. A parent
// stand-in creates test-owned memory authority that callers explicitly borrow.
function authenticatedFixtureServer(handler,home=process.env.AYA_HOME){
 const net=require('node:net'),{HostSocketAuthenticator}=require('../../dist-electron/pty-host-auth-transport.js');
 const keyPromise=process.env.AYA_PTY_AUTH_FD
  ?require('../../dist-electron/pty-host-auth-bootstrap.js').readInheritedHostAuthKey()
  :(()=>{const key=newHostAuthCapability();remember(home,key);return Promise.resolve(key);})();
 const ready=keyPromise.then(key=>{try{return new HostSocketAuthenticator(key,{pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)},()=>{});}finally{key.fill(0);}});ready.catch(()=>{});
 return net.createServer(socket=>{void ready.then(auth=>auth.accept(socket)).then(({buffered})=>{handler(socket);if(buffered)socket.emit('data',buffered);socket.resume();}).catch(()=>socket.destroy());});
}
module.exports={spawnAuthenticatedHost,authenticateFixtureSocket,authenticatedFixtureServer,fixtureHostAuthKey,authorizeFixtureClient};
// Teardown of an already-closed fixture app may redeem that app's real one-use
// quit ticket. It never reads an old disk key or creates a host/owner/window.
async function redeemFixtureQuit(home){
 const {findAuthTransferTicket}=require('../../dist-electron/pty-host-auth-ticket.js');
 const ticket=await findAuthTransferTicket(home);if(!ticket)return;
 const net=require('node:net'),{once}=require('node:events'),path=require('node:path');
 const socket=net.createConnection(path.join(home,'pty-host.sock'));socket.on('error',()=>{});
 try{await once(socket,'connect');const {redeemHostCapability}=require('../../dist-electron/pty-host-auth-redemption.js');
  const key=await redeemHostCapability(socket,ticket,{pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)});
  try{remember(home,key);}finally{key.fill(0);}
 }finally{socket.destroy();}
}
function forgetFixtureAuthority(home){const key=fixtureKeys.get(home);key?.fill(0);fixtureKeys.delete(home);}
module.exports.redeemFixtureQuit=redeemFixtureQuit;
module.exports.forgetFixtureAuthority=forgetFixtureAuthority;
