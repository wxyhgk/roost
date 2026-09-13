import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion } from "framer-motion";
import { FolderIcon, PlusIcon, CommandLineIcon } from "@heroicons/react/24/outline";
import { useWorkspace } from "../../shared/store";
import { sessionTitle } from "../../shared/sessionTitle";
import type { Scope } from "../../shared/view";
import { t } from "@roost/i18n";

export function NewMenu({ scope }: { scope: Scope }) {
  const { addSession, addProject, reopenSession, sessions } = useWorkspace("addSession", "addProject", "reopenSession", "sessions");
  const closed = sessions.filter((s) => s.closed);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="grid h-8 w-8 place-items-center rounded-md text-bar-dim transition-colors hover:bg-bar-text/10 hover:text-bar-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bar-text"
          title={t.newMenu.trigger}
          type="button"
          aria-label={t.newMenu.trigger}
        >
          <PlusIcon className="size-4 shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <AnimatePresence>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-60 rounded-lg border border-border bg-bg-raised p-1.5 shadow-pop outline-none"
            asChild
          >
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
            >
              <DropdownMenuItem
                onClick={() => {
                  // 和画布上那个「新建终端」落在同一处：你正在看的工作区。
                  // 两个入口同一个动作，结果不能不一样。
                  addSession(scope === "all" ? null : scope);
                }}
              >
                <CommandLineIcon className="size-4 shrink-0" />
                {t.newMenu.terminal}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  addProject();
                }}
              >
                <FolderIcon className="size-4 shrink-0" />
                {t.newMenu.project}
              </DropdownMenuItem>
              {closed.length > 0 && (
                <>
                  <div className="mx-1 my-1.5 h-px bg-border" />
                  <div className="px-2 pt-1 pb-0.5 text-caption uppercase tracking-[0.08em] text-text-dim">
                    {t.newMenu.reopenHeading}
                  </div>
                  {closed.map((s) => (
                    <DropdownMenuItem
                      key={s.id}
                      onClick={() => {
                        reopenSession(s.id);
                      }}
                    >
                      <CommandLineIcon className="size-4 shrink-0" />
                      <span className="flex flex-col gap-px">
                        <span>{sessionTitle(s)}</span>
                        <span className="text-text-dim">{s.cwd}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </motion.div>
          </DropdownMenu.Content>
        </AnimatePresence>
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
