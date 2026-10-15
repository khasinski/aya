// Actual transformed renderer terminals, never a second display mirror in host.
import type {Terminal} from "@xterm/xterm";
import {captureRendererVt} from "./terminal-vt-checkpoint";
const terminals=new Map<string,{term:Terminal;ready:()=>boolean}>();let listening=false;
export function registerCheckpointTerminal(id:string,terminal:Terminal,ready:()=>boolean=()=>true):()=>void {
  const entry={term:terminal,ready};terminals.set(id,entry);
  if(!listening&&typeof window.aya.onHandoverCapture==='function'){
    listening=true;
    window.aya.onHandoverCapture(async request=>{
      const entry=terminals.get(request.ptyId);if(!entry||!entry.ready())return null;const term=entry.term;
      try{return JSON.stringify(await captureRendererVt(term,request.maxBytes,250));}catch{return null;}
    });
  }
  return ()=>{if(terminals.get(id)===entry)terminals.delete(id);};
}
