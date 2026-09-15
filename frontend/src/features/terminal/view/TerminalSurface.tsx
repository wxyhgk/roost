import { useEffect, type ReactNode } from "react";
import { TermView } from "./TermView";
// 舞台的机制写在 `session/terminalStage`；这张**实例**装在认识真引擎的 sessionRuntime 里。
import { terminalStage } from "../session/sessionRuntime";
import { useWorkspace } from "../../../shared/store";
import { Empty } from "../../../shared/ui/Empty";
import { t } from "@roost/i18n";

/**
 * 把某个会话**活着的那块终端画面**画在这个组件所在的位置。
 *
 * 界面有两个落点：「终端」模式下它是中栏，「对话」模式下它是右侧的停靠面。同一时刻只会
 * 有一个落点挂着它，而**换落点不许重建**——xterm 的滚动缓冲、渲染器、PTY 连接都在引擎
 * 那边，重建等于把整屏内容丢掉、还要向服务端重放一遍。做得到这一点是因为引擎和它的宿主
 * div 根本不归这棵 React 树所有，见 `session/terminalStage`：这里挂的只是一个空落点。
 *
 * 两条不那么显然的性质：
 *
 * 1. **所有打开的会话都常驻挂着 `TermView`**，不是只挂选中那个——别人的终端不能因为你
 *    切了个视角就被卸掉（那会丢掉它的滚动缓冲）。`sessionId` 只决定谁是前台：前台那个
 *    可见、拿键盘、按当前尺寸重算，其余的照常收输出。
 * 2. `sessionId` 为 null 是「此刻没有要看的终端」，不是「没有终端」：画布视角、对话视角
 *    都会传 null，而那时候终端只是被上面那层盖住了。
 */
export function TerminalSurface({ sessionId }: { sessionId: string | null }): ReactNode {
  const { sessions, patchCwd, patchCli } = useWorkspace("sessions", "patchCwd", "patchCli");
  /*
    **所有**打开的会话都要挂，不能按工作区筛。切换工作区只是换个看法，不该把别处正在跑的
    终端卸掉。（筛的只有画布上的卡片，那是 SessionCanvas 的事。）
  */
  const openSessions = sessions.filter((s) => !s.closed);

  /*
    关掉的终端要连引擎一起收掉。卸载不再销毁引擎了（那正是换落点能不丢内容的原因），
    所以「这个会话没了」这件事必须显式告诉舞台，否则它的 WebSocket 和滚动缓冲会一直留着。
    按**当前还开着哪些**来扫，而不是在某个 close 回调里逐个通知：真正的判据就是这份名单，
    而且刷新、别处关掉、后端回收都能被同一条路兜住。
  */
  useEffect(() => { terminalStage.retain(openSessions.map((s) => s.id)); });

  return (
    <>
      {/*
        没有前台终端时的空态。它落在 TermView 底下（那些是 absolute），所以画布 / 对话
        这类盖在上面的视角看不见它；真正会看到的是「一个终端都没有」和右侧停靠面空着这两档。
      */}
      {!sessionId && (
        <div className="m-auto">
          <Empty title={t.terminal.pane.emptyTitle} hint={t.terminal.pane.emptyHint} />
        </div>
      )}
      {openSessions.map((item) => (
        <TermView
          key={item.id}
          sessionId={item.id}
          /*
            active 的含义是「此刻是不是前台」。切成前台会走一遍 setActive(true)——重新申请
            WebGL、按当前尺寸重算、整屏重绘、接回键盘焦点；反过来 setActive(false) 会交出
            键盘，按键就不会再漏进底下的 PTY。这只影响前台身份，**不影响连接**：后台终端
            照常收输出。
          */
          active={item.id === sessionId}
          onCwd={(cwd) => patchCwd(item.id, cwd)}
          onCli={(cli, cliId) => patchCli(item.id, cli, cliId)}
        />
      ))}
    </>
  );
}
