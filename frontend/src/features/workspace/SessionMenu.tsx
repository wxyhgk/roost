import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState } from "react";
import { IconClose, IconCopy, IconDots, IconEdit, IconNote, IconPin } from "../../shared/icons";
import { IconButton } from "../../shared/ui/IconButton";
import { useWorkspace } from "../../shared/store";
import { writeClipboard } from "../../shared/clipboard";
import type { Session } from "../../shared/types";
import { t } from "@roost/i18n";

/**
 * 一个会话的操作入口：置顶、复制路径、重命名、结束。
 *
 * 外层容器必须带 `session-row` 类，`data-toolbar-open` 也要跟着 `open` 走——
 * index.css 里那套「悬停才显形、但触屏上常驻」的规则挂在这两个钩子上。
 * **触屏上没有悬停**，漏了这两个钩子的话，手机上这些动作根本够不着。
 */
export function SessionMenu({ session, onRename, onNote, onOpenChange }: {
  session: Session;
  /** 重命名由调用方起——输入框长在它自己的布局里。 */
  onRename: () => void;
  /** 编辑备注同理：编辑区长在卡片自己的预览位上。 */
  onNote: () => void;
  /** 菜单开着时外层要保持工具条可见，否则鼠标一移开菜单就连着关掉。 */
  onOpenChange: (open: boolean) => void;
}) {
  const { killSession, pinnedSessionIds, togglePin } =
    useWorkspace("killSession", "pinnedSessionIds", "togglePin");
  const pinned = pinnedSessionIds.includes(session.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current !== null) window.clearTimeout(copyTimer.current); }, []);
  useEffect(() => { onOpenChange(menuOpen || killOpen); }, [menuOpen, killOpen, onOpenChange]);

  return (
      <div
        className="session-toolbar z-20 flex shrink-0 items-center gap-px overflow-hidden rounded-md bg-transparent transition-opacity duration-150"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DropdownMenu.Root
          open={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (!open) {
              setCopied(false);
            }
          }}
        >
          <DropdownMenu.Trigger asChild>
            <IconButton
              title={t.session.more}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <IconDots />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              side="bottom"
              sideOffset={4}
              alignOffset={12}
              className="menu-fade z-50 min-w-52 rounded-xl border border-border bg-bg-panel p-1.5 shadow-pop outline-none"
            >
              <SessionMenuItem
                label={pinned ? t.session.unpin : t.session.pin}
                onSelect={() => togglePin(session.id)}
              >
                <IconPin active={pinned} />
              </SessionMenuItem>
              <SessionMenuItem
                label={copied ? t.session.copyCwdDone : t.session.copyCwd}
                onSelect={() => {
                  void (async () => {
                    if (!(await writeClipboard(session.cwd))) {
                      setCopied(false);
                      return;
                    }
                    setCopied(true);
                    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
                    copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
                  })();
                }}
              >
                <IconCopy />
              </SessionMenuItem>
              <SessionMenuItem label={t.session.rename} onSelect={() => onRename()}>
                <IconEdit />
              </SessionMenuItem>
              <SessionMenuItem
                label={session.note ? t.session.noteEdit : t.session.noteAdd}
                onSelect={() => onNote()}
              >
                <IconNote />
              </SessionMenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <DropdownMenu.Root open={killOpen} onOpenChange={setKillOpen}>
          <DropdownMenu.Trigger asChild>
            <IconButton
              title={t.session.kill}
              danger
              onPointerDown={(e) => e.stopPropagation()}
            >
              <IconClose />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              side="right"
              sideOffset={6}
              className="menu-fade z-50 w-56 rounded-xl border border-border bg-bg-panel p-2 shadow-pop outline-none"
            >
              <div className="px-2 pt-1.5 pb-0.5 text-body font-medium text-text">
                {t.session.killConfirm.title}
              </div>
              {/* 标题 text-body、说明 text-caption；两个按钮和同一张菜单里的
                  SessionMenuItem 一样是 text-body，原来它们比菜单项小 1px。 */}
              <div className="px-2 pb-2 text-caption leading-relaxed text-text-dim">
                {t.session.killConfirm.detail}
              </div>
              <div className="flex items-center justify-end gap-1.5 px-1 pb-1">
                <button
                  className="rounded-md px-2 py-1 text-body text-text-dim hover:bg-bg-hover"
                  onClick={() => setKillOpen(false)}
                >
                  {t.common.cancel}
                </button>
                <button
                  className="rounded-md bg-danger px-2 py-1 text-body font-medium text-white hover:brightness-110"
                  onClick={() => {
                    setKillOpen(false);
                    killSession(session.id);
                  }}
                >
                  {t.session.killConfirm.confirm}
                </button>
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
  );
}

function SessionMenuItem({
  children,
  label,
  danger,
  keepOpenOnSelect,
  onSelect,
}: {
  children: React.ReactNode;
  label: string;
  danger?: boolean;
  keepOpenOnSelect?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      className={`flex w-full cursor-pointer select-none items-center gap-2.5 rounded-md px-2 py-[7px] text-left text-body outline-none data-[highlighted]:bg-bg-hover ${
        danger ? "text-danger" : "text-text"
      }`}
      onSelect={(e) => {
        if (keepOpenOnSelect) e.preventDefault();
        onSelect();
      }}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center">{children}</span>
      {label}
    </DropdownMenu.Item>
  );
}
