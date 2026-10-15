// Transient row-coverage tracker for the engine-pinned headless mirror. It
// observes parsed print/erase operations, never searches raw OSC/DCS payloads.
import type {Terminal} from "@xterm/headless";
export const RECOVERY_SCREEN_SETTLE_MS=250;
export const RECOVERY_SCREEN_TIMEOUT_MS=10_000;
interface Disposable {dispose():void}
export class RecoveryScreen {
 private covered=new Set<number>();
 private reset=false;
 private pendingRis=false;
 private done=false;
 private quiet:ReturnType<typeof setTimeout>|undefined;
 private deadline:ReturnType<typeof setTimeout>|undefined;
 private listeners:Disposable[]=[];
 private readonly input:any;
 private readonly originalPrint:any;
 private readonly print:any;
 private scrollEpoch=0;
 private dirty=false;
 constructor(private terminal:Terminal,private status:(known:boolean,timedOut:boolean)=>void,
  private settleMs=RECOVERY_SCREEN_SETTLE_MS,timeoutMs=RECOVERY_SCREEN_TIMEOUT_MS){
  const core=(terminal as any)._core;this.input=core?._inputHandler;
  if(typeof this.input?.print!=='function'||typeof core?._bufferService?.buffers?.onBufferActivate!=='function')throw Error('This engine cannot prove recovered screen coverage');
  this.originalPrint=this.input.print;
  const self=this;
  this.print=function(data:Uint32Array,start:number,end:number){
   const buffer=core._bufferService.buffer,y=buffer.y,epoch=self.scrollEpoch;
   const result=self.originalPrint.call(this,data,start,end);
   if(end>start&&!self.done){
    const after=core._bufferService.buffer;
    if(after===buffer&&self.scrollEpoch===epoch&&after.y>=y){for(let row=y;row<=after.y;row++)self.cover(row);}
    else self.cover(after.y);
   }
   return result;
  };
  this.input.print=this.print;
  const csi=(id:{final:string},fn:(params:any)=>void)=>this.listeners.push(terminal.parser.registerCsiHandler(id,p=>{fn(p);return false;}));
  csi({final:'K'},()=>this.cover(core._bufferService.buffer.y));
  csi({final:'J'},p=>{this.dirty=true;const mode=p[0]??0,y=core._bufferService.buffer.y;if(mode===2){this.reset=true;return;}if(mode===0||mode===1)for(let r=mode===1?0:y;r<=(mode===1?y:terminal.rows-1);r++)this.cover(r);});
  this.listeners.push(terminal.parser.registerEscHandler({final:'c'},()=>{this.pendingRis=true;this.dirty=true;return false;}));
  this.listeners.push(terminal.onResize(()=>this.invalidate()));
  this.listeners.push(terminal.onScroll(()=>{this.scrollEpoch++;if(!this.reset)this.invalidate();}));
  this.listeners.push(core._bufferService.buffers.onBufferActivate(()=>this.invalidate()));
  this.listeners.push(terminal.onWriteParsed(()=>this.applied()));
  this.deadline=setTimeout(()=>{this.deadline=undefined;if(!this.done)this.status(false,true);},timeoutMs);
 }
 noteOutput():void {this.dirty=true;}
 private cover(row:number):void {this.dirty=true;if(row>=0&&row<this.terminal.rows)this.covered.add(row);}
 private invalidate():void {this.covered.clear();this.reset=false;clearTimeout(this.quiet);}
 private applied():void {
  if(!this.dirty)return;this.dirty=false;
  if(this.pendingRis){this.reset=true;this.pendingRis=false;}
  clearTimeout(this.quiet);
  if(this.done||(!this.reset&&this.covered.size!==this.terminal.rows))return;
  this.quiet=setTimeout(()=>{if(this.done)return;this.dispose();this.status(true,false);},this.settleMs);
 }
 dispose():void {
  if(this.done)return;this.done=true;clearTimeout(this.quiet);clearTimeout(this.deadline);
  if(this.input.print===this.print)this.input.print=this.originalPrint;
  for(const listener of this.listeners)listener.dispose();this.listeners=[];
 }
}
