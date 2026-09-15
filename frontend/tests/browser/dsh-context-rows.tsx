// 隔离的浏览器 fixture：把 vendor/dsh/chat 的上下文注入行 + 系统提示词行画出来。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-context-rows.html 就行。
//
// 为什么非画出来不可：NOTICE.md 第 3/5 条把同一个模式记了**五次**——上游那批 CSS 建立在
// 上游自己的 reset 上，搬到我们的 Tailwind preflight 上必然缺一块，而五次全是 typecheck
// 和单测看不见、只有截图才发现的（`ol,ul{list-style:none}` 干掉列表标记、
// `svg{display:block}` 拆散行内芯片、`textarea{resize:vertical}` 长出把手、最近一次
// 肇事者是模块图：令牌表只挂在懒加载链上，首屏拿到一片空串）。
// 这两个组件正好把那几类**全都占齐了**：三处 `<ul>`（files / entries / recalls）、
// 两处 `<dl><dt><dd>`（source fields / snapshot sections）、一处 `<pre>`、一处 `<code>`、
// 以及一个**裸 `<span>` 里的 inline svg**（`data-context-recall-icon`）——NOTICE 第三轮之三
// 记过「上游把每个 inline svg 都装在 flex/inline-flex 容器里，`svg{display:block}` 被 flex
// item 的 blockify 吃掉了」；而这一处图标的**直接**父元素是个没有样式的裸 span，那层保护少
// 了一级，所以要量一眼行高有没有被撑歪。
//
// 要看的七件事（页面底部有实测读数，不用开 devtools）：
//   1. **折叠行是 24px**，图标 + 标题 + 2px 的分隔点 + 生产者名，一行不折。
//   2. **notice 那一档的 summary 直接骑在折叠行上**——它存在的全部意义就是不展开也能读。
//   3. **展开的正文是一个 141px 高的滚动口**，11px/16px 等宽字，背景走
//      `--dsw-alias-markdown-code-block`。超过 20000 字符的正文末尾压一行截断脚注。
//   4. **三处 `<ul>` 不能有圆点**，两处 `<dd>` 不能有 40px 的默认缩进。
//   5. **`<code class=entryName>` 的字族必须和正文一致**——preflight 会给 `code` 单独
//      塞一条 font-family，我们的 `--font-mono` 声明在 `@theme` 里，所以两边应当同源。
//   6. **`data-context-recall-icon` 里那个 svg**：被 preflight 拍成 block 也不能把行撑歪。
//   7. **喂不满的两档（relay / recall）落在 `OpaqueBody` 上**，不是空壳——
//      `contextBody` 的每一档都有全有或全无的读取闸门，读不出来就退回不透明正文。
//      这一页特意用**我们 transcript 里真有的形状**去喂它们，看退化是不是干净的。
//
// 深浅两套主题都要看：右上角切换，或 localStorage 的 `roost-theme`。
import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContextInjectionRow, type ContextInjectionLabels } from '../../src/vendor/dsh/chat/ContextInjectionRow';
import type { ContextContentBlock, KnownContextForm } from '../../src/vendor/dsh/chat/ContextBody';
import { SystemPromptRow, type SystemPromptLabels } from '../../src/vendor/dsh/chat/SystemPromptRow';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
// NOTICE 第 5 条：这批 module.css 只认 --dsw-*，少了这张桥接表就是一片无色。
import '../../src/vendor/dsh/tokens.css';
import '../../src/index.css';

/** 文案照上游 zh locale 逐条对过（`ui-chat/src/client/locale.ts` 37–61、109 行）。 */
const LABELS: ContextInjectionLabels = {
  unknownBlock: '未知内容块',
  jsonTruncated: total => `… 已截断，共 ${String(total)} 字符`,
  instructions: { loaded: '已载入', added: '已新增', updated: '已更新', removed: '已移除' },
  catalogReplaced: '替换目录',
  catalogMore: count => `…还有 ${String(count)} 条`,
  snapshotSupersedes: '取代先前的快照',
  relayFrom: session => `来自会话 ${session}`,
  recallCounts: (retained, omitted) => `保留 ${String(retained)} 条 · 省略 ${String(omitted)} 条`,
  recallTruncated: '已截断',
  contextInjection: '上下文注入',
  contextRecall: '跨会话召回',
};

