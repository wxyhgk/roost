import { useWorkspace } from "../../../shared/store";
import { useSessionActivity } from "../../session-status/public";
import { useCliIdentity } from "../../../shared/ui/SessionLogo";

// 三个可调项，改这里就够：
const OPACITY = 0.06;                    // 再淡基本看不见，再浓开始跟输出抢注意力
const SIZE = "clamp(96px, 26%, 220px)";  // 跟着终端面板走，窄面板下不会撑爆
const PLACE = "place-items-center";      // 想挪到角上改 place-items-end 并加内边距

// 与 public/logos/<id>-mark.svg 一一对应。白名单同时避免把后端来的字符串直接拼进
// URL，也让「新增内置 CLI 但忘了生成 mark」表现为没有水印，而不是一个 404。
const MARKS = new Set(["claude", "codex", "grok", "omp", "opencode", "qwen"]);

/**
 * 终端底纹：标出这个会话跑的是哪个 AI CLI。
 *
 * 画在终端**上层**而非背景层：xterm 的背景由它自己绘制，要透到文字下面就得开
 * allowTransparency，那会让字形图集无法烘焙背景（刷屏时最热的路径），还会让
 * minimumContrastRatio 失去参照——浅色终端的可读性正靠它兜着。
 *
 * 用 CSS mask 而不是 <img>：只取形状的 alpha，颜色统一走当前文字色，深浅主题
 * 自动适配，也不会成为界面上唯一的彩色元素。素材是 public/logos/<id>-mark.svg，
 * 已剥掉侧边栏用的装饰底板——那种铺满 viewBox 的纯色块放大后会糊住整片终端。
 */
export function TerminalWatermark({ sessionId }: { sessionId: string }) {
  const { sessions } = useWorkspace("sessions");
  const session = sessions.find(s => s.id === sessionId);
  const activity = useSessionActivity(sessionId);
  const identity = useCliIdentity(session?.cli, activity.cliId ?? session?.cliId);

  // 只给内置 CLI 画。用户自传的图标形状不可控，可能自带不透明底板，
  // 放大成水印会变成一块糊在终端上的方块——宁可不画。
  if (!identity.builtin || !MARKS.has(identity.builtin)) return null;
  const mark = `/logos/${identity.builtin}-mark.svg`;

  return (
    <div className={`pointer-events-none absolute inset-0 z-[5] grid select-none ${PLACE}`} aria-hidden>
      <span
        className="block bg-text"
        style={{
          width: SIZE,
          aspectRatio: "1",
          opacity: OPACITY,
          maskImage: `url("${mark}")`,
          WebkitMaskImage: `url("${mark}")`,
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
          maskSize: "contain",
          WebkitMaskSize: "contain",
        }}
      />
    </div>
  );
}
