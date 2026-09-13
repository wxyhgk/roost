import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BookmarksDialog } from '../../src/features/bookmarks/BookmarksDialog';
import { BookmarkButton } from '../../src/features/bookmarks/BookmarkButton';
import { fetchBookmarkConversation } from '../../src/shared/api/bookmarks';
import type { Conversation } from '../../src/shared/api/conversations';
import '../../src/index.css';
import { WorkspaceProvider } from '../../src/shared/store';
import { ThemeProvider } from '../../src/shared/theme';
function Fixture() {
 const [open,setOpen]=useState(true);
 const [conversation,setConversation]=useState<Conversation|null>(null);
 return <div><button onClick={()=>setOpen(true)}>打开测试收藏</button><button onClick={()=>{void fetchBookmarkConversation('fixture-claude').then(setConversation);}}>加载收藏按钮</button>{conversation&&<BookmarkButton conversation={conversation}/>} {open&&<BookmarksDialog onClose={()=>setOpen(false)}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><ThemeProvider><WorkspaceProvider><Fixture/></WorkspaceProvider></ThemeProvider></StrictMode>);
