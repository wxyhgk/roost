import { t } from "@roost/i18n";
import type { TurnStatTranslate } from "../../vendor/dsh/chat/TurnUsagePanel";

/**
 * 回合统计面板的 `t`。
 *
 * **它收的是一个函数不是一个对象**——那两个组件把 `t` 当值传进五个格式化函数，拍平成
 * 平字符串就要把那些调用点全搬到调用方，等于重写而不是搬运（文件头有说明）。所以这里
 * 做的是「键 → 我们的文案」的映射。
 *
 * 模块级常量：组件没 memo，每次渲染换一个函数身份会让内部的格式化白算一遍。
 */
const u = t.misc.conversations.detail.turnUsage;
const d = t.misc.conversations.detail.turnTime;
const n = t.misc.conversations.detail.number;
const dur = t.misc.conversations.detail.duration;

export const TURN_STAT: TurnStatTranslate = (key, params = {}) => {
  switch (key) {
    case "message.turnUsage.count": return u.count(params.count ?? "");
    case "message.turnUsage.consumed": return u.consumed(params.total ?? "");
    case "message.turnUsage.title": return u.title;
    case "message.turnUsage.model": return u.model;
    case "message.turnUsage.cacheHit": return u.cacheHit;
    case "message.turnUsage.input": return u.input;
    case "message.turnUsage.cacheRead": return u.cacheRead;
    case "message.turnUsage.cacheWrite": return u.cacheWrite;
    case "message.turnUsage.output": return u.output;
    case "message.turnUsage.reasoning": return u.reasoning(params.tokens ?? "");
    case "message.ranFor": return t.misc.conversations.detail.ranFor(params.duration ?? "");
    case "message.tokensPerSecond": return t.misc.conversations.detail.tokensPerSecond(params.tps ?? "");
    case "message.turnTime.title": return d.title;
    case "message.turnTime.duration": return d.duration;
    case "message.turnTime.speed": return d.speed;
    case "message.turnTime.ttft": return d.ttft;
    case "number.thousand": return n.thousand(params.value ?? "");
    case "number.million": return n.million(params.value ?? "");
    case "number.groupSeparator": return n.groupSeparator;
    // 三个时长键的参数是「这一档 + 下一档」，组件按需只给它需要的那些。
    case "duration.seconds": return dur.seconds(params.seconds ?? 0);
    case "duration.minutes": return dur.minutes(params.minutes ?? 0, params.seconds ?? 0);
    case "duration.hours": return dur.hours(params.hours ?? 0, params.minutes ?? 0, params.seconds ?? 0);
  }
};
