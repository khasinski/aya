// Main streams actual renderer captures into private escrow and retains bounded
// compressed display state until each restored view acknowledges its replay.
import type {IpcMain,WebContents} from "electron";
import {randomBytes} from "node:crypto";
import {writeCheckpoint,readCheckpoint,acknowledgeCheckpoint,type CheckpointReceipt} from "./pty-checkpoint-store";
import {encodeCheckpointPayload,decodeCheckpointPayload,checkpointPayloadSize} from "./pty-checkpoint-payload";
import {parseRendererCheckpoint,MAX_RENDERER_PANE_BYTES,MAX_RENDERER_TOTAL_BYTES} from "./renderer-vt-checkpoint";
import {MAX_CHECKPOINT_BYTES} from "./vt-checkpoint-schema";
import {PTY_HANDOVER_DISPLAY_DIRECTORY} from "./pty-host-paths";
import type {HostHandoverState} from "./pty-host-handover";
import type {HandoverDisplay} from "./types";
interface Pending {sender:number;answer:(json:unknown)=>void}
interface Display {data:Buffer|null;generation:string;offset:number;notice:string|null}
export class HandoverDisplays {
  private pending=new Map<string,Pending>();
  private restored=new Map<string,Display>();
  constructor(private readonly windowForPane:(id:string)=>Promise<WebContents|null>,private readonly log:(event:string,fields:Record<string,unknown>)=>void,private readonly applied?:(id:string,generation:string,token?:string)=>Promise<boolean>){}
  register(ipc:Pick<IpcMain,"handle"|"on">):void {
    ipc.on("pty-checkpoint:captured",(event,id:unknown,json:unknown)=>{
      if(typeof id!=='string')return;const p=this.pending.get(id);if(p?.sender===event.sender.id)p.answer(json);
    });
    ipc.handle("pty-checkpoint:display",(_event,id:unknown):HandoverDisplay|null=>{
      if(typeof id!=='string')throw new Error("Invalid terminal display identity");const p=this.restored.get(id);if(!p)return null;
      return {json:p.data?decodeCheckpointPayload(p.data).toString('utf8'):null,generation:p.generation,offset:p.offset,notice:p.notice};
    });
    ipc.handle("pty-checkpoint:display-ack",async(_event,id:unknown,generation:unknown,token?:unknown)=>{
      if(typeof id!=='string'||typeof generation!=='string'||(token!==undefined&&typeof token!=='string'))throw new Error("Invalid display acknowledgement");
      if(this.restored.get(id)?.generation===generation&&(!this.applied||await this.applied(id,generation,token as string|undefined)))this.restored.delete(id);
    });
  }
  private async ask(id:string,budget:number,deadline:number):Promise<string|null> {
    const win=await this.windowForPane(id);
    if(!win||win.isDestroyed()||Date.now()>=deadline)return null;
    const requestId=randomBytes(16).toString('hex');
    return new Promise(resolve=>{
      const timer=setTimeout(()=>finish(null),Math.max(1,Math.min(500,deadline-Date.now())));
      const finish=(json:unknown)=>{clearTimeout(timer);this.pending.delete(requestId);resolve(typeof json==='string'&&Buffer.byteLength(json)<=budget?json:null);};
      this.pending.set(requestId,{sender:win.id,answer:finish});
      try{win.send("pty-checkpoint:capture",{requestId,ptyId:id,maxBytes:budget});}catch{finish(null);}
    });
  }
  async capture(state:HostHandoverState):Promise<CheckpointReceipt> {
    const deadline=Math.min(state.deadline,Date.now()+5000);
    const allowance=Math.min(MAX_RENDERER_TOTAL_BYTES,MAX_CHECKPOINT_BYTES-state.coreRawBytes,MAX_CHECKPOINT_BYTES-state.coreEncodedBytes);
    const budget=Math.min(MAX_RENDERER_PANE_BYTES,Math.floor(allowance/Math.max(1,state.eligible.length)));
    const self=this;let raw=0,encoded=0;
    async function* parts(){
      for(const pane of state.eligible){
        if(budget<65536||Date.now()>=deadline)break;
        const json=await self.ask(pane.id,budget,deadline);if(json===null)continue;
        const bytes=Buffer.from(json);let data:Buffer;
        try{parseRendererCheckpoint(bytes,budget);data=encodeCheckpointPayload(bytes);}catch{continue;}
        if(bytes.length>allowance-raw||data.length>allowance-encoded)continue;
        raw+=bytes.length;encoded+=data.length;
        yield{id:pane.id,generation:pane.generation,data};
      }
    }
    return writeCheckpoint(PTY_HANDOVER_DISPLAY_DIRECTORY,parts());
  }
  async inspect(state:HostHandoverState):Promise<void> {
    const captured=new Map<string,Buffer>();let raw=0,encoded=0;
    if(state.display){
      for await(const part of readCheckpoint(PTY_HANDOVER_DISPLAY_DIRECTORY,state.display)){
        if(!state.eligible.some(p=>p.id===part.id&&p.generation===part.generation))throw new Error("Renderer checkpoint pane identity refused");
        raw+=checkpointPayloadSize(part.data);encoded+=part.data.length;
        if(raw>MAX_RENDERER_TOTAL_BYTES||encoded>MAX_RENDERER_TOTAL_BYTES||raw>MAX_CHECKPOINT_BYTES-state.coreRawBytes||encoded>MAX_CHECKPOINT_BYTES-state.coreEncodedBytes)throw new Error("Renderer checkpoint aggregate-byte limit");
      }
      if(raw!==state.displayRawBytes||encoded!==state.displayEncodedBytes)throw new Error("Renderer checkpoint receipt accounting differs");
      // Only after every header passes may the first compressed part expand.
      for await(const part of readCheckpoint(PTY_HANDOVER_DISPLAY_DIRECTORY,state.display))captured.set(part.id,part.data);
    }
    const next=new Map<string,Display>();
    for(const pane of state.eligible){
      let data=captured.get(pane.id)??null,notice:string|null=null;
      if(data){
        try{const dto=parseRendererCheckpoint(decodeCheckpointPayload(data));if(dto.cutLines){notice=`${dto.cutLines} oldest history lines were cut during the update.`;this.log("handover-history-cut",{ptyId:pane.id,lines:dto.cutLines});}}
        catch{data=null;}
      }
      if(!data){notice="History from replay after the update; the process kept running.";this.log("handover-history-from-replay",{ptyId:pane.id,reason:"renderer state unavailable"});}
      next.set(pane.id,{data,generation:pane.generation,offset:data?pane.outputEnd:0,notice});
    }
    this.restored=next;
  }
  async acknowledgeEscrow(receipt:CheckpointReceipt|null):Promise<void> {
    if(receipt)await acknowledgeCheckpoint(PTY_HANDOVER_DISPLAY_DIRECTORY,receipt);
  }
  clear():void {this.restored.clear();}
  forget(id:string):void {this.restored.delete(id);}
  has(id:string):boolean {return this.restored.has(id);}
}
