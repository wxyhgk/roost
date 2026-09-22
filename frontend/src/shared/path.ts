/**
 * 工作目录的最后一段——「这是哪个目录」。
 *
 * 这一串（换反斜杠 → split → 去掉空段 → 取末段）原来抄在四个地方，而**其中一份不一样**：
 * 命令面板那份用的是 `.split("/").pop()`，没有 `filter(Boolean)`。cwd 带尾斜杠时它得到
 * 空串，而后面的 `?? cwd` 只兜 null/undefined、**兜不住空串**，于是面板上那一栏标题渲染
 * 成空的。没有报错，只在特定 cwd 上出现。
 *
 * 没有段时返回空串，让调用方各自用 `||` 挑兜底——四个地方的兜底本来就不同
 * （`/`、原路径、null、会话 id），那是真实差异，不该被藏进这里。
 *
 * **和「取文件名」不是一回事。** `shared/chemistry/editor.ts` 和 `embeds/molecule` 里那两处
 * 用的是 `.split("/").at(-1)`，取的是文件名、接着要找扩展名的点，故意不去空段。别合并。
 */
export function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "";
}
