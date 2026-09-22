import { useState } from "react";
import { useNewBuild } from "../shared/buildVersion";
import { t } from "@roost/i18n";

/*
  「线上换了一版，你手上这个是旧的」。

  **不自动重载。** 你可能正在终端里打字，或者正在读一段刚跑完的输出——替你刷掉是比
  看到旧版本更坏的结果。这里只给一条可以忽略的提示，按不按由你。

  摆在右下角：底部居中被「已保存」那条占着，左下角被图片粘贴的状态占着。
*/
export function NewBuildNotice() {
  const stale = useNewBuild();
  const [dismissed, setDismissed] = useState(false);
  if (!stale || dismissed) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-lg border border-bar-text/10 bg-bar px-3 py-1.5 text-body text-bar-text shadow-pop"
    >
      <span>{t.misc.newBuild.message}</span>
      <button
        type="button"
        className="rounded-md bg-bar-text/10 px-2 py-0.5 hover:bg-bar-text/20"
        onClick={() => window.location.reload()}
      >
        {t.misc.newBuild.action}
      </button>
      <button
        type="button"
        className="rounded-md px-2 py-0.5 text-bar-text/70 hover:bg-bar-text/10"
        onClick={() => setDismissed(true)}
      >
        {t.misc.newBuild.dismiss}
      </button>
    </div>
  );
}
