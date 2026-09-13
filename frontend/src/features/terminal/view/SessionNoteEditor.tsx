import { useRef, useState } from "react";
import { NOTE_MAX } from "../../../shared/api/session";
import { useWorkspace } from "../../../shared/store";
import { t } from "@roost/i18n";

/**
 * 就地编辑一条终端备注，占用卡片的预览位。
 *
 * 备注允许换行，一行输入框放不下；而预览位本来就是卡片上最大的一块空地，编辑完
 * 还回去。**不做单独的弹窗**：为一段两行的说明开一个模态框，比这段说明本身还重。
 */
export function SessionNoteEditor({ sessionId, note, onDone }: {
  sessionId: string;
  note: string | null;
  onDone: () => void;
}) {
  const { setSessionNote } = useWorkspace("setSessionNote");
  const [draft, setDraft] = useState(note ?? "");
  /*
    ⌘↵ 和 Esc 都会让卡片把这个编辑器卸载掉。**卸载时会不会再补一次 blur 是浏览器
    和 React 的实现细节，不能赌**——赌输的后果是 Esc 变成保存，正好和它的语义相反。
    用一个同步置位的标志显式关掉 blur 那条路。
  */
  const settled = useRef(false);

  function commit() {
    settled.current = true;
    // 只在真的变了才发请求：点开看一眼又关掉不该产生一次写入。
    const next = draft.trim() ? draft.trim() : null;
    if (next !== note) setSessionNote(sessionId, next);
    onDone();
  }

  function cancel() {
    settled.current = true;
    onDone();
  }

  return (
    <div className="flex h-full min-h-24 flex-col gap-1 bg-bg p-1.5">
      <textarea
        autoFocus
        value={draft}
        /*
          maxLength 的单位是 UTF-16 码元，和后端的校验单位完全一致（契约里点名对齐
          HTML maxlength）。所以这里不会出现「浏览器让你打完、服务端却退回 400」。
        */
        maxLength={NOTE_MAX}
        placeholder={t.session.notePlaceholder}
        onChange={e => setDraft(e.target.value)}
        // 卡片整体是拖拽源，不拦住指针事件的话，在输入框里选字会变成拖卡片。
        onPointerDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
          // 换行要留给备注本身，所以保存用 ⌘↵ —— 裸 Enter 在这里是打字，不是提交。
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
        }}
        // 已经由 ⌘↵ 或 Esc 收尾的话就别再插一手。
        onBlur={() => { if (!settled.current) commit(); }}
        className="min-h-0 w-full flex-1 resize-none rounded-md border border-accent bg-bg-raised px-1.5 py-1 text-caption leading-snug text-text caret-accent outline-none placeholder:text-text-dim/60"
      />
      <span className="shrink-0 text-center text-[10px] leading-3 text-text-dim/70">{t.session.noteHint}</span>
    </div>
  );
}
