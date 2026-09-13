import { useEffect, useRef } from "react";
import { isOpen, useWorkspace } from "../../shared/store";
import { sessionTitle } from "../../shared/sessionTitle";
import { createCompletionTracker } from "./completion";
import { sessionStatus } from "./runtime";
import type { SessionAgent } from "./store";
import { t } from "@roost/i18n";

function beep() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    void ctx.resume().catch(() => undefined);
    const t = ctx.currentTime;
    [880, 660].forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      o.type = "sine";
      const start = t + i * 0.15;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(start);
      o.stop(start + 0.16);
    });
    window.setTimeout(() => void ctx.close().catch(() => undefined), 600);
  } catch {
    // 声音失败不影响标题和系统通知
  }
}

/**
 * 系统通知的实测显示上限。超出的部分不是被折行，是被平台直接切掉，
 * 所以宁可自己带省略号截断，也不要把一句话交给平台拦腰砍断。
 */
const MAX_TITLE_LENGTH = 40;
const MAX_BODY_LENGTH = 120;
const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max - 1) + "…");

/**
 * blocked 时通知里写什么。agent 自己拼好的整句最准，优先用；
 * 拿不到就用工具名和入参自己拼；再拿不到才退回「需要你批准」这种通用句。
 */
function blockedBody(agent: SessionAgent | null): string {
  const summary = agent?.summary?.trim();
  if (summary) return summary;
  const tool = agent?.toolName?.trim();
  const input = agent?.toolInputPreview?.trim();
  if (tool) return input ? t.session.agent.notifyTool(tool, input) : t.session.agent.notifyToolOnly(tool);
  return agent?.waitingFor === "question" ? t.session.agent.notifyQuestion : t.session.agent.notifyPermission;
}

// 明确的 AI 完成状态才播放提示音；阻塞只显示提醒。
// 正在注视该会话（可见+聚焦+选中）则免打扰；选中或回窗即清 badge。
export function useAgentNotify() {
  const { sessions, selectedId, selectSession } = useWorkspace("sessions", "selectedId", "selectSession");
  const stateRef = useRef({ sessions, selectedId, selectSession });
  stateRef.current = { sessions, selectedId, selectSession };
  const pendingRef = useRef<Set<string>>(new Set());
  const baseTitleRef = useRef<string | null>(null);

  function paintTitle() {
    if (baseTitleRef.current === null) baseTitleRef.current = document.title;
    const n = pendingRef.current.size;
    document.title = n > 0 ? t.misc.quiet.title(n, baseTitleRef.current) : baseTitleRef.current;
  }

  useEffect(() => {
    if (selectedId && pendingRef.current.delete(selectedId)) paintTitle();
  }, [selectedId]);

  useEffect(() => {
    const clear = () => {
      if (pendingRef.current.size > 0) {
        pendingRef.current.clear();
        paintTitle();
      }
    };
    window.addEventListener("focus", clear);
    return () => window.removeEventListener("focus", clear);
  }, []);

  const notify = useRef((id: string, title: string, body: string, sound = false) => {
    const { sessions: all, selectedId: sel, selectSession: select } = stateRef.current;
    const s = all.find((x) => x.id === id && isOpen(x));
    if (!s) return;
    // 正在注视这个会话就不用打扰。
    if (document.visibilityState === "visible" && document.hasFocus() && sel === id) return;
    pendingRef.current.add(id);
    paintTitle();
    if (sound) beep();
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        const n = new Notification(clip(title, MAX_TITLE_LENGTH), { body: clip(body, MAX_BODY_LENGTH), tag: id, silent: true });
        n.onclick = () => { window.focus(); select(id); n.close(); };
      } catch {
        // 标题已更新；提示音由完成状态单独控制
      }
    }
  });

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
  }, []);

  // 完成和等待回应分别通知，静默时长只用于会话行的活动显示。
  const completionRef = useRef(createCompletionTracker());
  const blockedRef = useRef<Set<string>>(new Set());
  const openIds = sessions.filter(isOpen).map((s) => s.id).join(",");
  useEffect(() => {
    const ids = openIds ? openIds.split(",") : [];
    completionRef.current.retain(ids);
    for (const id of blockedRef.current) if (!ids.includes(id)) blockedRef.current.delete(id);
    const check = (id: string) => {
      const view = sessionStatus.read(id);
      const agent = view.agent;
      const completed = completionRef.current.observe(id, view);
      const blocked = agent?.state === "blocked";
      if (completed) {
        const s = stateRef.current.sessions.find(x => x.id === id && isOpen(x));
        if (s) notify.current(id, t.misc.quiet.notifyTitle(sessionTitle(s)), t.misc.quiet.notifyBody(s.cwd), true);
      }
      if (blocked === blockedRef.current.has(id)) return;
      if (!blocked) {
        // 你已经回应了：把这条从待办里摘掉，别让角标一直挂着。
        blockedRef.current.delete(id);
        if (!completed && pendingRef.current.delete(id)) paintTitle();
        return;
      }
      blockedRef.current.add(id);
      const s = stateRef.current.sessions.find((x) => x.id === id && isOpen(x));
      if (!s) return;
      notify.current(id, t.session.agent.notifyTitle(sessionTitle(s)), blockedBody(agent));
    };
    const stops = ids.map((id) => { check(id); return sessionStatus.subscribe(id, () => check(id)); });
    return () => stops.forEach((stop) => stop());
  }, [openIds]);
}
