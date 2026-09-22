import { useEffect, useState } from "react";
import { fetchAiControl, type AiControl } from "../../shared/api/conversations";

/*
  TUI 输入框的镜像。

  **为什么要有它**：GUI 的输入框和 TUI 的输入框是同一个东西的两个视图，GUI 那一份是给人
  看的。看不见对面，「发送」就退化成往一个看不见的地方投递——于是才需要回执、不确定态、
  重试那一整套。看得见之后，那些东西大部分就不需要解释了：你直接看到字进没进去。

  轮询而不是推送：这份数据要走一次到 daemon 的 IPC，挂进按会话广播的状态流就是「每个会话
  每帧一次 IPC」，而镜像只对你正在看的那一条有意义。1 秒一次——它照的是输入框的**状态**，
  不是逐键回显，再快没有意义。

  页面不可见时停掉：后台标签页每秒打一次是纯浪费。
*/
const INTERVAL_MS = 1000;

export function useTuiComposer(terminalId: string | null): AiControl | null {
  const [control, setControl] = useState<AiControl | null>(null);
  useEffect(() => {
    if (!terminalId) { setControl(null); return; }
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        // 读失败不清空：短暂的网络抖动不该让镜像闪一下空白，上一帧比「什么都没有」准。
        try { const next = await fetchAiControl(terminalId); if (!cancelled) setControl(next); } catch { /* 保留上一帧 */ }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), INTERVAL_MS);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [terminalId]);
  return control;
}
