import {
  ArrowDownTrayIcon, ArrowPathIcon, ArrowUpTrayIcon, ChevronRightIcon, CodeBracketIcon,
  CommandLineIcon, DocumentDuplicateIcon, DocumentIcon, DocumentTextIcon, EllipsisHorizontalIcon,
  FolderIcon, MagnifyingGlassIcon, PencilIcon, PlusIcon, TrashIcon, XMarkIcon,
} from "@heroicons/react/24/outline";

/*
  这一组小图标**统一按 heroicons 的画法**，因为界面上本来就到处是 heroicons：四条 bar 全是
  它，而这里原来是另一只手画的 17 个。同一个概念被画两遍的后果是肉眼可见的——同一屏上会
  同时出现两个放大镜（顶栏 20px 的 heroicons、终端标题栏 14px 的手绘），画法和粗细都不一样；
  文件夹和代码符号同样各有两份。

  **规则只有一条：描边在屏幕上一律 1.25px。**

  描边粗细是跟着 viewBox 缩放的，所以同一个 `strokeWidth` 在不同渲染尺寸下粗细完全不同。
  原来这 17 个有五种 strokeWidth（1.2/1.3/1.4/1.6/2）配三种 viewBox（12/16/24），算下来
  实际粗细从 1.05px 到 1.40px，最粗的比最细的重 33%——挨在一起就是"有点不对劲"但说不上
  哪里不对。

  1.25px 不是随便挑的：heroicons 24/outline 的 strokeWidth 是 1.5，在 bar 里按 20px 渲染，
  1.5 × 20/24 = 1.25px。选它，这一组和四条 bar 就是同一个粗细。

  **小图标要靠加大 strokeWidth 来补。** 固定绝对粗细（而不是固定 strokeWidth）正是让一套
  图标看起来像一家人的做法：12px 的图标如果也用 1.5，屏幕上只有 0.75px，会比旁边的淡一半。

  渲染尺寸**一个都没改**，所以调用点不用动，布局也不会跳。
*/

/*
  **尺寸用绝对像素，不用 `size-*`。**

  Tailwind 的 `size-*` 是 rem，而 roost 在 `styles/shell.css` 里把 `html` 的字号设成了
  **13px**——于是 `size-5` 是 16.25px 而不是 20px，`size-3.5` 是 11.4px 而不是 14px。
  这一组原来是 `width="14"` 的死像素；第一版改写时我顺手换成了 `size-3.5`，结果把它们
  **悄悄缩小了 19%**，是在真页面上量描边时才发现的。

  所以这里写死像素：换画法不该顺带改大小。
*/
const bar = (px: number) => ({ width: px, height: px }) as const;

/*
  **描边基准取自 bar 里的 heroicons 实际渲染效果**，而不是拍一个好看的数：
  heroicons 24/outline 的 strokeWidth 是 1.5，bar 里按 `size-5` 渲染，也就是上面说的
  16.25px —— 1.5 × 16.25/24 ≈ 1.02px。这一组对齐到它，才是"同一个粗细"。
*/
const BAR_RENDER_PX = 16.25;
const STROKE_PX = (1.5 * BAR_RENDER_PX) / 24;
/** heroicons 的画布是 24；要在 `px` 大小下画出 STROKE_PX，strokeWidth 就得按比例放大。 */
const strokeFor = (px: number) => (STROKE_PX * 24) / px;

/**
 * 给**直接用 heroicons** 的地方（状态栏那几个读数图标就是）：按渲染像素算出该配的
 * strokeWidth，并把尺寸钉成绝对像素。
 *
 * 不导出这个的话，那些地方只能写 `size-3.5`，于是拿到 heroicons 默认的 1.5 —— 在 11.4px
 * 下只有 0.71px，**比别处细四成**，看着就是发虚。状态栏一直如此。
 */
export function iconProps(px: number) {
  return { width: px, height: px, strokeWidth: strokeFor(px), "aria-hidden": true } as const;
}

const SMALL = { ...bar(12), strokeWidth: strokeFor(12), "aria-hidden": true } as const;
const MEDIUM = { ...bar(14), strokeWidth: strokeFor(14), "aria-hidden": true } as const;

export function IconPlus() { return <PlusIcon {...MEDIUM} />; }
export function IconTerminal() { return <CommandLineIcon {...MEDIUM} />; }
export function IconFolder() { return <FolderIcon {...MEDIUM} />; }
export function IconFile() { return <DocumentIcon {...MEDIUM} />; }
export function IconRefresh() { return <ArrowPathIcon {...MEDIUM} />; }
export function IconUpload() { return <ArrowUpTrayIcon {...MEDIUM} />; }
export function IconSearch() { return <MagnifyingGlassIcon {...MEDIUM} />; }
export function IconDownload() { return <ArrowDownTrayIcon {...MEDIUM} />; }
export function IconNote() { return <DocumentTextIcon {...MEDIUM} />; }
export function IconCopy() { return <DocumentDuplicateIcon {...MEDIUM} />; }
export function IconCode() { return <CodeBracketIcon {...MEDIUM} />; }

export function IconEdit() { return <PencilIcon {...SMALL} />; }
export function IconClose() { return <XMarkIcon {...SMALL} />; }
export function IconDots() { return <EllipsisHorizontalIcon {...SMALL} />; }
export function IconTrash() { return <TrashIcon {...SMALL} />; }

/** 展开箭头。旋转而不是换图标——两个方向是同一个东西的两个状态。 */
export function IconChevron({ open }: { open: boolean }) {
  return <ChevronRightIcon {...SMALL} className="transition-transform"
    style={{ transform: open ? "rotate(90deg)" : "none" }} />;
}

/*
  **图钉留着自己画。** heroicons 没有图钉——`MapPinIcon` 是地图定位针，`BookmarkIcon` 已经
  被左栏的「书签」占了，`StarIcon` 说的是「收藏」不是「置顶」。与其换一个意思不对的，
  不如把这一个画得像一家人：同样的 1.25px 描边、同样的 12px。

  `active` 时填实：置顶与否是个开关，实心/空心是最省字的表达。
*/
export function IconPin({ active }: { active?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill={active ? "currentColor" : "none"} aria-hidden>
      <path
        d="M4.5 1.5h3V4l2 2v1H7v1.8l1 2.7-2 .5-2-.5 1-2.7V7H2.5V6l2-2V1.5z"
        stroke="currentColor"
        strokeWidth={STROKE_PX}
        strokeLinejoin="round"
      />
    </svg>
  );
}
