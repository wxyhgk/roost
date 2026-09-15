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
 * `variant="card"`（默认，画布卡片用）时外层容器必须带 `session-row` 类，
 * `data-toolbar-open` 也要跟着 `open` 走——index.css 里那套「悬停才显形、但触屏上常驻」
 * 的规则挂在这两个钩子上。**触屏上没有悬停**，漏了这两个钩子的话，手机上这些动作根本够不着。
 *
 * `variant="row"` 是侧栏那条 32px 上游行的行尾座位（`SessionRow` 的 `menu` prop）。
 * 那一侧的显形由**上游的 `.rowActions`** 管（hover 或 `menuOpen` 才 `display: inline-flex`），
 * 所以这个变体不戴 `session-toolbar` 那件外衣——两套显形规则叠在一起，结果是两边的
 * 条件要同时成立才看得见。**代价是触屏上侧栏行里够不着这两颗**：`.rowActions` 只认 hover，
 * 而那条规则在 `vendor/dsh` 里（要保持逐字）、补丁要写进 `index.css`（这一轮不动那个文件）。
 * 触屏上这四个动作仍然在画布卡片上——那里的 `session-row` 规则一个字没改。
 *
 * 按钮尺寸也跟着变体走：卡片上是常规 `IconButton`，行里是 16px 的裸图标——照上游
 * `Rows.module.css` 的 `.iconButton`（无底色、tertiary 灰、hover 转 primary）描的，
 * 因为那个类名隔着 CSS Module 够不着（`RowIconButton` 存在的正是这个理由，但 Radix 的
 * `asChild` 要求子元素转发 ref 和任意 props，它不转发）。
 */
export function SessionMenu({ session, onRename, onNote, onOpenChange, variant = "card" }: {
  session: Session;
  /** 重命名由调用方起——输入框长在它自己的布局里。 */
  onRename: () => void;
  /** 编辑备注同理：编辑区长在卡片自己的预览位上。 */
  onNote: () => void;
  /** 菜单开着时外层要保持工具条可见，否则鼠标一移开菜单就连着关掉。 */
  onOpenChange: (open: boolean) => void;
  /** 画布卡片上的工具条，还是侧栏行尾那个座位。 */
  variant?: "card" | "row";
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

  const row = variant === "row";
  /*
    行里的两颗按钮：16px 裸图标，间距自己给——外面那层 `.rowActions` 的 12px 只隔直接子元素。

    **尺寸写死 px，不用 `h-4`。** 这个应用的根字号不是 16（实测 13），而 Tailwind 的间距
    刻度是 rem 的，`h-4` 在这儿会算成 13px；上游 `.iconButton` 那 16 是绝对像素。
  */
  const rowButton = "grid h-[16px] w-[16px] shrink-0 place-items-center rounded-[4px] text-text-dim hover:text-text";

  return (
      <div
        className={row
          ? "z-20 flex shrink-0 items-center gap-2"
          : "session-toolbar z-20 flex shrink-0 items-center gap-px overflow-hidden rounded-md bg-transparent transition-opacity duration-150"}
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
            {row ? (
              /* 行里的按钮必须自己吞掉 click：外面那条上游的行整行都是 onOpen。 */
              <button type="button" className={rowButton} title={t.session.more} aria-label={t.session.more}
                onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                <IconDots />
              </button>
            ) : (
              <IconButton
                title={t.session.more}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <IconDots />
              </IconButton>
            )}
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
            {row ? (
              <button type="button" className={`${rowButton} hover:text-danger`} title={t.session.kill}
                aria-label={t.session.kill}
                onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                <IconClose />
              </button>
            ) : (
              <IconButton
                title={t.session.kill}
                danger
                onPointerDown={(e) => e.stopPropagation()}
              >
                <IconClose />
              </IconButton>
            )}
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
              <div className="px-2 pb-2 text-xs leading-relaxed text-text-dim">
                {t.session.killConfirm.detail}
              </div>
              <div className="flex items-center justify-end gap-1.5 px-1 pb-1">
                <button
                  className="rounded-md px-2 py-1 text-xs text-text-dim hover:bg-bg-hover"
                  onClick={() => setKillOpen(false)}
                >
                  {t.common.cancel}
                </button>
                <button
                  className="rounded-md bg-danger px-2 py-1 text-xs font-medium text-white hover:brightness-110"
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
