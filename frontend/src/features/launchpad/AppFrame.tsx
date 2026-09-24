/*
  窗口里的一个本机应用。

  **同源的 iframe 不是安全边界。** 被代理的应用跑在 roost 自己的源上（反代就挂在
  `/api/app/<端口>/`），所以里面的脚本能拿着你的会话调 roost 的接口，也够得到
  `parent.document`。`sandbox="allow-scripts allow-same-origin"` 这种写法在同源下等于
  没加，所以这里不写一个会让人误以为有防护的属性。

  真要隔离，唯一的办法是换一个源（另开一个端口），那是独立的一件事。在那之前，
  「开成窗口」是**可选动作**——启动台默认走新标签页，这条留给你自己起的那些服务。
*/
import { useState } from 'react';
import { t } from '@roost/i18n';
import { appUrl } from './apps';

export function AppFrame({ port, name }: { port: number; name: string }) {
  const m = t.misc.launchpad;
  /*
    换一次 key 就是重新加载一次。iframe 没有可靠的「刷新」接口——改 src 会往浏览器的
    后退历史里塞一条，而 contentWindow.location.reload() 在跨源时会抛（这里虽然同源，
    但不该依赖那个前提）。重建元素最干净。
  */
  const [generation, setGeneration] = useState(0);
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-2 py-1 text-caption text-text-dim">
        <span className="min-w-0 flex-1 truncate font-mono">{appUrl(port)}</span>
        <button type="button" className="rounded px-1.5 hover:bg-bg-hover hover:text-text"
          onClick={() => setGeneration(value => value + 1)}>{m.reload}</button>
        {/*
          「在标签页打开」在这里也留一个：应用一旦要用全屏（比如 Jupyter 的编辑器），
          窗口就太小了，而这时候人已经在窗口里，不该让他回启动台重找一遍。
        */}
        <a className="rounded px-1.5 hover:bg-bg-hover hover:text-text" href={appUrl(port)}
          target="_blank" rel="noreferrer">{m.openTab}</a>
      </div>
      <iframe key={generation} src={appUrl(port)} title={name}
        className="min-h-0 flex-1 border-0 bg-white" />
    </div>
  );
}
