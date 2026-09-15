import { InboxIcon } from "@heroicons/react/24/outline";
import { useMemo } from "react";
import { useWorkspace } from "../../shared/store";
import { useInbox } from "../session-status/public";
import { t } from "@roost/i18n";

/**
 * 「有几个会话在等你」——左栏那个角标。
 *
 * **一个都没有时整个按钮不出现。** 这条跟着 `useGroupActivity` 顶上那句走：一列排下来全是
 * 没有信息的图标，反而把真正在等你的那一个淹掉了。它出现本身就是信号。
 *
 * 点它跳到**最该看的那一个**（`selectInbox` 已经排好：blocked 在前，同类按时间倒序）。
 * 这一版刻意不做列表——列表在 375px 和在桌面左栏是两种东西，等做手机首屏时一起做，
 * 那时它和这个按钮读的是同一个 `useInbox`。
 *
 * 跳转照 `Sidebar.openSession` 的成例拆开：**选中由这里自己做**（它本来就订阅着 store），
 * 而「把中栏切回终端」是布局状态、住在 app 层，只能由调用方传进来。Shell 不订阅 store——
 * 它是整棵树唯一稳定的落点，让它跟着工作区每次变化重渲染就毁了这条性质。
 */
export function InboxButton({ onEnterTerminal }: { onEnterTerminal: () => void }) {
  const { sessions, selectSession } = useWorkspace("sessions", "selectSession");
  // id 列表每次渲染都是新数组，而 useInbox 拿它的内容做键——这里先稳住引用。
  const ids = useMemo(() => sessions.map(session => session.id), [sessions]);
  const items = useInbox(ids);
  if (!items.length) return null;
  const first = items[0];
  return (
    <button
      type="button"
      title={t.misc.inbox.title(items.length)}
      aria-label={t.misc.inbox.title(items.length)}
      onClick={() => { selectSession(first.sessionId); onEnterTerminal(); }}
      className="relative grid h-9 w-9 place-items-center rounded-lg text-bar-dim transition-colors hover:bg-bar-text/10 hover:text-bar-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text"
    >
      <InboxIcon className="size-5" />
      {/*
        计数贴在右上角。用 accent 而不是 danger：有人在等你不是故障——红色在这套界面里
        是留给「出事了」的，见 SummaryRow 里「失败」和「已拒绝」那两个颜色的分工。
      */}
      <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-medium leading-4 text-bg">
        {items.length > 9 ? "9+" : items.length}
      </span>
    </button>
  );
}
