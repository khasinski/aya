// Pure cell codec shared by the browser producer and main's validator. No I/O,
// xterm dependency, constructors chosen by payloads, or platform byte order.
const pointMask=0x1fffff, defaultFlags=2;
function encodeCellRuns(words,length){
 let text='',flags=[],attrs=[],flagStart=-1,flagValue=defaultFlags,fg=words[1],bg=words[2];
 for(let n=0;n<length;n++){
  const word=words[n*3],point=word&pointMask,bits=word>>>21;
  if(point>0x10ffff||(point>=0xd800&&point<=0xdfff)||bits>7)return null;
  text+=String.fromCodePoint(point);
  if(bits!==flagValue){if(flagStart>=0)flags.push([flagStart,n,flagValue]);flagStart=bits===defaultFlags?-1:n;flagValue=bits;}
  const nextFg=words[n*3+1],nextBg=words[n*3+2];
  if(nextFg!==fg||nextBg!==bg){attrs.push([n,fg,bg]);fg=nextFg;bg=nextBg;}
 }
 if(flagStart>=0)flags.push([flagStart,length,flagValue]);
 attrs.push([length,fg,bg]);
 return {text:text.replace(/\0+$/,''),flags,attrs};
}
function decodeCellRuns(value,length){
 const fail=()=>{throw Error('Invalid renderer cell runs');};
 const integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
 if(!integer(length,1,1000)||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='attrs,flags,text'||typeof value.text!=='string'||value.text.length>length*2||!Array.isArray(value.flags)||value.flags.length>length||!Array.isArray(value.attrs)||value.attrs.length<1||value.attrs.length>length)fail();
 // Validate all row shape/ranges before allocating even this bounded plane.
 const points=Array.from(value.text,c=>c.codePointAt(0));
 if(points.length>length||points.some(p=>p>=0xd800&&p<=0xdfff))fail();
 let end=0;
 for(const run of value.attrs){if(!Array.isArray(run)||run.length!==3||!integer(run[0],end+1,length)||!integer(run[1],0,0xffffffff)||!integer(run[2],0,0xffffffff))fail();end=run[0];}
 if(end!==length)fail();end=0;
 for(const run of value.flags){if(!Array.isArray(run)||run.length!==3||!integer(run[0],end,length-1)||!integer(run[1],run[0]+1,length)||!integer(run[2],0,7)||run[2]===defaultFlags)fail();end=run[1];}
 const words=new Uint32Array(length*3);
 for(let n=0;n<length;n++)words[n*3]=(points[n]??0)|(defaultFlags<<21);
 let start=0;
 for(const [end,fg,bg]of value.attrs){for(let n=start;n<end;n++){words[n*3+1]=fg;words[n*3+2]=bg;}start=end;}
 for(const [start,end,bits]of value.flags)for(let n=start;n<end;n++)words[n*3]=(words[n*3]&pointMask)|(bits<<21);
 return words;
}
module.exports={encodeCellRuns,decodeCellRuns};
