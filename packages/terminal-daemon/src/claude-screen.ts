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
/** 输入框最多认这么高。再高就不是我们验过的那个形状了，宁可说「认不出」。 */
const MAX_COMPOSER_ROWS=12;
const isBorder=(v:string|undefined)=>/^\s*[─━]{8,}\s*$/.test(v??'');

/**
 * 光标落在哪个输入框里：上下两条横线之间，第一行必须是 `❯`。
 *
 * **输入框不止一行。** 原来这里写死「光标行就是 `❯` 行、上下紧挨着横线」，于是只要正文
 * 换行或者长到软换行，整块画面就判成「认不出」——而认不出是拒绝一切写入的。
 * 实测撞到：从网页发出的消息带一个 JSON 包头，在 136 列下必然折行，粘进去之后
 * 回显核对永远失败，只能退回「等你自己按回车」。用户自己打一段长话也一样。
 */
function composerBox(lines:string[],cursorY:number) {
 let top=-1,bottom=-1;
 for(let i=cursorY;i>=0&&cursorY-i<=MAX_COMPOSER_ROWS;i--)if(isBorder(lines[i])){top=i;break;}
 for(let i=cursorY;i<lines.length&&i-cursorY<=MAX_COMPOSER_ROWS;i++)if(isBorder(lines[i])){bottom=i;break;}
 if(top<0||bottom<=top+1)return null;
 const prompt=/^(\s*)❯[ \u00a0]?(.*)$/.exec(lines[top+1]??'');
 if(!prompt)return null;
 return {promptRow:top+1,indent:prompt[1].length,
  text:[prompt[2],...lines.slice(top+2,bottom).map(line=>line.trim())].join('\n').trim()};
}

export function claudeComposerContent(lines:string[],cursorY:number):string|null {
 return composerBox(lines,cursorY)?.text??null;
}

/** Strictly recognizes the tested plain Claude composer; unknown screens never authorize input. */
export function classifyClaudeComposer(lines:string[],cursorY:number,cursorX:number,mutedPlaceholder=false):ComposerState {
 const box=composerBox(lines,cursorY);
 const surrounding=lines.join('\n');
 if(/Do you trust|trust this folder|Yes,? (?:allow|I trust)|Allow (?:once|always)|Enter to select|Esc to cancel|Do you want to proceed|Choose an option/i.test(surrounding))return 'dialog';
 if(!box)return 'screen_unknown';
 /*
   页脚：确认这块画面**真的是 Claude Code 的输入区**，而不是别的程序恰好画了一个
   夹在横线之间的 `❯`（①②两条并不足以排除这种情况）。

   这是一份按版本实测积累的白名单，而它漂了一次：2026-09-22 在 2.1.278 上实测，页脚是

       ⏵⏵ auto mode on · 1 shell · ← 1 agent

   `auto mode` 六个字母，上面一条都不命中，于是画面被判成「认不出」，一个字节都不写。
   后果不是报错而是**静默不投递**：一条从网页发出的消息在这台机器上排了八分钟，命令
   连续四十多次拿到拒绝，界面只说「正在提交，等待回执」。GUI→TUI 这条链从来没成功过，
   卡的就是这一条。

   所以补两样。`auto mode` 是这次实测到的措辞；`⏵⏵` 是那一行的模式指示符本身——
   措辞会改，这个符号不会，把它一起认上，下次改名不至于又全线静默。
 */
 if(!/(?:Claude Code|shift\+tab|bypass permissions|accept edits|plan mode|auto mode|⏵⏵|for shortcuts)/i.test(surrounding))return 'screen_unknown';
 // 光标不在提示符那一行 = 输入框里已经不止一行，必然有内容。
 if(cursorY!==box.promptRow)return 'terminal_draft';
 if(cursorX>box.indent+2)return 'terminal_draft';
 // **整框的内容**，不只是第一行：第一行空、后面有字时判成 empty 就会往有内容的框里写。
 const content=box.text;
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
  // 灰字判定要看**提示符那一行**，而不是光标那一行——输入框可以有好几行。
  const promptRow=composerBox(lines,buffer.cursorY)?.promptRow??buffer.cursorY;
  const row=buffer.getLine(buffer.baseY+promptRow);const text=lines[promptRow]??'';
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
