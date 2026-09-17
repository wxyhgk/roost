import { Empty } from "../../shared/ui/Empty";
import { t } from "@roost/i18n";
import { useSessionActivity } from "./useSessionActivity";
import type { AgentTask } from "./store";

/*
  agent 自己列的任务清单。

  它在终端里是 TodoWrite 的一次输出——**会滚走**。一条会话跑上十几分钟之后，那份
  清单早就在屏幕上面几千行的地方了，而它恰恰是「这一轮到底要做什么」唯一的结构化
  说明。所以钉在侧栏里：侧栏不滚。

  清单跨状态存活（见 backend/src/session-status.ts 里 SessionAgent.tasks 的注释）：
  agent 跑完了（done）那份清单依然是它做了什么的说明，只有换会话才重开一份。
*/

const MARK: Record<AgentTask["status"], string> = {
  // 进行中那一条用实心点加强调色，是这一栏里唯一需要一眼找到的东西。
  in_progress: "bg-accent",
  completed: "border border-text-dim/40 bg-text-dim/30",
  pending: "border border-text-dim/40",
};

export function TasksView({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) return <Empty title={t.session.tasks.noSession} hint={t.session.tasks.noSessionHint} />;
  return <TaskList sessionId={sessionId} />;
}

/** 单独一层，因为 hook 不能挂在上面那个提前返回的分支后面。 */
function TaskList({ sessionId }: { sessionId: string }) {
  const tasks = useSessionActivity(sessionId).agent?.tasks;
  if (!tasks?.length) return <Empty title={t.session.tasks.empty} hint={t.session.tasks.emptyHint} />;
  const done = tasks.filter((task) => task.status === "completed").length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-1.5 text-caption text-text-dim">
        {t.session.tasks.progress(done, tasks.length)}
      </div>
      <ol className="min-h-0 flex-1 overflow-auto py-1">
        {tasks.map((task, i) => (
          // 清单是快照，没有稳定 id；序号就是它此刻的身份。
          <li key={i} className="flex items-start gap-2 px-3 py-1">
            <span
              className={`mt-[0.4em] h-2 w-2 shrink-0 rounded-full ${MARK[task.status]}`}
              title={t.session.tasks.status[task.status]}
              aria-hidden
            />
            <span className={`min-w-0 break-words text-body leading-[1.45] ${
              task.status === "completed" ? "text-text-dim line-through decoration-text-dim/40" : "text-text"
            }`}>
              {task.text}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
