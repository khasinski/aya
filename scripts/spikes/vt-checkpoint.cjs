// VT-only B3 proof. No host cutover or product path uses this prototype.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { Terminal } = require('@xterm/headless');
const ENGINE = createHash('sha256').update(fs.readFileSync(require.resolve('@xterm/headless'))).digest('hex');
const SUPPORTED_ENGINE = '17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed';
const MAX_SNAPSHOT = 64 * 1024 * 1024, MAX_TAIL = 256 * 1024;
const palettes = new WeakMap();
function trackPalette(term, saved={}) {
 const palette = new Map(Object.entries(saved));palettes.set(term,palette);
 term._core._inputHandler.onColor(events=>{for(const event of events){if(event.type===1)palette.set(String(event.index),copy(event.color));else if(event.type===2){if(event.index===undefined)palette.clear();else palette.delete(String(event.index));}}});
}
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const pick = (object, fields) => Object.fromEntries(fields.filter(key => object[key] !== undefined).map(key => [key, copy(object[key])]));
const B = ['ydisp','ybase','y','x','scrollBottom','scrollTop','tabs','savedY','savedX','savedCharset','_cols','_rows','_hasScrollback'];
const H = ['_windowTitle','_iconName','_windowTitleStack','_iconNameStack','_specialColors'];
const C = ['isCursorInitialized','isCursorHidden','modes','decPrivateModes'];
const M = ['_activeProtocol','_activeEncoding','_lastEvent','_wheelPartialScroll'];
const raw = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
function handlerShape(term) {
 const c=term._core,p=c._inputHandler._parser;
 const shapes=[p._csiHandlers,p._escHandlers,p._oscParser._handlers,p._dcsParser._handlers].map(handlers=>Object.entries(handlers).map(([key,entries])=>[key,entries.length]).sort(([a],[b])=>a.localeCompare(b)));
 return JSON.stringify([shapes,Object.keys(c.unicodeService._providers).sort()]);
}
const probe=new Terminal({allowProposedApi:true}),HANDLERS=handlerShape(probe);probe.dispose();
function ground(term) { const h=term._core._inputHandler; return h._parser.currentState===0 && !h._parseStack.paused; }
function attrs(value) { return { fg:value.fg,bg:value.bg,extended:pick(value.extended,['_ext','_urlId']) }; }
function restoreAttrs(target,value) { target.fg=value.fg;target.bg=value.bg;Object.assign(target.extended,value.extended); }
function bufferState(buffer) {
 return { state:pick(buffer,B),saved:attrs(buffer.savedCurAttrData),lines:Array.from({length:buffer.lines.length},(_,n)=>{
  const line=buffer.lines.get(n);
  return {length:line.length,isWrapped:line.isWrapped,data:raw(line._data.subarray(0,line.length*3)),combined:copy(line._combined),extended:Object.fromEntries(Object.entries(line._extendedAttrs).filter(([,v])=>v).map(([k,v])=>[k,pick(v,['_ext','_urlId'])]))};
 }) };
}
function capture(term,metadata={}) {
 if(ENGINE!==SUPPORTED_ENGINE)throw Error('Unsupported VT engine implementation');
 if(handlerShape(term)!==HANDLERS)throw Error('Custom parser/Unicode handlers are not eligible');
 if(!ground(term))throw Error('VT parser is not in ground state');
 const c=term._core,h=c._inputHandler,p=h._parser,bs=c._bufferService,buffers=bs.buffers;
 if(c._writeBuffer._pendingData)throw Error('VT writes have not drained');
 if(h._parser._parseStack.state)throw Error('Asynchronous parser continuation is unsupported');
 if(c.optionsService.rawOptions.logger || c.optionsService.rawOptions.linkHandler)throw Error('Custom handlers are not eligible');
 const seen=new Set(), links=[];
 for(const entry of c._oscLinkService._dataByLinkId.values()) {
  const lines=entry.lines.map(marker=>{
   const buffer=buffers.normal.markers.includes(marker)?'normal':buffers.alt.markers.includes(marker)?'alternate':null;
   if(!buffer||marker.isDisposed)throw Error('Unowned OSC link marker');seen.add(marker);return {buffer,line:marker.line};
  });links.push({id:entry.id,key:entry.key,data:copy(entry.data),lines});
 }
 if([...buffers.normal.markers,...buffers.alt.markers].some(marker=>!seen.has(marker)))throw Error('External markers are not eligible');
 const dto={format:1,engine:ENGINE,options:copy(c.optionsService.rawOptions),metadata:copy(metadata),
  cols:term.cols,rows:term.rows,normal:bufferState(buffers.normal),alternate:bufferState(buffers.alt),active:buffers.active===buffers.alt?'alternate':'normal',
  userScrolling:bs.isUserScrolling,core:pick(c.coreService,C),mouse:pick(c.coreMouseService,M),charset:pick(c._charsetService,['charset','glevel','_charsets']),
  input:pick(h,H),current:attrs(h._curAttrData),erase:attrs(h._eraseAttrDataInternal),
  parser:{initialState:p.initialState,currentState:p.currentState,precedingJoinState:p.precedingJoinState,collect:p._collect,
   params:{...pick(p._params,['maxLength','maxSubParamsLength','length','_subParamsLength','_rejectDigits','_rejectSubDigits','_digitIsSub']),params:raw(p._params.params),sub:raw(p._params._subParams),indices:raw(p._params._subParamsIdx)}},
  stringInterim:h._stringDecoder._interim,utf8Interim:raw(h._utf8Decoder.interim),unicode:c.unicodeService.activeVersion,
  palette:Object.fromEntries(palettes.get(term)??[]),links:{nextId:c._oscLinkService._nextId,entries:links}};
 const bytes=Buffer.from(JSON.stringify(dto));if(bytes.length>MAX_SNAPSHOT)throw Error('VT snapshot size limit');return bytes;
}
function restoreBuffer(buffer,snapshot,extendedPrototype) {
 const Line=buffer.getBlankLine(buffer.savedCurAttrData).constructor;
 buffer.lines.length=0;
 for(const saved of snapshot.lines) {
  if(saved.length>1000||Buffer.from(saved.data,'base64').length!==saved.length*12)throw Error('Invalid VT line');
  const line=new Line(saved.length);const bytes=Buffer.from(saved.data,'base64');
  for(let n=0;n<saved.length*3;n++)line._data[n]=bytes.readUInt32LE(n*4);
  line.isWrapped=saved.isWrapped;line._combined=copy(saved.combined);line._extendedAttrs={};
  for(const [key,value] of Object.entries(saved.extended))line._extendedAttrs[key]=Object.assign(Object.create(extendedPrototype),value);
  buffer.lines.push(line);
 }
 Object.assign(buffer,snapshot.state);restoreAttrs(buffer.savedCurAttrData,snapshot.saved);
}
function restore(bytes) {
 if(ENGINE!==SUPPORTED_ENGINE)throw Error('Unsupported VT engine implementation');
 if(bytes.length>MAX_SNAPSHOT)throw Error('VT snapshot size limit');
 const dto=JSON.parse(bytes.toString());
 if(dto.format!==1||dto.engine!==ENGINE||dto.parser.currentState!==0)throw Error('Unsupported VT checkpoint identity/state');
 if(!Number.isInteger(dto.cols)||dto.cols<2||dto.cols>1000||!Number.isInteger(dto.rows)||dto.rows<1||dto.rows>1000)throw Error('Invalid VT geometry');
 if(dto.normal.lines.length>dto.rows+dto.options.scrollback||dto.alternate.lines.length>dto.rows)throw Error('Invalid retained VT size');
 const term=new Terminal({...dto.options,cols:dto.cols,rows:dto.rows}),c=term._core,h=c._inputHandler,bs=c._bufferService, buffers=bs.buffers;
 trackPalette(term,dto.palette);
 const extProto=Object.getPrototypeOf(h._curAttrData.extended);
 restoreBuffer(buffers.normal,dto.normal,extProto);restoreBuffer(buffers.alt,dto.alternate,extProto);
 buffers._activeBuffer=dto.active==='alternate'?buffers.alt:buffers.normal;h._activeBuffer=buffers.active;bs.isUserScrolling=dto.userScrolling;
 Object.assign(c.coreService,dto.core);Object.assign(c.coreMouseService,dto.mouse);Object.assign(c._charsetService,dto.charset);
 c._charsetService._charsets=c._charsetService._charsets.map(value=>value??undefined);
 Object.assign(h,dto.input);restoreAttrs(h._curAttrData,dto.current);restoreAttrs(h._eraseAttrDataInternal,dto.erase);
 h._stringDecoder._interim=dto.stringInterim;h._utf8Decoder.interim.set(Buffer.from(dto.utf8Interim,'base64'));c.unicodeService.activeVersion=dto.unicode;
 const p=h._parser;p.initialState=dto.parser.initialState;p.currentState=0;p.precedingJoinState=dto.parser.precedingJoinState;p._collect=dto.parser.collect;
 const {params,sub,indices,...state}=dto.parser.params;Object.assign(p._params,state);
 for(const [target,encoded] of [[p._params.params,params],[p._params._subParams,sub],[p._params._subParamsIdx,indices]]){
  const data=Buffer.from(encoded,'base64');if(data.length!==target.byteLength)throw Error('Unsupported parser parameter storage');
  Buffer.from(target.buffer,target.byteOffset,target.byteLength).set(data);
 }
 const service=c._oscLinkService;
 for(const saved of dto.links.entries){
  const entry={id:saved.id,data:copy(saved.data),...(saved.key===undefined?{}:{key:saved.key}),lines:[]};
  for(const item of saved.lines){const buffer=item.buffer==='normal'?buffers.normal:buffers.alt,marker=buffer.addMarker(item.line);entry.lines.push(marker);marker.onDispose(()=>service._removeMarkerFromLink(entry,marker));}
  service._dataByLinkId.set(entry.id,entry);if(entry.key!==undefined)service._entriesWithId.set(entry.key,entry);
 }
 service._nextId=dto.links.nextId;return {term,metadata:dto.metadata};
}
const write=(term,data)=>new Promise(resolve=>term.write(data,resolve));
class CompactVt {
 constructor(options,metadata={}) {this.term=new Terminal({...options,allowProposedApi:true});trackPalette(this.term);this.metadata=metadata;this.base=capture(this.term,metadata);this.tail=[];this.tailBytes=0;this.overflow=false;this.totalInputBytes=0;this.maxTailBytes=0;}
 async write(data){
  await write(this.term,data);const encoded=typeof data==='string'?{text:data}:{bytes:Buffer.from(data).toString('base64')};
  this.totalInputBytes+=typeof data==='string'?Buffer.byteLength(data):data.length;
  if(ground(this.term)) {this.base=capture(this.term,this.metadata);this.tail=[];this.tailBytes=0;this.overflow=false;}
  else {this.tailBytes+=Buffer.byteLength(JSON.stringify(encoded));this.maxTailBytes=Math.max(this.maxTailBytes,this.tailBytes);if(this.tailBytes>MAX_TAIL){this.overflow=true;this.tail=[];}else if(!this.overflow)this.tail.push(encoded);}
 }
 resize(cols,rows){this.term.resize(cols,rows);if(ground(this.term)){this.base=capture(this.term,this.metadata);this.tail=[];this.tailBytes=0;this.overflow=false;}else{this.tail.push({resize:[cols,rows]});this.tailBytes+=64;if(this.tailBytes>MAX_TAIL)this.overflow=true;}}
 checkpoint(){if(this.overflow)throw Error('VT tail temporarily ineligible');if(ground(this.term))this.base=capture(this.term,this.metadata);return {base:JSON.parse(this.base.toString()),tail:copy(this.tail),metadata:copy(this.metadata)};}
 static async import(checkpoint){const {term,metadata}=restore(Buffer.from(JSON.stringify(checkpoint.base)));for(const item of checkpoint.tail){if(item.resize)term.resize(...item.resize);else await write(term,item.text??Buffer.from(item.bytes,'base64'));}return {term,metadata:checkpoint.metadata??metadata};}
}
module.exports={CompactVt,capture,restore,write,ground,bufferState,ENGINE,MAX_TAIL};
