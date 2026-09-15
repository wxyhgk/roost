/*
  从一次工具调用的 result 里榨出一行错误摘要。

  逐字抄自 happier（MIT，Copyright (c) 2026 Happy Coder Contributors，happier-dev/happier，
  `apps/ui/sources/components/tools/shell/presentation/resolveToolErrorSummary.ts`，
  检出提交 c4deb153）。**出处不是任务里写的 deepseek-harness**，理由见 ../../../NOTICE.md。

  取值顺序一行未动，而且顺序本身就是它的价值所在：
  `tool_use_result`（必须以 `error:` 开头，剥掉前缀）→ `error`（字符串）→ `error.message`
  → `message` → `content` → result 本身是字符串。越靠前的越是「工具明确说这是错误」，
  越靠后的越是「只好拿它的输出顶一行」。

  两处 ROOST-CHANGE，都标在原位。
*/

/*
  ROOST-CHANGE 之一：上游这里是 `import type { ToolCall } from '@/sync/domains/messages/messageTypes'`。
  我们没有那棵同步树，而这个函数从头到尾只读 `result` 一个字段——所以就地声明成结构类型，
  调用方递一个 `{ result }` 进来即可，不必先把我们的 ToolBlock 整形成 happier 的 ToolCall。
*/
export interface ToolCallResultSlice {
    result?: unknown;
}

// ROOST-CHANGE 之二的一半：摘要要剥 ANSI，见下面的 firstLine。
import { parseAnsiLines } from '../../../../../shared/terminal-text/ansi.ts';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

/*
  ROOST-CHANGE 之二：上游是 `trimmed.slice(0, trimmed.indexOf('\n'))`，纯粹的切第一行。
  我们这里**先把整段按 ANSI 解析成行，取每行的可见文本**，再挑第一条还剩下字符的行。

  为什么非改不可：我们的 `block.result` 是 CLI 原样写进 transcript 的终端输出，带着
  `ESC[32m` 这类转义序列。上游的 result 是结构化对象，`error` / `message` 这些字段是干净的
  字符串，从来不会撞上这件事。不剥就直接把 `ESC[1;31mError: ...` 摊进摘要位——这正是
  这次搬运的起因。

  为什么顺带改成「第一条有可见字符的行」而不是死守「第一行」：终端输出的第一行经常是
  纯控制序列（清行 `ESC[2K`、隐藏光标 `ESC[?25l`），剥完就是空串。死守第一行的结果是
  摘要位空着，而真正那句 `Error: ENOENT` 就在下一行。上游的数据形状里不存在这种行，
  所以它没有、也不需要这条规则。

  剥 ANSI 用 shared/terminal-text/ansi.ts 那一份，不在这里手写正则：`\r` 覆写、退格、
  erase-in-line 这些都会影响「这一行最后长什么样」，手写正则只会得到一个少几条分支的版本。
  （`vendor/dsh` 里 TerminalBlock.tsx 指向同一份，同一个理由。）

  全段不可见时返回空串，和上游「没有第一行」的返回值保持一致——调用方本来就得判空。
*/
function firstLine(text: string): string {
    for (const line of parseAnsiLines(text)) {
        const plain = line.map(span => span.text).join('').trim();
        if (plain) return plain;
    }
    return '';
}

function stripErrorPrefix(text: string): string {
    return text.replace(/^error:\s*/i, '').trim();
}

export function resolveToolErrorSummary(tool: ToolCallResultSlice): string | null {
    const result = tool.result;

    const record = asRecord(result);
    if (record) {
        const toolUseResult = record.tool_use_result;
        if (typeof toolUseResult === 'string') {
            const trimmed = toolUseResult.trim();
            if (/^error:/i.test(trimmed)) {
                const stripped = stripErrorPrefix(trimmed);
                return stripped ? firstLine(stripped) : null;
            }
        }

        const error = record.error;
        if (typeof error === 'string' && error.trim()) return firstLine(error);
        const errorRecord = asRecord(error);
        if (errorRecord) {
            const message = errorRecord.message;
            if (typeof message === 'string' && message.trim()) return firstLine(message);
        }

        const message = record.message;
        if (typeof message === 'string' && message.trim()) return firstLine(message);
        const content = record.content;
        if (typeof content === 'string' && content.trim()) return firstLine(content);
    }

    if (typeof result === 'string' && result.trim()) {
        const line = firstLine(result);
        if (/^error:/i.test(line)) return stripErrorPrefix(line) || null;
        return line;
    }

    return null;
}
