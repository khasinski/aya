// Host-only inherited capability. Only main creates the persistent file.
import fs from "node:fs";
import net from "node:net";
import {HostAuthError, HOST_AUTH_TIMEOUT_MS} from "./pty-host-auth";

export function readInheritedHostAuthKey(): Promise<Buffer> {
  const marker=process.env.AYA_PTY_AUTH_FD;delete process.env.AYA_PTY_AUTH_FD;
  if(marker!=="5")return Promise.reject(new HostAuthError());
  try {
    const stat=fs.fstatSync(5);
    if(!stat.isFIFO()&&!stat.isSocket()){fs.closeSync(5);throw new HostAuthError();}
  } catch {return Promise.reject(new HostAuthError());}
  return new Promise((resolve,reject)=>{
    // libuv stream reads can be cancelled on timeout. A filesystem stream
    // could leave a blocking pipe read in the worker pool after destroy().
    const stream=new net.Socket({fd:5,readable:true,writable:false});
    const parts:Buffer[]=[];let length=0,settled=false;
    const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);stream.destroy();reject(new HostAuthError());};
    const timer=setTimeout(fail,HOST_AUTH_TIMEOUT_MS);
    stream.on("error",fail);stream.on("close",()=>{if(!settled)fail();});
    stream.on("data",chunk=>{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);length+=bytes.length;if(length>32)fail();else parts.push(bytes);});
    stream.on("end",()=>{
      if(settled)return;
      if(length!==32){fail();return;}
      settled=true;clearTimeout(timer);resolve(Buffer.concat(parts,length));
    });
  });
}
