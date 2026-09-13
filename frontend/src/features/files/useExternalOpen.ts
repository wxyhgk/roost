import { useCallback, useEffect, useState } from "react";
import { resolveLinkTarget, subscribeFileLink, type FileOpenRequest } from "../terminal/public";
import { clearNav, subscribeNav, takeNav } from "../../shared/navigate";
import { t } from "@roost/i18n";

/**
 * 文件面板**外面**发来的「打开这个文件」请求。
 *
 * 两个来源，做的是同一件事：
 *   - 终端输出里的文件链接（CLI 报错时打印的那种路径）
 *   - 命令面板的跳转（⌘K 选中一个文件）
 *
 * 它们都给的是**原始字符串**——可能是绝对路径、可能带 `./`、也可能压根不在这个会话的
 * 根目录下。所以两条路都要先 `resolveLinkTarget` 归属解析再交给 `open`。这一步写在
 * 一处，是为了让「外面给的路径一律不可信」这条规则只有一个落点。
 *
 * 和 `useOpenFile` 分开：那边是「现在打开的是哪个文件」这个状态机，这边是「谁在要求
 * 打开」。混在一起时，那个 hook 返回 9 样东西，其中 4 样只为终端链接存在。
 */
export function useExternalOpen({ cwd, sessionId, open }: {
  cwd: string;
  sessionId: string;
  /** 归属解析通过之后真正去打开。返回 false 表示用户在未保存确认里点了取消。 */
  open(path: string): boolean;
}) {
  /** 链接指到根目录外面了。这是**给人看的提示**，不是异常——路径本身可能完全正常。 */
  const [linkError, setLinkError] = useState<string | null>(null);
  /**
   * 带行号的那一次打开。
   *
   * `nonce` 用来区分「又点了同一个链接」：路径和行号都没变时，没有它就没办法让预览
   * 知道该重新跳一次。
   */
  const [linkRequest, setLinkRequest] = useState<(FileOpenRequest & { nonce: number }) | null>(null);

  useEffect(() => subscribeFileLink(sessionId, (request) => {
    const resolved = resolveLinkTarget(cwd, request.path);
    if (!resolved) {
      setLinkError(t.files.tree.linkOutside(request.path, cwd));
      return;
    }
    setLinkError(null);
    if (!open(resolved)) return;
    setLinkRequest({ sessionId, path: resolved, line: request.line, nonce: Date.now() });
  }), [cwd, sessionId, open]);

  useEffect(() => {
    const openRaw = (raw: string) => {
      const resolved = resolveLinkTarget(cwd, raw);
      if (resolved) open(resolved);
    };
    const unsubscribe = subscribeNav((request) => {
      if (request.kind !== "file") return;
      openRaw(request.path);
      clearNav(request);
    });
    // 面板可能在跳转发出之后才挂载，所以还要主动取一次存下的那条。
    const pending = takeNav("file");
    if (pending && pending.kind === "file") openRaw(pending.path);
    return unsubscribe;
  }, [cwd, open]);

  return {
    linkError,
    /** 用户把提示叉掉了。给个有名字的动作，而不是把 setter 漏出去。 */
    dismissLinkError: useCallback(() => setLinkError(null), []),
    linkRequest,
    /** 预览已经跳到那一行了。清掉，免得下次打开同一个文件又跳一次。 */
    consumeLinkLine: useCallback(() => setLinkRequest(null), []),
  };
}
