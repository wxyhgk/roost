import type { ToolBlock } from "./SummaryRow";
import { stateOf } from "./dispatch";
import { resolveToolErrorSummary } from "../../../vendor/happier/chat/tool/presentation/resolveToolErrorSummary";

/**
 * 「这次失败的调用，摘要位上写哪一行」——一行纯文本，或者 null。
 *
 * 和 registry.tsx 分开、而且不带一个字的 JSX，理由和 dispatch.ts 顶上那段一样：
 * `node --test` 加载不了 CSS Module，判定跟着进 JSX 就一条都测不到。
 *
 * **拿不出可靠的一行时返回 null，不编。** 摘要位空着只是少一句话；填进去一坨
 * `ESC[1;31m` 或者半截 JSON，是在错误信息的位置上放一个更难读的东西。
 */

/** 挤不出可见字符就当没有——空串和 null 在调用方那里是同一件事，统一成 null。 */
function orNull(line: string | null): string | null {
  const trimmed = line?.trim() ?? "";
  return trimmed || null;
}

/**
 * 结果整段就是一个 JSON 对象时，把它解出来再交给上游函数。
 *
 * 不解的话，`{"error":"ENOENT: no such file"}` 这种输出会原样进摘要位——上游那条
 * 「result 本身是字符串」的分支只会切第一行，而第一行就是整坨花括号。解出来之后
 * `error` / `error.message` / `message` / `content` 这几条分支才轮得到，而它们正是
 * 这个函数最值钱的部分。这和 SummaryRow 的参数区、`toolSummary()` 是同一条取舍：
 * **解得出结构就别把花括号倒给人看。**
 *
 * 只认对象，不认数组和标量：`[1,2,3]` 解出来也挤不出错误字段，白走一趟。
 */
function asJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    // 被上游截断的半截 JSON 会走到这里。当普通文本处理，不是错误。
    return null;
  }
}

/**
 * 从一次工具调用里挤出一行错误摘要，挤不出就 null。
 *
 * **只对真的失败成立。** 成功、还在跑、被拒绝三种状态一律 null——判定直接用
 * `stateOf()`，不自己再数一遍 `failed` / `denied`。尤其是拒绝：那是一次「没让它跑」，
 * 它的 result 里可能写着 "User rejected"，放进错误摘要位就是报告一个没发生过的故障。
 *
 * 剥 ANSI 发生在上游那个函数的 `firstLine()` 里（标着 ROOST-CHANGE），不在这里重复。
 */
export function toolErrorSummary(block: ToolBlock): string | null {
  if (stateOf(block) !== "error") return null;
  const result = block.result;
  if (typeof result !== "string" || !result.trim()) return null;

  const json = asJsonObject(result);
  if (json) {
    const structured = orNull(resolveToolErrorSummary({ result: json }));
    if (structured) return structured;
    // 解出来了但没有任何错误字段（`{"count":0}` 这种）：不算失败，落回原文那条路——
    // 那毕竟是这次调用真实的输出，不是我们编的。
  }
  return orNull(resolveToolErrorSummary({ result }));
}
