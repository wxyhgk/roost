import type { ExternalEditor } from "../shared/editor";
import { moleculeEditor } from "./molecule";

/**
 * 活在预览弹窗**之外**的编辑器。
 *
 * 和 `index.ts` 里那张表是两种东西：`EDITOR_PLUGINS` 渲染在弹窗内部，这一张里的自己挂在
 * `Shell` 上、由文件树隔空通知。分开是因为有些编辑器**不能跟着文件切换重挂**——分子编辑器
 * 住在 iframe 里，销毁一次就是一次完整冷启动。契约见 shared/editor 的 ExternalEditor。
 *
 * **为什么不合到 index.ts 里：** `Shell` 是首屏，而 `index.ts` 牵着 markdown / code /
 * media / xyz 那一串预览插件——它们本来只跟着懒加载的 FilesView 进来。合在一起实测让首屏
 * 从 386.3 KB 涨到 560.8 KB（gzip）。一个注册表被谁 import，就决定了它牵着的东西落在哪个
 * chunk 里；两种契约的使用者不同，注册表就得分开。
 *
 * 「有哪些外部编辑器」这个问题只在这里有答案：Shell 照着它渲染宿主，文件树照着它问归属，
 * 两边都不认识任何具体类型。
 */
export const EXTERNAL_EDITORS: readonly ExternalEditor[] = [moleculeEditor];