const PROMPT_LABELS: SystemPromptLabels = {
  unknownBlock: LABELS.unknownBlock,
  jsonTruncated: LABELS.jsonTruncated,
  systemPrompt: '系统提示词',
  systemPromptUpdate: '系统提示词更新',
};

const text = (value: string): readonly ContextContentBlock[] => [{ type: 'text', text: value }];

/*
  下面这批 source 的**字段名全部照上游契约**（changes/entries/sections/summary/references/
  senderSessionId），值则照本机 Claude 转录里真实 attachment 的形状编——这样看到的就是
  「解析器按上游契约投影之后」的样子，而不是一张想象图。每一节的小字写了它对应哪个
  attachment type。
*/

interface Case {
  /** 小标题，shot-clip.mjs 按它定位截图区域。 */
  title: string;
  /** 这一档对应本机转录里的哪个 attachment type，以及对不对得上。 */
  note: string;
  row: {
    content: readonly ContextContentBlock[];
    source: unknown;
    producer: { role: 'inject' | 'recall'; label: string | null };
    form: KnownContextForm | null;
  };
}

const CASES: readonly Case[] = [
  {
    title: 'instructions · 开场载入（baseline）',
    note: 'Claude 的 attachment.type = "instructions"（本机 12 条）。'
      + 'files[].path → changes[].action=set + baseline=true，四个动作词里走「已载入」。digest 挂在 li 的 title 上。',
    row: {
      form: 'instructions',
      producer: { role: 'inject', label: 'CLAUDE.md +1' },
      source: {
        kind: 'claude.instructions',
        form: 'instructions',
        baseline: true,
        changes: [
          { action: 'set', path: '/Users/virtualized/Code/roost/CLAUDE.md', digest: 'sha256:9f2c1ab4…' },
          { action: 'set', path: '/Users/virtualized/.claude/projects/-Users-virtualized-Code-roost/memory/MEMORY.md' },
        ],
      },
      content: text('<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these '
        + 'instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly '
        + 'as written.\n\nContents of /Users/virtualized/Code/roost/CLAUDE.md (project instructions, checked into the '
        + 'codebase):\n\n# CLAUDE.md\n\n**内容在 [AGENTS.md](AGENTS.md)，请读那一份。**\n\n这里不重复一遍，是因为两份九成重叠的文档一定会漂移——'
        + '改了一个忘了另一个，比只有一份更糟。\n</system-reminder>'),
    },
  },
  {
    title: 'instructions · 增量（三个动作词）',
    note: '同一档的另一半：baseline=false 时 set/replace/remove 分别画成「已新增/已更新/已移除」。'
      + 'Claude 目前只发开场那一次，所以这三档在我们这儿暂时是死的——但读取器是数据驱动的，接上就有。',
    row: {
      form: 'instructions',
      producer: { role: 'inject', label: 'AGENTS.md +2' },
      source: {
        kind: 'claude.instructions',
        form: 'instructions',
        baseline: false,
        changes: [
          { action: 'set', path: 'frontend/AGENTS.md' },
          { action: 'replace', path: '/Users/virtualized/Code/roost/CLAUDE.md', digest: 'sha256:77de00c1…' },
          { action: 'remove', path: '~/.claude/CLAUDE.md' },
        ],
      },
      content: text('<system-reminder>\n三份指令文件在这一轮之间变过。\n</system-reminder>'),
    },
  },
  {
    title: 'catalog · 技能目录',
    note: 'Claude 的 attachment.type = "skill_listing"（本机 80 条）。names[] 给名字，'
      + 'content 那段 "- name: 说明" 拆出说明 → entries[{name,description}]。描述超宽时单行省略号。',
    row: {
      form: 'catalog',
      producer: { role: 'inject', label: '17 个技能' },
      source: {
        kind: 'claude.skill_listing',
        form: 'catalog',
        update: false,
        entries: [
          { name: 'design', description: 'Create a design canvas - a multi-artboard visual design published as an Artifact.' },
          { name: 'dataviz', description: '在任何输出介质里做图表、仪表盘、数据可视化之前先读这一份。' },
          { name: 'artifact-design', description: 'Design guidance and fundamentals for Artifacts.' },
          { name: 'update-config', description: '改 settings.json：权限、环境变量、hooks。' },
          { name: 'code-review', description: 'Review the current diff for correctness bugs and cleanups.' },
        ],
      },
      content: text('<system-reminder>\nThe following skills are available for use with the Skill tool:\n…\n</system-reminder>'),
    },
  },
  {
    title: 'catalog · 替换目录（update=true）',
    note: 'Claude 的 "agent_listing_delta" / "deferred_tools_delta"（各 16 条）：addedLines 就是 "- name: 说明"。'
      + 'isInitial=false → update=true，正文顶上多一句「替换目录」。deferred_tools_record 更直接，它自带 entries[{name,description}]。',
    row: {
      form: 'catalog',
      producer: { role: 'inject', label: 'agent 目录' },
      source: {
        kind: 'claude.agent_listing_delta',
        form: 'catalog',
        update: true,
        entries: [
          { name: 'claude', description: 'Catch-all for any task that does not fit a more specific agent.' },
          { name: 'Explore', description: 'Read-only search agent for broad fan-out searches.' },
          { name: 'general-purpose', description: 'General-purpose agent for researching complex questions.' },
          { name: 'Plan', description: 'Software architect agent for designing implementation plans.' },
        ],
      },
      content: text('<system-reminder>\nAvailable agent types for the Agent tool:\n…\n</system-reminder>'),
    },
  },
  {
    title: 'snapshot · 运行环境',
    note: 'Claude 的 attachment.type = "environment"（本机 432 条）：snapshot 那个对象的每个键 → sections[{name,text}]。'
      + '"session_context"（94 条）是同一个形状。**接之前要确认那句写死的「取代先前的快照」在我们的数据上成立**——'
      + 'environment 会在会话中途重发，语义是对的；换成别的生产者就要重新想。',
    row: {
      form: 'snapshot',
      producer: { role: 'inject', label: 'environment' },
      source: {
        kind: 'claude.environment',
        form: 'snapshot',
        sections: [
          { name: 'workingDirectory', text: '/Users/virtualized/Code/roost' },
          { name: 'isGitRepo', text: 'true' },
          { name: 'platform', text: 'darwin' },
          { name: 'shell', text: 'zsh' },
          { name: 'osVersion', text: 'Darwin 25.6.0' },
          { name: 'scratchpadDirectory', text: '/private/tmp/claude-501/-Users-virtualized-Code-roost/a7c22068/scratchpad' },
        ],
      },
      content: text('<system-reminder>\n# Environment\nYou have been invoked in the following environment: …\n</system-reminder>'),
    },
  },
  {
    title: 'notice · 剩余额度',
    note: 'Claude 的 attachment.type = "total_tokens_reminder"（本机 5923 条，压倒性的大头）。'
      + '**summary 要解析器自己写**——转录里没有任何一个 attachment 自带 summary 字段，而 summary 为空这一档就退回不透明正文。',
    row: {
      form: 'notice',
      producer: { role: 'inject', label: '额度提醒' },
      source: { kind: 'claude.total_tokens_reminder', form: 'notice', summary: '剩余 14,860,000 token' },
      content: text('<total_tokens>14860000 tokens left</total_tokens>'),
    },
  },
  {
    title: 'notice · 文件在读过之后变了',
    note: 'Claude 的 "edited_text_file"（129 条）：filename + snippet。summary 由解析器拼（文件名 + 「落盘后又变过」）。'
      + '"date"（98 条）和 "remote_session_change"（98 条）也落在这一档。',
    row: {
      form: 'notice',
      producer: { role: 'inject', label: 'tasks/bp1e8ked2.output' },
      source: {
        kind: 'claude.edited_text_file',
        form: 'notice',
        summary: 'tasks/bp1e8ked2.output 在上次读取之后变过',
      },
      content: text('<system-reminder>\nNote: /private/tmp/claude-501/.../tasks/bp1e8ked2.output changed on disk since '
        + 'the last read.\n\n1\tScope: all 2 workspace projects\n2\t✓ Lockfile passes supply-chain policies\n'
        + '3\tLockfile is up to date, resolution step is skipped\n4\tAlready up to date\n</system-reminder>'),
    },
  },
  {
    title: 'relay · 喂不满 → 退回 OpaqueBody',
    note: '**这一档我们对不上。** RelayBody 要 source.senderSessionId（发送方会话 id），'
      + '而最接近的 "queued_command"（97 条）只有 task-id，没有会话 id。这里特意用那个真实形状去喂，'
      + '看到的就是干净的退化：正文照画，source 的字段列在底下（连 form 的声明一起留着，'
      + '那是「这一版认不出的 form」唯一不会从界面上消失的地方）。',
    row: {
      form: 'relay',
      producer: { role: 'inject', label: 'queued_command' },
      source: {
        kind: 'claude.queued_command',
        form: 'relay',
        commandMode: 'task-notification',
        timestamp: '2026-09-15T08:20:39.833Z',
      },
      content: text('<task-notification>\n<task-id>bp1e8ked2</task-id>\n<tool-use-id>toolu_011Nb174Q6vVrKuuyTh8w5EJ'
        + '</tool-use-id>\n</task-notification>'),
    },
  },
  {
    title: 'recall · 喂不满 → 退回 OpaqueBody（role=recall 的图标这一支）',
    note: '**这一档我们也对不上。** RecallBody 要 references[{label,retainedMessages,omittedMessages,truncated}]，'
      + '「保留/省略了多少条」正是这张卡存在的理由，而我们一条都拿不到。'
      + '但 producer.role=recall 这一支照样要看：图标从 IconContextInjection 换成 ReferenceIcon kind=session，'
      + '标题换成「跨会话召回」——而这个 svg 的直接父元素是个裸 span，是整个目录里离 preflight 最近的一处。',
    row: {
      form: 'recall',
      producer: { role: 'recall', label: 'src/features/files/TreeNode.tsx' },
      source: {
        kind: 'claude.compact_file_reference',
        form: 'recall',
        displayPath: 'src/features/files/TreeNode.tsx',
      },
      content: text('<system-reminder>\nNote: TreeNode.tsx was read before the last conversation was summarized, '
        + 'but the contents are no longer in context.\n</system-reminder>'),
    },
  },
  {
    title: 'form=null · 未知生产者，且没有名字',
    note: 'producer.label=null 时那颗 2px 的分隔点连同名字一起不画——上游注释写死了这条。'
      + '本机的 "hook_system_message" / "thinking_stripped" / "auto_mode" 这些都落在这里。',
    row: {
      form: null,
      producer: { role: 'inject', label: null },
      source: { kind: 'claude.hook_system_message', hookName: 'PostToolUse:Bash', hookEvent: 'PostToolUse' },
      content: text('Tip: Run /ultrareview before you push to catch bugs with a cloud-based multi-agent review '
        + '— 3 free reviews left.'),
    },
  },
  {
    title: '未知内容块 · 文本之间夹一个认不出的块',
    note: '上游那个块联合是 merge-extensible 的：认不出的块**不丢、不挪位**，'
      + '在原地按 JsonBlock 画。相邻的文本块之间不插换行——插了就是给读者看一行模型没看过的东西。',
    row: {
      form: null,
      producer: { role: 'inject', label: 'file' },
      source: { kind: 'claude.file', displayPath: 'tests/xyz-parse.test.ts' },
      content: [
        { type: 'text', text: '<system-reminder>\nCalled the Read tool with the following input:\n' },
        { type: 'image', mediaType: 'image/png', bytes: 20144 },
        { type: 'text', text: '\n</system-reminder>' },
      ],
    },
  },
  {
    title: '超长正文 · 20000 字符的上界',
    note: '上界压在展开处，不压在生产者那边（`MAX_CHARS = 20_000`）。超了就在末尾补一行截断脚注，'
      + '正文本身仍旧装在 141px 的滚动口里滚。',
    row: {
      form: null,
      producer: { role: 'inject', label: 'prompt_snapshot' },
      source: { kind: 'claude.prompt_snapshot', form: 'opaque' },
      content: text(Array.from({ length: 420 },
        (_, i) => `第 ${String(i + 1)} 行：这一段是拿来撑满 20000 字符上界的，好看清末尾那一行截断脚注真的出现了。`).join('\n')),
    },
  },
];

