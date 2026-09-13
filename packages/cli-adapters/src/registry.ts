export type CliId = string;
export type CliRule = { kind:'executable'|'script'|'executablePathContains'; value:string };
/**
 * 怎么让这个 CLI 接着上次那条会话跑。
 *
 * `{id}` 会被替换成会话的原生 ID。**只有内置定义能带这个**——用户自定义的 CLI 允许
 * 填任意 command，从那里拼一条要执行的 argv 出来是在给别人递刀。
 */
export type CliResume = { args: readonly string[] };
export type CliDefinition = {
  id:CliId;name:string;command:string;rules:CliRule[];iconRef:string|null;
  builtin:boolean;enabled:boolean;priority:number;
  /** 缺省表示这个 CLI 我们还不知道怎么恢复——那就不提供恢复，而不是猜一个。 */
  resume?:CliResume;
};
export const DEFAULT_CLI_DEFINITIONS: readonly CliDefinition[] = [
  {id:'claude',name:'Claude Code',command:'claude',rules:[{kind:'executable',value:'claude'},{kind:'executable',value:'claude-code'},{kind:'script',value:'/@anthropic-ai/claude-code/cli.js'},{kind:'executablePathContains',value:'/.local/share/claude/versions/'},{kind:'executablePathContains',value:'/.claude/local/'}],iconRef:'builtin:claude',builtin:true,enabled:true,priority:0,resume:{args:['--resume','{id}']}},
  {id:'codex',name:'Codex',command:'codex',rules:[{kind:'executable',value:'codex'},{kind:'script',value:'/@openai/codex/bin/codex.js'}],iconRef:'builtin:codex',builtin:true,enabled:true,priority:0,resume:{args:['resume','{id}']}},
  {id:'grok',name:'Grok',command:'grok',rules:[{kind:'executable',value:'grok'}],iconRef:'builtin:grok',builtin:true,enabled:true,priority:0,resume:{args:['--resume','{id}']}},
  {id:'qwen',name:'Qwen Code',command:'qwen',rules:[{kind:'executable',value:'qwen'},{kind:'script',value:'/@qwen-code/qwen-code/cli.js'},{kind:'script',value:'/@qwen-code/qwen-code/cli-entry.js'},{kind:'script',value:'/@qwen-code/qwen-code/bin/qwen.js'}],iconRef:'builtin:qwen',builtin:true,enabled:true,priority:0,resume:{args:['--resume','{id}']}},
  {id:'opencode',name:'OpenCode',command:'opencode',rules:[{kind:'executable',value:'opencode'},{kind:'script',value:'/opencode-ai/bin/opencode'}],iconRef:'builtin:opencode',builtin:true,enabled:true,priority:0,resume:{args:['-s','{id}']}},
  // gemini 的 --resume 收的是**序号**（或 "latest"），不是会话 ID，而序号会随
  // 删除会话而漂移。要支持它得每次先跑 --list-sessions 现查一遍，先不做。
  {id:'gemini',name:'Gemini CLI',command:'gemini',rules:[{kind:'executable',value:'gemini'},{kind:'script',value:'/@google/gemini-cli/dist/index.js'}],iconRef:'builtin:gemini',builtin:true,enabled:true,priority:0},
  {id:'omp',name:'Oh My Pi',command:'omp',rules:[{kind:'executable',value:'omp'},{kind:'executablePathContains',value:'/.local/bin/omp'}],iconRef:'builtin:omp',builtin:true,enabled:true,priority:0,resume:{args:['-r','{id}']}},
];
/** Parse only executable/script positions, never match user prompts or shell command arguments. */
export function detectConfiguredCli(commandLine:string,definitions:readonly CliDefinition[]):CliId|null {
  const tokens=commandLine.match(/"[^"\n]*"|'[^'\n]*'|\S+/g)?.map(value=>value.replace(/^(["'])(.*)\1$/,'$2'))??[];
  const executable=(tokens[0]??'').replace(/\\/g,'/');
  const basename=executable.split('/').at(-1)?.replace(/\.(exe|cmd|bat)$/i,'')??'';
  let script:string|undefined;
  if(['node','bun'].includes(basename)||/^python(?:\d+(?:\.\d+)*)?$/.test(basename)) {
    for(let i=1;i<tokens.length;i++){
      const token=tokens[i];
      if(['-e','--eval','-p','--print','-c','-m'].includes(token)||/^--(?:eval|print)=/.test(token))break;
      if(['-r','--require','--import','--loader','--experimental-loader','-W','-X'].includes(token)){i++;continue}
      if(token.startsWith('-'))continue;
      script=token.replace(/\\/g,'/');break;
    }
  }
  const ordered=definitions.filter(def=>def.enabled).slice().sort((a,b)=>b.priority-a.priority||Number(a.builtin)-Number(b.builtin)||a.id.localeCompare(b.id));
  return ordered.find(def=>def.rules.some(rule=>rule.kind==='executable'?basename===rule.value:
    rule.kind==='script'?script!==undefined&&(script===rule.value||script.endsWith(rule.value.startsWith('/')?rule.value:'/'+rule.value)):
    executable.includes(rule.value)))?.id??null;
}

/**
 * 原生会话 ID 允许长什么样。
 *
 * **这是一道白名单，不是转义。** 这个 ID 会变成一条要执行的命令的一部分；再小心的
 * 引号也不如「压根不接受奇怪字符」可靠。各家实际用的是 UUID（claude/codex/omp/grok）
 * 或带前缀的 token（opencode 的 `ses_…`），都落在这个集合里。
 */
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * 拼出「让这个 CLI 接着那条会话跑」的 argv。
 *
 * 拿不到就返回 null——**不猜**。不知道怎么恢复、ID 形状不对、或者这是个用户自定义的
 * CLI，都属于「我们不知道」，那就别执行任何东西。
 */
export function resumeArgv(definition: CliDefinition | undefined, sessionId: string): string[] | null {
  if (!definition?.builtin) return null;
  /*
    配方按 id 从**代码里**取，不用传进来那份的 `resume` 字段。

    因为存下来的定义是一张冻住的快照：cli_configs 那张表在会话第一次播种时把整个
    definition 序列化进去，之后只跟着用户的编辑走。老库里的 claude 那行压根没有
    `resume` 这个键，而它恰恰是最该能恢复的那个。command 反过来要用传进来那份——
    用户可能把它改成了别的可执行文件名，那是他们的选择。
  */
  const recipe = DEFAULT_CLI_DEFINITIONS.find(builtin => builtin.id === definition.id)?.resume;
  if (!recipe) return null;
  if (!SESSION_ID.test(sessionId)) return null;
  return [definition.command, ...recipe.args.map(arg => arg === '{id}' ? sessionId : arg)];
}
