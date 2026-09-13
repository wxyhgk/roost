import { useRef, useState } from "react";

type Props = {
  value: string;
  displayValue?: string;
  className?: string;
  editing: boolean;
  onCommit: (value: string) => void;
  onEditingChange: (editing: boolean) => void;
  onDisplayClick?: () => void;
};

export function InlineRename({
  value,
  displayValue,
  className,
  editing,
  onCommit,
  onEditingChange,
  onDisplayClick,
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
    return <span className={className} title={value} onClick={onDisplayClick}>{displayValue ?? value}</span>;
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
      // The display style is also passed in by selected cards (white text on
      // the bar). Override it in edit mode so the dark input background keeps
      // the draft readable regardless of the parent card state.
      className={`w-full min-w-0 rounded border border-accent bg-bg-raised px-1 py-px !text-text caret-accent placeholder:text-text-dim outline-none ${className ?? ""}`}
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
