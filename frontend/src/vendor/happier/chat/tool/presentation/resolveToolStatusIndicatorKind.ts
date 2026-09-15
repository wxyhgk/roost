/*
  「这次调用该点哪种状态灯」——重点在它不信 `state`：即便状态是 completed，也会递归挖
  result（深度上限 5）找 `ok === false` / `isError === true` / `tool_use_result` 以 `error:`
  开头，命中就判成 error。

  逐字抄自 happier（MIT，Copyright (c) 2026 Happy Coder Contributors，happier-dev/happier，
  `apps/ui/sources/components/tools/shell/presentation/resolveToolStatusIndicatorKind.ts`，
  检出提交 c4deb153）。**出处不是任务里写的 deepseek-harness**，理由见 ../../../NOTICE.md。

  === 在我们这儿的适用范围：目前是零，**没有接线，也不要硬接** ===

  我们的失败判定来自解析器给的显式布尔 `block.failed`（`features/conversations/parts.ts`），
  不用猜；这个函数唯一能补的是「`tool_result` 没标 error、输出里自己写着失败」那一种。
  但它在我们的数据上**一次也不会命中**：`hasStructuredResultFailure` 的 string 分支有一道
  `isHappierToolsCallEnvelope` 闸门，只有解出来是 `{ v: 1, kind: 'tools_call' }` 这个 happier
  自家信封才继续往里挖。我们的 `block.result` 是一坨普通字符串，内容哪怕正好是
  `{"ok": false}`，解出来也不是那个信封，直接 false。

  所以它留在这里是为了将来——哪天解析器开始给结构化 result，这套深度上限和递归键名
  （`results` / `data` / `output` / `result` / `stdout` / `content`）就现成可用。
  **在那之前不要为了用上它去构造假信封**，那只会让「失败」这件事从一个显式信号退回成猜。

  一处 ROOST-CHANGE：类型。
*/

/*
  ROOST-CHANGE：上游这里是 `import type { ToolCall } from '@/sync/domains/messages/messageTypes'`。
  我们没有那棵同步树，就地声明成这个函数真正读到的三个字段。字段名和取值域与上游逐字一致
  （`apps/ui/sources/sync/domains/messages/messageTypes.ts:5-33`），这样将来重新同步时
  函数体仍是覆盖而不是合并。
*/
export interface ToolCallStatusSlice {
    state: 'running' | 'completed' | 'error' | 'unavailable';
    result?: unknown;
    permission?: { status: 'pending' | 'approved' | 'denied' | 'canceled' };
}

export type ToolStatusIndicatorKind =
    | 'permission_blocked'
    | 'permission_pending'
    | 'running'
    | 'completed'
    | 'error'
    | 'none';

function parseStructuredResultText(value: string): unknown | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim();
        if (!firstLine || firstLine === trimmed) return null;
        try {
            return JSON.parse(firstLine) as unknown;
        } catch {
            return null;
        }
    }
}

function isHappierToolsCallEnvelope(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.v === 1 && record.kind === 'tools_call';
}

function hasStructuredResultFailure(value: unknown, depth = 0): boolean {
    if (depth > 5) return false;
    if (typeof value === 'string') {
        const parsed = parseStructuredResultText(value);
        return isHappierToolsCallEnvelope(parsed) && hasStructuredResultFailure(parsed, depth + 1);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

    const record = value as Record<string, unknown>;
    if (record.ok === false || record.isError === true) return true;

    if (Array.isArray(record.results)) {
        for (const result of record.results) {
            if (hasStructuredResultFailure(result, depth + 1)) return true;
        }
    }

    for (const key of ['data', 'output', 'result', 'stdout'] as const) {
        if (hasStructuredResultFailure(record[key], depth + 1)) return true;
    }

    const content = record.content;
    if (typeof content === 'string' && hasStructuredResultFailure(content, depth + 1)) return true;
    if (Array.isArray(content)) {
        for (const block of content) {
            if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
            const blockRecord = block as Record<string, unknown>;
            if (blockRecord.type === 'text' && hasStructuredResultFailure(blockRecord.text, depth + 1)) return true;
        }
    }

    return false;
}

function hasToolResultFailure(tool: ToolCallStatusSlice): boolean {
    const result = tool.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return hasStructuredResultFailure(result);
    }
    const record = result as Record<string, unknown>;
    const toolUseResult = record.tool_use_result;
    if (typeof toolUseResult === 'string' && toolUseResult.trim().toLowerCase().startsWith('error:')) {
        return true;
    }
    return hasStructuredResultFailure(result);
}

export function resolveToolStatusIndicatorKind(tool: ToolCallStatusSlice): ToolStatusIndicatorKind {
    const permissionStatus = tool.permission?.status;
    if (permissionStatus === 'denied' || permissionStatus === 'canceled') return 'permission_blocked';
    if (permissionStatus === 'pending' && tool.state === 'running') return 'permission_pending';

    if (tool.state === 'running') return 'running';
    if (tool.state === 'error') return 'error';
    if (tool.state === 'unavailable') {
        return hasToolResultFailure(tool) ? 'error' : 'none';
    }
    if (tool.state === 'completed') {
        return hasToolResultFailure(tool) ? 'error' : 'completed';
    }
    return 'none';
}