const SYSTEM_PROMPT = [
  'You are an interactive agent that helps users with software engineering tasks.',
  '',
  'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and security research.',
  '',
  '# Tone and style',
  'You should be concise, direct, and to the point. Your responses can use Github-flavored markdown for formatting.',
  '',
  '# Following conventions',
  'When making changes to files, first understand the file\'s code conventions. Mimic code style, use existing',
  'libraries and utilities, and follow existing patterns.',
].join('\n');

/** 展开态那一列：挂载后把里面每一行点开一次。 */
function AutoExpand({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  useEffect(() => {
    // StrictMode 下 effect 会跑两遍，点两下就又合上了；用 ref 挡住第二遍
    // （StrictMode 的重挂载复用同一个 useRef 对象，所以这个闸门是有效的）。
    if (done.current) return;
    done.current = true;
    ref.current?.querySelectorAll<HTMLElement>('[data-disclosure-row][data-expandable]')
      .forEach(el => { el.click(); });
  }, []);
  return <div ref={ref} style={{ flex: '1 1 380px', minWidth: 0 }}>{children}</div>;
}

function Pane({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div style={{ font: '11px/16px var(--font-mono)', color: 'var(--color-text-dim)', marginBottom: 4 }}>{label}</div>
      {children}
    </>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section style={{ borderTop: '1px solid var(--color-border)', padding: '14px 0 18px' }}>
      <h2 style={{ margin: '0 0 4px', font: '600 13px/20px var(--font-sans, inherit)' }}>{title}</h2>
      {/* overflowWrap 是 fixture 自己的说明文字要的：注释里有 `references[{label,…}]` 这种
          不带空格的长串，400px 下会把**页面**撑出横向滚动，于是 audit-shot 的溢出探针每次
          都报一条假警。被测组件自己没有这个问题（上游每一处长文本都带 overflow-wrap）。 */}
      <p style={{
        margin: '0 0 10px', font: '11px/17px var(--font-mono)',
        color: 'var(--color-text-dim)', overflowWrap: 'anywhere',
      }}>{note}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>{children}</div>
    </section>
  );
}

/** 实测读数。每一行对应文件头注释里的一件事，省得开 devtools。 */
function Readouts() {
  const [lines, setLines] = useState<readonly string[]>([]);
  useLayoutEffect(() => {
    const read = () => {
      const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);
      const cs = (el: Element | null) => el === null ? null : getComputedStyle(el);
      const body = q('[data-context-injection-body]');
      const files = q('[data-context-files]');
      const entryName = document.querySelector('[data-context-entries] code');
      const recallSvg = document.querySelector('[data-context-recall-icon] svg');
      const dd = document.querySelector('[data-context-sections] dd');
      const pre = q('[data-context-text]');
      const row = q('[data-disclosure-row]');
      const longest = [...document.querySelectorAll('[data-context-text]')]
        .map(el => el.textContent ?? '').sort((a, b) => b.length - a.length)[0] ?? '';
      const px = (n: number | undefined) => n === undefined ? '—' : `${String(Math.round(n))}px`;
      const bodyStyle = cs(body);
      const nameFont = cs(entryName)?.fontFamily ?? '—';
      setLines([
        `折叠行高 ${px(row?.getBoundingClientRect().height)}（上游定死 24px + 字号 delta）`,
        `正文口 max-height=${bodyStyle?.maxHeight ?? '—'} font=${bodyStyle?.font ?? '—'}`
          + `（要 141px / 11px 16px 等宽）`,
        `正文底色 --dsw-alias-markdown-code-block = `
          + `${getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-markdown-code-block').trim() || '（空！令牌表没跟着进来）'}`
          + `，实际画出来 ${bodyStyle?.backgroundColor ?? '—'}`,
        `列表标记 ul[data-context-files] list-style-type=${cs(files)?.listStyleType ?? '—'}`
          + `（必须是 none：preflight 的 ol,ul{list-style:none} 在这儿和上游同向，'disc' 就是出事了）`,
        `catalog 的 <code> 字族=${nameFont.slice(0, 44)} ／ 正文字族=${(bodyStyle?.fontFamily ?? '').slice(0, 44)}`
          + `（preflight 给 code 单塞过一条，两边不同源就是第六次翻车）`,
        `snapshot 的 <dd> margin-inline-start=${cs(dd)?.marginInlineStart ?? '—'}`
          + `（浏览器默认 40px，preflight 归零；上游这份 CSS 自己也写了 margin:0）`,
        `<pre> white-space=${cs(pre)?.whiteSpace ?? '—'} font=${(cs(pre)?.fontFamily ?? '').slice(0, 30)}`
          + `（要 pre-wrap + 继承正文口的等宽字）`,
        `召回图标 svg display=${cs(recallSvg)?.display ?? '—'} 尺寸 `
          + `${px(recallSvg?.getBoundingClientRect().width)}×${px(recallSvg?.getBoundingClientRect().height)}`
          + `（preflight 会把它拍成 block；只要没把 24px 的行撑歪就算过）`,
        `横向溢出：document.scrollWidth=${String(document.documentElement.scrollWidth)} / `
          + `clientWidth=${String(document.documentElement.clientWidth)}`,
        // 20000 字符那一档：脚注在滚动口的最底下，截图里看不见，只能量。
        `最长正文 ${String(longest.length)} 字符，末尾 40 字：${JSON.stringify(longest.slice(-40))}`
          + `（超过 20000 就必须以截断脚注收尾）`,
      ]);
    };
    read();
    const t = setTimeout(read, 300);
    window.addEventListener('resize', read);
    return () => { clearTimeout(t); window.removeEventListener('resize', read); };
  }, []);
  return (
    <div style={{
      marginTop: 20, overflowWrap: 'anywhere',
      borderTop: '1px solid var(--color-border)', background: 'var(--color-bar)',
      color: 'var(--color-bar-text)', padding: '6px 10px', font: '12px/18px var(--font-mono)',
    }}>
      {lines.map(line => <div key={line}>{line}</div>)}
    </div>
  );
}

