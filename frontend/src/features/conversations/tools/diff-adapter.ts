import type { EditPatch } from "../../../shared/api/conversationPayloads";
import type { DiffHunk } from "../../../vendor/dsh";

/**
 * 我们的 `EditPatch` → `DiffBlock` 要的 `DiffHunk[]`。
 *
 * 两边的形状差在哪：我们拿到的是 unified diff 的**行数组**（`+` / `-` / ` ` 前缀，
 * 供应商算好直接给的）；`DiffBlock` 要的是**每个 hunk 一条**的 `{ path, oldText, newText }`，
 * 它自己再 diff 一次来上色。
 *
 * **所以这个还原是无损的，前提是「每个 hunk 一条」。** 如果把所有 hunk 拼成整个文件的
 * 新旧两份，中间就缺了 hunk 之间那些没给我们的行，重新 diff 会把它们当成删除——
 * 一次「改了三行」会画成「删掉半个文件」。逐 hunk 换算不会，因为每一窗自成一体。
 *
 * 行号确实丢了（我们原来画 `@@ -12,3 +12,3 @@`），但 `DiffBlock` 本来就不画行号，
 * 它只画增删行本身——所以丢的是它不用的东西。
 */
export function toDiffHunks(patch: EditPatch): DiffHunk[] {
  const path = patch.filePath ?? "";
  const out: DiffHunk[] = [];
  for (const hunk of patch.hunks) {
    const old: string[] = [];
    const now: string[] = [];
    for (const line of hunk.lines) {
      // `\ No newline at end of file` 是 diff 的元信息，不是内容。
      if (line.startsWith("\\")) continue;
      const text = line.slice(1);
      if (line.startsWith("+")) now.push(text);
      else if (line.startsWith("-")) old.push(text);
      // 没有前缀的空串是上下文里的空行，两边都要。
      else { old.push(text); now.push(text); }
    }
    // 两边都空的 hunk 画出来是个空框，不如不给。
    if (!old.length && !now.length) continue;
    out.push({ path, oldText: old.join("\n"), newText: now.join("\n") });
  }
  return out;
}
