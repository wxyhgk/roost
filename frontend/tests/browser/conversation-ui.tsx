import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationDetail } from '../../src/features/conversations/ConversationDetail';
import { listConversations, type Conversation } from '../../src/shared/api/conversations';
import { WorkspaceProvider } from '../../src/shared/store';
import { ThemeProvider } from '../../src/shared/theme';
import '../../src/index.css';

function Fixture() {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  useEffect(() => { void listConversations({}).then(page => setConversation(page.items[0] ?? null)); }, []);
  if (!conversation) return <div className="p-4 text-text-dim">正在读 fixture 对话…</div>;
  /*
    中间栏那个宽度：对话视图真实的落点就是 720。写成可从 `?w=` 传，是因为**写死的宽度会
    把窄屏审查变成假阳性**——截图脚本把窗口调到 400 之后，溢出的是这个 720 的盒子本身，
    真正的响应式问题全被它盖住。`?w=full` 就是跟着窗口走。
  */
  const w = new URLSearchParams(location.search).get('w') ?? '720';
  return (
    <div className="h-screen border-r border-border" style={w === 'full' ? { width: '100%' } : { width: `${w}px` }}>
      <ConversationDetail conversation={conversation} readOnly />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><WorkspaceProvider><Fixture /></WorkspaceProvider></ThemeProvider></StrictMode>,
);
