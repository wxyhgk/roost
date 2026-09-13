/**
 * markdown 文档里的相对路径解析。
 *
 * 不能复用 `resolveLinkTarget`：那个是给终端链接用的，按会话 cwd 解析并且**一律拒绝 `..`**。
 * 而 markdown 里 `../assets/x.png` 是完全正常的写法——文档引用同级或上级目录的图片、
 * 互相链接，都是日常。所以这里按**文档自身所在目录**解析，只在最终结果越出根目录时才拒绝。
 */

/** 判断是否是不该当作仓库内路径处理的目标：协议链接、协议相对链接、纯锚点。 */
export function isExternalHref(href: string): boolean {
  const value = href.trim();
  if (!value) return true;
  if (value.startsWith("#")) return true;
  if (value.startsWith("//")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

/**
 * 把文档里的相对目标解析成**根目录相对路径**。
 *
 * @param docPath 文档自身的根目录相对路径，如 `tasks/plan.md`
 * @param href    文档里写的目标，如 `./a.png`、`../img/b.png`、`/tasks/other.md`
 * @returns 规范化后的根相对路径；越出根目录、或不是仓库内路径时返回 null
 */
export function resolveDocPath(docPath: string, href: string): string | null {
  if (isExternalHref(href)) return null;
  // 锚点和查询串不参与路径解析，但要保留给调用方之外的逻辑决定是否使用。
  const target = href.trim().split("#")[0]!.split("?")[0]!;
  if (!target || target.includes("\0")) return null;
  // 以 / 开头的按「相对于根目录」理解——文档里没有真正的文件系统绝对路径的语义。
  const base = target.startsWith("/") ? [] : docPath.split("/").slice(0, -1);
  const parts = [...base, ...target.split("/")];
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      // 已经在根目录还要往上，就是越界。宁可不渲染成链接，也不指向根之外。
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.length ? stack.join("/") : null;
}