function Fixture() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div style={{
      minHeight: '100vh', background: 'var(--color-bg)', color: 'var(--color-text)',
      padding: '0 16px 0', boxSizing: 'border-box',
    }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 1, display: 'flex', gap: 10, alignItems: 'center',
        padding: '8px 0', background: 'var(--color-bg)', fontSize: 12,
      }}>
        <button type="button" onClick={toggleTheme}>主题：{theme}</button>
        <span style={{ opacity: 0.7 }}>左列折叠态、右列展开态（挂载时自动点开），两列是同一份数据</span>
      </div>

      {CASES.map(item => (
        <Section key={item.title} title={item.title} note={item.note}>
          <div style={{ flex: '1 1 380px', minWidth: 0 }}>
            <Pane label="折叠">
              <ContextInjectionRow {...item.row} labels={LABELS} />
            </Pane>
          </div>
          <AutoExpand>
            <Pane label="展开">
              <ContextInjectionRow {...item.row} labels={LABELS} />
            </Pane>
          </AutoExpand>
        </Section>
      ))}

      <Section
        title="SystemPromptRow · 完整系统提示词"
        note={'Claude 的 attachment.type = "prompt_snapshot"（本机 188 条）：systemPrompt 是个字符串数组，拼起来就是这一行要的 text。'
          + '它复用 ContextInjectionRow.module.css 和 OpaqueBody，所以正文口和上面每一档是同一个。update=true 只换标题。'}
      >
        <div style={{ flex: '1 1 380px', minWidth: 0 }}>
          <Pane label="折叠（首次 / 更新两种标题）">
            <SystemPromptRow text={SYSTEM_PROMPT} labels={PROMPT_LABELS} />
            <SystemPromptRow text={SYSTEM_PROMPT} update labels={PROMPT_LABELS} />
          </Pane>
        </div>
        <AutoExpand>
          <Pane label="展开">
            <SystemPromptRow text={SYSTEM_PROMPT} labels={PROMPT_LABELS} />
          </Pane>
        </AutoExpand>
      </Section>

      <Readouts />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
