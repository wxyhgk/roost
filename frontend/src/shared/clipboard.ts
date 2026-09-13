/**
 * 写入剪贴板，返回是否成功。
 *
 * navigator.clipboard 只在安全上下文（HTTPS 或 localhost）下存在。经 http 端口映射
 * 访问时它是 undefined，直接调用会抛 TypeError。这里保留 execCommand 退路——它虽然
 * 已废弃，但在非安全上下文下仍然可用，而写入剪贴板本身没有别的办法。
 *
 * 返回布尔而不是抛错：所有调用点关心的都只是「成没成」，各自给自己的提示。
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒、或文档此刻没有焦点，都回落到下面的退路。
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  // 必须真的在文档里且可选中，同时不能滚动视口、不能被看见。
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(area);
  // 复制会清掉用户当前的选区（比如终端里刚划的那段），用完还回去。
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (selection && previous) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}
