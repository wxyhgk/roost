import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowUturnLeftIcon, CommandLineIcon } from "@heroicons/react/24/outline";
import { useWorkspace } from "../../shared/store";
import { sessionTitle } from "../../shared/sessionTitle";
import { t } from "@roost/i18n";

/*
  顶栏这个按钮原来是个「+」，里面同时管三件事：新建终端、新建分组、重开已关闭的会话。

  前两件搬去了侧栏底部——那里现在是两个说清楚的按钮，而不是一个要点开才知道有什么的
  加号。**剩下的「重开」不能跟着一起删**：命令面板虽然也能重开，但它没有查询词时只列
  8 条、而且明确过滤掉已关闭的（`CommandPalette.tsx` 那一行），所以不输入关键词根本
  看不见它们——而「关了之后找不回来」正是这个入口存在的理由。

  于是它只剩一个职责，图标也跟着换掉；**没有可重开的会话时整个不渲染**，顶栏干净，
  有东西可捡的时候它才出现。
*/
export function ReopenMenu() {
  const { reopenSession, sessions } = useWorkspace("reopenSession", "sessions");
  const closed = sessions.filter((s) => s.closed);
  if (!closed.length) return null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          // 36px/20px：和顶栏其余按钮、以及左右两条图标栏对齐。它就挨着它们。
          className="grid h-9 w-9 place-items-center rounded-md text-bar-dim transition-colors hover:bg-bar-text/10 hover:text-bar-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text"
          title={t.newMenu.reopenTrigger}
          type="button"
          aria-label={t.newMenu.reopenTrigger}
        >
          <ArrowUturnLeftIcon className="size-5 shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="menu-pop z-50 min-w-60 rounded-lg border border-border bg-bg-raised p-1.5 shadow-pop outline-none"
        >
          <div className="px-2 pt-1 pb-0.5 text-caption uppercase tracking-[0.08em] text-text-dim">
            {t.newMenu.reopenHeading}
          </div>
          {closed.map((s) => (
            <DropdownMenuItem key={s.id} onClick={() => { reopenSession(s.id); }}>
              <CommandLineIcon className="size-4 shrink-0" />
              <span className="flex flex-col gap-px">
                <span>{sessionTitle(s)}</span>
                <span className="text-text-dim">{s.cwd}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function DropdownMenuItem({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <DropdownMenu.Item
      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-[7px] text-left outline-none data-[highlighted]:bg-bg-hover"
      onClick={onClick}
    >
      {children}
    </DropdownMenu.Item>
  );
}
