import { useEffect, useRef } from "react";
import { InlineRename } from "../../shared/ui/InlineRename";
import { IconFolder } from "../../shared/icons";
import { FileIcon } from "./FileGlyphs";
import type { NewKind } from "./types";
import { t } from "@roost/i18n";

/**
 * 待命名的新条目，**就地**长在它将要落进的那个目录里。
 *
 * 原来这一行住在面板顶上：右键深处某个文件夹新建，输入框却出现在最上方，还得靠一行
 * 「创建在 xxx」的小字告诉你东西会掉到哪。落点和输入框分开两处，是这次改掉的东西。
 *
 * 缩进和普通行用同一个公式（`8 + depth * 14`），所以它排进去像是本来就在那儿。
 *
 * 直接复用 InlineRename 而不是另写一个输入框：它的语义正好就是要的那套——空内容
 * 回车不提交（`draft.trim() || value`，而这里 value 是空串，相等就不 onCommit）、
 * Esc 取消、失焦提交，和 Finder / VS Code 一致。顺带边框和行高也和改名时一模一样。
 */
export function NewEntryRow({ depth, kind, error, onCommit, onCancel }: {
  depth: number;
  kind: NewKind;
  error: string | null;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const label = kind === "dir" ? t.files.menu.newFolder : kind === "mol" ? t.files.menu.newMolecule : t.files.menu.newFile;
  /*
    InlineRename 在提交之后也会喊一声 onEditingChange(false)，而那条路通向 onCancel。
    不拦住的话，创建失败（重名、非法字符）时这一行会先被收掉，错误信息随后才到——
    等于报错了却没地方显示，用户也没得改。所以提交过就不当成取消。

    出错之后要把这个标记放回去：那时行还在、内容还在，Esc 和失焦应当恢复成取消。
  */
  const committed = useRef(false);
  useEffect(() => { if (error) committed.current = false; }, [error]);
  return (
    <li>
      <div className="flex w-full items-center gap-1.5 rounded px-2 py-1" style={{ paddingLeft: 8 + depth * 14 }}>
        <span className="w-3" />
        {kind === "dir" ? <IconFolder /> : <FileIcon name={kind === "mol" ? "new.mol" : "new.txt"} />}
        <InlineRename
          value=""
          editing
          onCommit={(name) => { committed.current = true; onCommit(name); }}
          onEditingChange={(editing) => { if (!editing && !committed.current) onCancel(); }}
          className="text-body"
        />
      </div>
      {error && (
        <div className="px-2 pb-1 text-caption text-danger" style={{ paddingLeft: 8 + depth * 14 }}>{error}</div>
      )}
      <span className="sr-only">{label}</span>
    </li>
  );
}
