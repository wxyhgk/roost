import { useRef, useState, type MouseEvent } from "react";

/** 菜单按钮、输入框这些自己有含义的元素，双击不该被改名接管。 */
const interactive = (target: EventTarget | null) =>
  !!(target as HTMLElement | null)?.closest("button, input, textarea, a, select");

/**
 * 双击标题改名。
 *
 * **必须同时挡住 mousedown。** 选中文字是浏览器在「第二次 mousedown」上做的事，
 * 而 dblclick 在那之后才触发——只在 dblclick 里 preventDefault 是来不及的，
 * 双击改名会连带把卡片上的字选蓝一片。
 *
 * 只挡双击的那一下，所以正常的按住拖选仍然可用；也不用 `select-none` 整片关掉，
 * 那样标题和路径就再也复制不了了。
 *
 * 挂在标题这个 span 上、而不是外面那张卡上，有个额外的好处：卡片外层往往挂着
 * dnd-kit 的 `drag.listeners`，而它的激活器恰好也叫 `onMouseDown`——同元素上会互相
 * 覆盖。挂在子元素上则两边都能收到（冒泡），不用手工串联。
 */
function doubleClickToEdit(start: () => void) {
  return {
    onMouseDown(event: MouseEvent<HTMLElement>) {
      if (event.detail > 1 && !interactive(event.target)) event.preventDefault();
    },
    onDoubleClick(event: MouseEvent<HTMLElement>) {
      if (interactive(event.target)) return;
      event.stopPropagation();
      start();
    },
  };
}

type Props = {
  value: string;
  displayValue?: string;
  className?: string;
  editing: boolean;
  onCommit: (value: string) => void;
  onEditingChange: (editing: boolean) => void;
  onDisplayClick?: () => void;
  /**
   * 双击标题进入编辑。
   *
   * 默认关着：TopBar 的标题是**单击**就改名（onDisplayClick），再叠一层双击没有意义；
   * 文件树只在编辑态才挂这个组件，展示态是它自己的按钮。
   */
  editOnDoubleClick?: boolean;
};

export function InlineRename({
  value,
  displayValue,
  className,
  editing,
  onCommit,
  onEditingChange,
  onDisplayClick,
  editOnDoubleClick,
}: Props) {
  const [draft, setDraft] = useState(value);
  const [wasEditing, setWasEditing] = useState(editing);
  /*
    Enter 和 Esc 都会让父组件把这个输入框卸载掉。**卸载时会不会再补一次 blur，是
    浏览器和 React 的实现细节，不能赌**——赌输的后果是 Esc 变成保存，正好和它的
    语义相反。所以用一个同步置位的标志显式关掉 blur 那条路。
  */
  const settled = useRef(false);

  /*
    草稿只在**进入编辑的那一刻**装载一次，之后不再跟着 value 走。

    跟着走会丢字：卡片传进来的 value 是 sessionTitle(session)，对默认命名的会话
    是从 cwd 推出来的，而后台每 4 秒轮询一次会更新 cwd。于是你正在改名、终端里
    恰好 cd 了一下，输入的字就被悄悄覆盖了。

    在渲染中调整状态（而不是放进 effect）是为了避免闪一帧旧内容——这是 React
    官方给「状态需要随 prop 变化重置」推荐的写法。
  */
  if (editing !== wasEditing) {
    setWasEditing(editing);
    if (editing) { setDraft(value); settled.current = false; }
  }

  if (!editing) {
    return (
      <span
        className={className}
        title={value}
        onClick={onDisplayClick}
        {...(editOnDoubleClick ? doubleClickToEdit(() => onEditingChange(true)) : {})}
      >
        {displayValue ?? value}
      </span>
    );
  }

  function close(commit: boolean) {
    settled.current = true;
    if (commit) {
      const next = draft.trim() || value;
      if (next !== value) onCommit(next);
    }
    onEditingChange(false);
  }

  return (
    <input
      /*
        编辑态和展示态**占完全相同的盒子**，一个像素都不许差。

        原来输入框比那段文字多出 1px 边框和 px-1/py-px 的内边距：进入编辑时整行长高
        4px、文字往右跳 5px。改个名字而已，周围的东西不该动——而且文字位移会让人觉得
        自己点错了地方。

        所以不加边框、不加内边距（`border-0 p-0` 是显式声明，不赌 preflight 的默认
        值），可见的那圈提示改用 ring：它是 box-shadow 实现的，永远不参与布局。
        字号行高由外面传进来的 className 决定，和展示态用的是同一份。

        选中的卡片会传进浅色文字（深色条上的白字），编辑态要盖掉它——深色输入背景上
        白字看不清，所以 `!text-text`。
      */
      className={`w-full min-w-0 rounded-[3px] border-0 bg-bg-raised p-0 ring-1 ring-accent !text-text caret-accent placeholder:text-text-dim outline-none ${className ?? ""}`}
      value={draft}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); close(true); }
        if (event.key === "Escape") { event.preventDefault(); close(false); }
      }}
      // 已经由 Enter/Esc 收尾的话，这里什么都不做——否则会重复提交，或者把
      // Esc 撤销掉的内容再存回去。
      onBlur={() => { if (!settled.current) close(true); }}
    />
  );
}
