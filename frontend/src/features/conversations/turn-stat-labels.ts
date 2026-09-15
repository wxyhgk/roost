import { t } from "@roost/i18n";
import type { TurnStatTranslate } from "../../vendor/dsh/chat/TurnUsagePanel";
import type { SessionStatTranslate } from "../../vendor/dsh/chat/StatsPills";

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
const s = t.misc.conversations.detail.sessionStats;

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

/**
 * 会话级两颗药丸的 `t`。
 *
 * **不和 `TURN_STAT` 合成一个**：两个组件的键各自是一个**闭合联合**，合起来写就要给
 * 一个并集类型的 switch，而那样任何一边少一个键 tsc 都不再报错——那正是这套键当初被写成
 * 闭合联合要防的事。重复的那几个 case（`number.*`、`turnUsage.*`）是这条约束的代价。
 */
export const SESSION_STAT: SessionStatTranslate = (key, params = {}) => {
  switch (key) {
    case "message.turnUsage.count": return u.count(params.count ?? "");
    case "message.turnUsage.cacheHit": return u.cacheHit;
    case "message.turnUsage.input": return u.input;
    case "message.turnUsage.cacheRead": return u.cacheRead;
    case "message.turnUsage.cacheWrite": return u.cacheWrite;
    case "message.turnUsage.output": return u.output;
    case "message.tokensPerSecond": return t.misc.conversations.detail.tokensPerSecond(params.tps ?? "");
    case "stats.counts": return s.counts(params.turns ?? 0, params.steps ?? 0);
    case "stats.cacheHit": return s.cacheHit(params.percent ?? "");
    case "stats.dialog.title": return s.title;
    case "stats.dialog.usageTitle": return s.usageTitle;
    case "stats.dialog.llmTime": return s.llmTime;
    case "stats.dialog.toolTime": return s.toolTime;
    case "stats.dialog.ttft": return s.ttft;
    case "stats.dialog.speed": return s.speed;
    case "duration.compactSeconds": return s.compactSeconds(params.seconds ?? 0);
    case "duration.compactMinutes": return s.compactMinutes(params.minutes ?? 0, params.seconds ?? 0);
    case "number.thousand": return n.thousand(params.value ?? "");
    case "number.million": return n.million(params.value ?? "");
    case "number.groupSeparator": return n.groupSeparator;
  }
};
