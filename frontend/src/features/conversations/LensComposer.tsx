import { ConversationComposer } from "./ConversationComposer";
import { useDirectSend } from "./useDirectSend";

/**
 * 只有输入框、没有对话记录的那种情形：终端里的 CLI 在跑，但 roost 还不知道它在哪段对话里
 * （刚启动、还没报到，或者从没报过）。
 *
 * 旧路要先有对话身份才能投递，所以这时镜头里只有一行字。现在打字只认终端，没有理由不给
 * 输入框。单独成文件，是为了跟 ConversationDetail 一起懒加载（见 TerminalLens 顶上）。
 */
export default function LensComposer({ terminalId }: { terminalId: string }) {
  const send = useDirectSend(terminalId);
  return <ConversationComposer send={send} />;
}
