/*
  让浏览器把一段内容存成文件。

  仓库里原来有四份各自为政的实现（`features/library/export.ts`、
  `features/terminal/exportLog.ts`、`features/files/NodeMenu.tsx`、
  `embeds/molecule/MoleculeModal.tsx`），而它们的差异不是风格，是**两处真实的行为差别**：

  - **两份没有把 `<a>` 挂进 document 就 `.click()`。** Chrome 能忍，Firefox 和旧 Safari
    不行——那两个浏览器里点了没反应，而且不报错。
  - **只有一份洗了文件名。** 名字里出现 `/ \ : * ? " < > |` 时，下载会被浏览器拒掉或者
    把名字改得面目全非。

  回收时机也分了两档（1 秒 / 5 秒）。取长的那档：`exportLog` 里那句注释是实测结论——
  立刻 revoke 会让某些浏览器还没读完就断掉。多挂 4 秒的代价只是一个 URL 晚一点释放。
*/

/** 文件名里不能出现的那些字符。路径分隔符和 Windows 保留字符。 */
const UNSAFE = /[/\\:*?"<>|\u0000-\u001f]/g;

/**
 * 洗成一个浏览器肯接受的文件名。
 *
 * 长度截到 120：各平台的上限不一样（多数是 255 字节），而中文一个字三字节，
 * 按字符数留出余量比按字节精确计算简单得多，也不会有人真的需要一个 200 字的文件名。
 *
 * 洗完什么都不剩时给一个兜底名——空的 `download` 属性等于没设，浏览器会拿 URL 的最后
 * 一段当名字，那通常是一串随机 id。
 */
export function safeDownloadName(name: string, fallback = "download"): string {
  const cleaned = name.replace(UNSAFE, "-").replace(/^\.+/, "").trim().slice(0, 120).trim();
  /*
    **判据是「洗完只剩分隔符」，不是「洗完为空」。** `///` 会变成 `---`——非空，但它不是
    一个名字。只判空的话这种就直接落地成文件名了。
  */
  return /^[-.\s]*$/.test(cleaned) ? fallback : cleaned;
}

/**
 * 下载一段内容或一个地址。
 *
 * `source` 是 `Blob` 时这里负责建 object URL 并在之后回收；是字符串时当成现成的地址
 * （文件树下载走的是服务端的 `/api/file/raw`，没有 Blob 可回收）。
 */
export function downloadFile(source: Blob | string, name: string, fallback?: string): void {
  const url = typeof source === "string" ? source : URL.createObjectURL(source);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeDownloadName(name, fallback);
  // 给 blob 之外的地址加上：下载链接不需要拿到 opener，而默认的 window.opener 是个洞。
  if (typeof source === "string") link.rel = "noopener";
  // **必须先挂进 document。** 见文件头：不挂的话 Firefox 和旧 Safari 里点了没反应。
  document.body.append(link);
  link.click();
  link.remove();
  if (typeof source !== "string") window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * 把一个对象存成 `.json` 下载。
 *
 * 原来住在 `features/library/export.ts`，而「把对象存成文件」和资料库没有任何关系——
 * 它在那儿的唯一后果是逼 `features/notes` 经由 `library/public` 去拿一个通用工具。
 * 顺带删掉了 `raw` 参数：三个调用点一个都没传过。
 */
export const exportJson = (name: string, value: unknown): void =>
  downloadFile(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }), name);
