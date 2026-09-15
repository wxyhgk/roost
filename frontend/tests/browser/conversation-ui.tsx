import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationLens } from '../../src/features/terminal/view/TerminalLens';
import { TerminalAppearanceSettings } from '../../src/features/terminal/view/TerminalAppearanceSettings';
import { IconButton } from '../../src/shared/ui/IconButton';
import { IconDownload, IconSearch } from '../../src/shared/icons';
import { listConversations, type Conversation } from '../../src/shared/api/conversations';
import { WorkspaceProvider } from '../../src/shared/store';
import { ThemeProvider } from '../../src/shared/theme';
import { t } from '@roost/i18n';
import '../../src/index.css';
import type { Lens } from '../../src/shared/view';

/*
  画的是**中栏在对话视角下的完整样子**，不再是光秃秃的 ConversationDetail。

  三层头合成一层之后，头的内容有一半来自 `TerminalPane`（返回画布、工作目录、主题/搜索/
  下载、视角标签条），另一半来自 `ConversationLens`（本终端历史那颗菜单）。只渲染
  `ConversationDetail` 就等于把要看的东西一大半排除在截图之外。

  `TerminalPane` 本身不能直接搬进来：它会挂 `TermView`，那要 PTY 和 WebGL。所以这里手工
  喂一份和它一样的 `utilities` 节点，其余交给 `ConversationLens`。
*/
function Fixture() {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [lens, setLens] = useState<Lens>('gui');
  useEffect(() => { void listConversations({}).then(page => setConversation(page.items[0] ?? null)); }, []);
  if (!conversation) return <div className="p-4 text-text-dim">正在读 fixture 对话…</div>;
  /*
    中间栏那个宽度：对话视图真实的落点就是 720。写成可从 `?w=` 传，是因为**写死的宽度会
    把窄屏审查变成假阳性**——截图脚本把窗口调到 400 之后，溢出的是这个 720 的盒子本身，
    真正的响应式问题全被它盖住。`?w=full` 就是跟着窗口走。
  */
  const w = new URLSearchParams(location.search).get('w') ?? '720';
  const utilities = (
    <>
      <TerminalAppearanceSettings />
      <IconButton title={t.terminal.pane.search} onClick={() => {}}><IconSearch /></IconButton>
      <IconButton title={t.terminal.pane.exportLog} onClick={() => {}}><IconDownload /></IconButton>
    </>
  );
  return (
    <div className="h-screen border-r border-border" style={w === 'full' ? { width: '100%' } : { width: `${w}px` }}>
      <ConversationLens
        terminalId="fixture-shell"
        conversationId={null}
        current={false}
        /* 钉住这一条：等价于「左栏点了一条历史」，于是只读徽章和那条 notice 都会出现。 */
        pinned={conversation.id}
        terminalLabel="fixture-shell"
        cwd="/Users/me/roost/frontend/src/features/conversations"
        onBackToCanvas={() => {}}
        utilities={utilities}
        lens={lens}
        onLens={setLens}
      />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><WorkspaceProvider><Fixture /></WorkspaceProvider></ThemeProvider></StrictMode>,
);
