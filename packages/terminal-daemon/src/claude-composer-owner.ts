/**
 * 输入框里这段草稿，是不是我们放进去的那条 prompt。
 *
 * **为什么需要它**：P2（只放正文、不替用户按回车）之后，我们自己的正文就留在输入框里。
 * 画面上它和用户自己打的字长得一模一样，于是下一条消息会被「终端输入框里还有草稿」挡住
 * ——而那句话是在**怪用户**，草稿其实是我们放的。
 *
 * **两种形状，都要认**：
 *
 * 1. 原文。短的单行粘贴 claude 原样显示。
 * 2. **折叠标记**。粘贴多行时 claude 把输入框显示成 `[Pasted text #1 +4 lines]`——
 *    实测 2.1.273：粘 5 行（4 个换行）得到 `+4 lines`，**数字等于换行数**。
 *    足够大的单行粘贴还会省掉计数，只剩 `[Pasted text #1]`。
 *
 * 计数用区间而不是相等：claude 自己怎么数行没有承诺，硬要求相等会在它换算法时静默失效，
 * 而这里判错的代价只是「一句提示说得不够准」，不是安全问题。区间取法照搬 happier 实测过
 * 的那一档（见 research/happier-unified-terminal.md）。
 *
 * **这个判断永远不用来授权写入。** 它只决定一句提示怎么说——「你的消息在输入框里等你按
 * 回车」还是「终端里有你自己的草稿」。授权走的是别的闸。
 */

const MARKER_WITH_COUNT=/^\[\s*Pasted text(?:\s*#\s*\d+)?\s*\+\s*([0-9][0-9,._\s]*)\s+lines?\s*\]$/i;
const MARKER_WITHOUT_COUNT=/^\[\s*Pasted text(?:\s*#\s*\d+)?\s*\]$/i;

const newlines=(value:string)=>{let n=0;for(let i=0;i<value.length;i++)if(value.charCodeAt(i)===10)n++;return n;};
const normalize=(value:string)=>value.replace(/\r\n?/g,'\n').trim();

/** 折叠标记里的行数；不是这个形状就返回 null。 */
export function pastedMarkerLineCount(composer:string):number|null {
  const match=MARKER_WITH_COUNT.exec(composer.trim());
  if(!match)return null;
  const digits=(match[1]??'').replace(/\D/g,'');
  if(!digits)return null;
  const parsed=Number.parseInt(digits,10);
  return Number.isSafeInteger(parsed)&&parsed>=0?parsed:null;
}

/**
 * 屏幕上读回来的正文和原文比对时，**软换行和真换行分不开**。
 *
 * 输入框里一行长文本超过终端宽度就会折行，读回来变成两行；而原文里那儿没有换行。
 * 反过来原文里的换行在屏幕上也是换行。两者在画面上长得一模一样，没有任何办法从屏幕
 * 区分——所以比对时把空白整个抹掉再比。
 *
 * 这不算放宽：同一个函数已经接受「`[Pasted text #1]` 就算数」那条更松的路，而且它自己
 * 写着**永远不用来授权写入**。抹掉空白之后两段不同的正文仍然几乎不可能相等。
 */
const squeeze=(value:string)=>value.replace(/\s+/g,'');

export function composerHoldsPrompt(composer:string|null,prompt:string):boolean {
  if(composer===null)return false;
  const text=composer.trim(),wanted=normalize(prompt);
  if(!text||!wanted)return false;
  if(text===wanted)return true;
  if(squeeze(text)===squeeze(wanted))return true;
  // 计数被省略时标记不携带任何身份信息，只能说「像是一次粘贴」——
  // 所以它必须限定在「我们确实刚放过一条」这个前提下用，而调用方正是这么用的。
  if(MARKER_WITHOUT_COUNT.test(text))return true;
  const count=pastedMarkerLineCount(text);
  if(count===null)return false;
  const expected=newlines(wanted);
  return count>=Math.max(1,expected-2)&&count<=expected+3;
}
