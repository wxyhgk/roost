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
  // 中间栏那个宽度：对话视图真实的落点就是这么宽。
  return <div className="h-screen w-[720px] border-r border-border"><ConversationDetail conversation={conversation} readOnly /></div>;
}
createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><WorkspaceProvider><Fixture /></WorkspaceProvider></ThemeProvider></StrictMode>,
);
