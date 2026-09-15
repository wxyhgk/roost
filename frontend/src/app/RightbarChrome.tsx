import {
  ArrowsPointingInIcon, ArrowsPointingOutIcon, ChevronDoubleRightIcon, ViewColumnsIcon, WindowIcon,
} from "@heroicons/react/24/outline";
import type { RightbarMode } from "../vendor/dsh/rightbar";
import { t } from "@roost/i18n";

/*
  右栏那排控制钮：换档 + 收起。

  **上游把这两颗放在停靠面的标签条末端**（`SidebarRight.tsx` 的 `PanelChrome`，
  254-287 行），因为它那条栏的整条上边缘就是 dockkit 的标签条，面板自己没有头。
  我们没有 dockkit，右面板有自己的 `PanelHeader`，所以挂在那个头的动作位上。

  **图标用 heroicons，没有照搬上游那两个 figma 抠出来的字形。** 那两个（`FullscreenGlyph`
  / `ExitFullscreenGlyph`）是纯内联 svg、完全可以逐字搬，但它们会是这一排里仅有的两个
  非 heroicons 字形，粗细和视觉重量对不上——同一排按钮里混两套图标族是画出来一眼就
  难看的那种问题。上游不存在这个问题：它整套 UI 都是自己那一族。
*/
export function RightbarChrome({ mode, autoFullscreen, onMode, onCollapse }: {
  /** 用户挑的那一档（不是夹逼后生效的那一档——按钮要反映用户的选择）。 */
  mode: RightbarMode;
  /** 框窄到 768 以下，三档被强制抬成全屏。这时换档钮没有意义。 */
  autoFullscreen: boolean;
  onMode: (mode: RightbarMode) => void;
  onCollapse: () => void;
}) {
  // 每次渲染重取：切换语言后标题要跟着变，不能缓存在模块顶层。
  const label = t.misc.rightPanel.chrome;
  const klass = "grid size-6 place-items-center rounded text-text-dim hover:bg-bg-hover hover:text-text";

  /*
    窄框下只有全屏一档，所以那两颗换档钮整个不画——画一颗按下去没反应的钮，比不画更糟。
    留下的「退出全屏」在这一档等于收起（上游 `PanelChrome` 266-269 行是同一个处置：
    `if (fullscreen && autoFullscreen) actions.setExpanded(sessionId, false)`）。
  */
  if (autoFullscreen) {
    return (
      <button type="button" className={klass} title={label.exitFullscreenNarrow}
        aria-label={label.exitFullscreenNarrow} onClick={onCollapse}>
        <ArrowsPointingInIcon className="size-4" />
      </button>
    );
  }

  const fullscreen = mode === "fullscreen";
  return (
    <>
      {/* 推挤 ↔ 悬浮。全屏档下这颗仍然在，按了就同时退出全屏并落到那一档。 */}
      <button type="button" className={klass}
        title={mode === "push" ? label.toFloat : label.toPush}
        aria-label={mode === "push" ? label.toFloat : label.toPush}
        aria-pressed={mode === "float"}
        onClick={() => { onMode(mode === "push" ? "float" : "push"); }}>
        {mode === "push" ? <WindowIcon className="size-4" /> : <ViewColumnsIcon className="size-4" />}
      </button>
      <button type="button" className={klass}
        title={fullscreen ? label.exitFullscreen : label.toFullscreen}
        aria-label={fullscreen ? label.exitFullscreen : label.toFullscreen}
        aria-pressed={fullscreen}
        /* 退出全屏落回推挤，而不是记住进全屏之前那一档：全屏保留着底下那条轨
           （见 presentation.ts），落回推挤时中栏一动不动；落回悬浮反而会让中栏弹一下。 */
        onClick={() => { onMode(fullscreen ? "push" : "fullscreen"); }}>
        {fullscreen ? <ArrowsPointingInIcon className="size-4" /> : <ArrowsPointingOutIcon className="size-4" />}
      </button>
      <button type="button" className={klass} title={label.collapse} aria-label={label.collapse} onClick={onCollapse}>
        <ChevronDoubleRightIcon className="size-4" />
      </button>
    </>
  );
}
