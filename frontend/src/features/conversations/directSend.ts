import { t } from "@roost/i18n";
import type { DirectInputResult } from "@roost/terminal-protocol";

/**
 * 「直接打进终端」的一次结果，界面上该怎么说、怎么做。
 *
 * 这条路取代了排队投递（见 terminal-daemon/src/direct-input.ts 顶上）。它的结果**只描述这一句**：
 * 没有待发列表、没有「前面有一条还没确认」——一句没发成，下一句照样发。
 *
 * 三件事要分开判断，写成纯函数逐条测：
 * - **清不清空输入框**：已经进了终端（按了回车，或者至少贴进去了）就清空，否则留着让人改完再发。
 *   只贴没按回车时正文就停在终端的输入框里，这边再留一份，下次一点发送就是同一句话发两遍。
 * - **给不给「去终端」**：只有需要你去终端里做点什么时才给。
 * - **语气**：发成了是一闪而过的确认；其余要停在那里等人看见。
 */
export type DirectNotice = { tone: "ok" | "warn"; text: string; clear: boolean; jump: boolean };

export function noticeOf(result: DirectInputResult): DirectNotice {
  const s = t.misc.conversations.detail.send.direct;
  switch (result.status) {
    case "submitted": return { tone: "ok", text: s.submitted, clear: true, jump: false };
    case "pasted": return { tone: "warn", text: s.pasted, clear: true, jump: true };
    case "held": {
      const reason = result.reason;
      return {
        tone: "warn",
        text: s.held[reason] ?? s.heldOther,
        clear: false,
        // 选择框和找不到输入框都要你去终端看；shell 在前台、看不清画面，去了也没什么可做。
        jump: reason === "dialog" || reason === "no_input_box",
      };
    }
  }
  /*
    后端加了一种新结果、这里还不认识：什么都不假设。不清空（正文可能没发出去），
    也不宣布成功。
  */
  return { tone: "warn", text: s.heldOther, clear: false, jump: true };
}
