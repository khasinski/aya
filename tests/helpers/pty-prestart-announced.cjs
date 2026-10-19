// A distinct fixture main starts an empty host, announces its ordinary quit
// through the real product path, then exits before the real Electron main.
const {PtyHostClient}=require('../../dist-electron/pty-host-client.js');
(async()=>{const client=new PtyHostClient(process.env.AYA_TEST_HOST_SCRIPT);try{const status=await client.hostStatus();if(!status.pid||!await client.announceOrdinaryQuit())throw Error('Fixture announced prestart failed');}finally{client.dispose();client.dropSocket();}})().catch(error=>{console.error(error);process.exitCode=1;});
