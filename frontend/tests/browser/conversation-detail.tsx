/*
  把 `ConversationDetail` 单独画出来，看两件只有画出来才看得见的事：

  1. **hero 空态**（`conversation-hero.html`）——一条消息都没有的对话：输入卡在栏中央、
     标题那行在它上面、没有转录、没有拖宽条。要配 `FIXTURE_EMPTY=1` 起服务器。
  2. **输入卡下面那两颗会话级药丸**（默认）——仪表盘（n 轮 m 步，静态不可点）和
     数据库（总 token + 缓存命中，可点开弹层）。要配 `FIXTURE_LIVE=1` 才拿得到真输入卡。

  跑法：

      FIXTURE_EMPTY=1 FIXTURE_LIVE=1 node --import tsx frontend/tests/browser/conversation-ui-server.mts
      # 然后开 /tests/browser/conversation-detail.html 或 conversation-hero.html

  **两个模式是两个 html，不是一个 query 参数。** 截图脚本自己要往 url 尾巴上接 `?w=full`：
  再带一个 query 进来就拼成 `?empty=1?w=full`（`w` 解析不出来，宽度退回写死的 720，窄屏那
  一格量到的「溢出」全是这个盒子本身，一次假阳性），换成 hash 则是 `#empty?w=full`，既对
  不上又让 `Page.navigate` 只换 hash、`load` 事件根本不再触发。两条都试过。

  **不走 `ConversationLens`**：那一层属于 features/terminal，画的是中栏的全貌；这里要钉的
  两件事都在对话详情自己身上，少一层就少一处会挡住看点的东西。
*/
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationDetail } from '../../src/features/conversations/ConversationDetail';
import { listConversations, type Conversation } from '../../src/shared/api/conversations';
import { WorkspaceProvider } from '../../src/shared/store';
import { ThemeProvider } from '../../src/shared/theme';
import '../../src/index.css';

function Fixture() {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [missing, setMissing] = useState(false);
  const params = new URLSearchParams(location.search);
  const empty = location.pathname.includes('conversation-hero');
  useEffect(() => {
    void listConversations({ state: 'all' }).then(page => {
      /*
        空态那条认 `lastMessageAt === null`——那正是后端对「建了目录行、还没有任何记录」
        的表示法，不是 fixture 自己发明的标记。
      */
      const picked = empty
        ? page.items.find(item => item.lastMessageAt === null)
        : page.items.find(item => item.lastMessageAt !== null);
      if (picked) setConversation(picked); else setMissing(true);
    });
  }, [empty]);
  if (missing) {
    return (
      <div className="p-4 text-caption text-text-dim">
        没找到{empty ? '空' : '有消息的'}对话——空态那条要 <code>FIXTURE_EMPTY=1</code> 才会造出来。
      </div>
    );
  }
  if (!conversation) return <div className="p-4 text-text-dim">正在读 fixture 对话…</div>;
  /* 和 conversation-ui 同一条理由：写死的宽度会把窄屏审查变成假阳性，所以 `?w=full` 跟着窗口走。 */
  const w = params.get('w') ?? '720';
  return (
    <div className="h-screen border-r border-border" style={w === 'full' ? { width: '100%' } : { width: `${w}px` }}>
      <ConversationDetail conversation={conversation} onBack={() => {}} onJumpToTerminal={() => {}} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><WorkspaceProvider><Fixture /></WorkspaceProvider></ThemeProvider></StrictMode>,
);
