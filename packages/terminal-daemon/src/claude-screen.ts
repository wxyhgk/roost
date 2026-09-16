import headless from '@xterm/headless';
const {Terminal}=headless;
export type ComposerState='empty'|'terminal_draft'|'dialog'|'screen_unknown';
export type ScreenView={state:ComposerState;seq:number;settled:boolean;version:number;
 /** 输入框里此刻的内容（`❯` 之后那一段）。认不出这块画面时为 null。 */
 composer:string|null};
/**
 * 输入框里此刻的内容。认不出这块画面（没有 `❯`、或上下边框不对）时返回 null。
 *
 * 单独拿出来是为了回答一个 `ComposerState` 答不了的问题：**这段草稿是谁放的。**
 * P2 之后我们自己的正文就留在输入框里，而画面上它和用户自己打的字长得一模一样——
 * 分不出来就会用「终端输入框里还有草稿」去怪用户，而那段草稿是我们放的。
 */
export function claudeComposerContent(lines:string[],cursorY:number):string|null {
 const row=lines[cursorY]??'',match=/^(\s*)❯[ \u00a0]?(.*)$/.exec(row);
 if(!match)return null;
 const border=(v:string)=>/^\s*[─━]{8,}\s*$/.test(v);
 if(!border(lines[cursorY-1]??'')||!border(lines[cursorY+1]??''))return null;
 return match[2].trim();
}

/** Strictly recognizes the tested plain Claude composer; unknown screens never authorize input. */
export function classifyClaudeComposer(lines:string[],cursorY:number,cursorX:number,mutedPlaceholder=false):ComposerState {
 const row=lines[cursorY]??'',match=/^(\s*)❯[ \u00a0]?(.*)$/.exec(row);
 const surrounding=lines.join('\n');
 if(/Do you trust|trust this folder|Yes,? (?:allow|I trust)|Allow (?:once|always)|Enter to select|Esc to cancel|Do you want to proceed|Choose an option/i.test(surrounding))return 'dialog';
 if(!match)return 'screen_unknown';
 const border=(s:string)=>/^\s*[─━]{8,}\s*$/.test(s);
 if(!border(lines[cursorY-1]??'')||!border(lines[cursorY+1]??''))return 'screen_unknown';
 if(!/(?:Claude Code|shift\+tab|bypass permissions|accept edits|plan mode|for shortcuts)/i.test(surrounding))return 'screen_unknown';
 if(cursorX>match[1].length+2)return 'terminal_draft';
 const content=match[2].trim();
 if(!content)return 'empty';
 if(mutedPlaceholder&&/^Try ["“].+["”]$/.test(content))return 'empty';
 return 'terminal_draft';
}

export function createClaudeScreen(cols=80,rows=24) {
 const terminal=new Terminal({cols,rows,scrollback:0,allowProposedApi:true});
 let received=0,parsed=0,pending=0,broken=false,disposed=false,version=0;
 // Deliberately no onData/onBinary forwarding: this is an observation-only renderer.
 const inspect=():ScreenView=>{
  if(disposed||broken||parsed!==received)return {state:'screen_unknown',seq:parsed,settled:false,version,composer:null};
  const buffer=terminal.buffer.active;
  const lines=Array.from({length:terminal.rows},(_,i)=>buffer.getLine(buffer.baseY+i)?.translateToString(true)??'');
  const row=buffer.getLine(buffer.baseY+buffer.cursorY);const text=lines[buffer.cursorY]??'';
  let muted=true;
  const prompt=text.indexOf('❯');
  for(let x=prompt+2;x<(row?.length??0);x++){
   const cell=row!.getCell(x);if(!cell?.getChars().trim())continue;
   const color=cell.getFgColor();
   const gray=cell.isFgRGB()&&((color>>16)&255)===((color>>8)&255)&&((color>>8)&255)===(color&255)&&(color&255)<180;
   if(!cell.isDim()&&!gray&&!(cell.isFgPalette()&&[8,240,241,242,243,244,245].includes(color)))muted=false;
  }
  return {state:classifyClaudeComposer(lines,buffer.cursorY,buffer.cursorX,muted),seq:parsed,settled:true,version,
   composer:claudeComposerContent(lines,buffer.cursorY)};
 };
 return {
  write(data:string,seq:number){
   if(disposed||broken)return;const bytes=Buffer.byteLength(data);received=seq;version++;pending+=bytes;
   if(pending>2*1024*1024){broken=true;terminal.dispose();return;}
   try{terminal.write(data,()=>{pending-=bytes;parsed=seq;});}catch{broken=true;}
  },
  resize(cols:number,rows:number){
   if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<1||rows<1)return;
   version++;
   if(cols>300||rows>150){broken=true;return;}
   if(!disposed&&!broken)terminal.resize(cols,rows);
  },
  inspect,
  dispose(){disposed=true;terminal.dispose();},
 };
}
export type ClaudeScreen=ReturnType<typeof createClaudeScreen>;
