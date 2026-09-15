import type { ToolId } from "./identify";
import type { ToolRowVariant } from "../../../vendor/dsh/chat/tool/models/tool-call-model";

/**
 * 「这个工具叫什么、用哪个图标、算哪个 variant」——一次调用的**外观身份**。
 *
 * 在此之前每一行都是同一个泛型图标加 `variant="others"`（registry.tsx 的 Fallback），
 * 于是一屏工具调用长得一模一样，扫不出哪行是跑命令、哪行是读文件。这张表把那一层补上。
 *
 * **不含 JSX，也不返回 ReactNode。** 图标以**标识**（{@link ToolIconName}）返回，由渲染侧
 * 查一张 `Record<ToolIconName, ReactNode>` 取组件。两条理由：
 *
 * 1. `node --test` 加载不了 CSS Module，而 vendor 的图标桶一路会牵进 `.module.css`；判定
 *    一旦跟着进 JSX 就一条都测不到——和 `dispatch.ts`、`identify.ts` 顶上是同一条理由。
 * 2. 图标是**渲染决策**，尺寸和颜色由挂它的那一行说了算。返回节点等于在这里替渲染侧把
 *    `size` 定死，而 dsh 的图标是按 14/16 分开导出的。
 *
 * 数据从哪来（两处，都是 MIT）：
 *
 * - **变体表**沿用已经 vendor 的 `tool-call-model.ts`（deepseek-harness，提交 0d1f500）里那七种
 *   `ToolRowVariant`。不另起一套，是因为 `ToolRow` 的 `data-variant` 就吃它，多一套等于多一次转译。
 * - **工具名 → 图标 / 标题**照搬 happier（happier-dev/happier，提交 c4deb153，
 *   `apps/ui/sources/components/tools/catalog/` 整个目录 + `text/translations/en.ts` 的
 *   `tools.names.*`）。和 `identify.ts` 顶上那张别名表同源，那边搬的是归一化、这边搬的是外观。
 *
 * **上游那份不能逐字搬**：happier 是 React Native，`catalog/icons.tsx` 画的是
 * `<Icon name="terminal">`（`@hugeicons/react-native` + `react-native-unistyles`），
 * 每个定义的 `input`/`result` zod schema 又都是 `@happier-dev/protocol` 的 import，
 * `title` / `extractSubtitle` 还吃 `metadata` 和 `resolvePath`。搬过来的只有**表里的取舍**
 * ——哪个工具算哪一类、配哪个概念的图标、叫什么——那部分逐条对得上，其余是我们自己的形状。
 */

/**
 * 图标的**概念名**，不是组件。
 *
 * 一个名字一个概念，映射到哪个 dsh 图标由渲染侧决定（见本文件末尾的接线说明）。
 * 刻意不叫 `IconBrowseOutline16` 这种具体名：那样这张表就钉死在 vendor 的导出名上，
 * 上游改名或我们换图标库时要改的是三十多行而不是一行。
 */
export type ToolIconName =
  | "terminal" | "search" | "read" | "edit" | "write" | "delete" | "web"
  | "todo" | "think" | "plan" | "question" | "task" | "code" | "stop"
  | "plugin" | "generic";

/**
 * 标题的**键名**，不是文案。
 *
 * 返回键而不是字符串，是因为这一层跑在 i18n 之外（测试里没有 locale），而 Roost 是中英双份。
 * 键名照搬 happier 的 `tools.names.*`，英文兜底见 {@link TOOL_TITLE_EN}；
 * 等 `packages/i18n` 长出对应词条，调用方把兜底表换成 `t.` 那一份即可，这张表一个字不用改。
 */
export type ToolTitleKey =
  | "terminal" | "taskOutput" | "taskStop"
  | "readFile" | "readNotebook" | "listFiles"
  | "searchFiles" | "searchContent" | "search"
  | "editFile" | "editNotebook" | "writeFile" | "applyChanges" | "viewDiff" | "delete"
  | "fetchUrl" | "webSearch"
  | "todoList" | "reasoning" | "planProposal" | "switchMode" | "question"
  | "task" | "subAgent" | "changeTitle" | "runCode";

export type ToolCatalogEntry = {
  /** 直接喂给 `ToolRow` / `GenericToolCard` 的 `variant`。 */
  variant: ToolRowVariant;
  /** 图标标识，渲染侧查表取节点。 */
  icon: ToolIconName;
  /**
   * 标题键；`null` = 这张表说不出比工具名更好的称呼，调用方用 `toolLabel(id, raw)` 顶上。
   *
   * MCP 工具永远是 `null`：它的好名字是「服务器 · 工具」，那个只有 `toolLabel` 拼得出来，
   * 而且一个固定标题会把「哪台 MCP 的哪个工具」这条唯一有用的信息盖掉。
   */
  titleKey: ToolTitleKey | null;
};

/** 认不出来时的那一行。`others` + 泛型图标 + 不改标题，也就是这次改动之前每一行的样子。 */
export const UNKNOWN_TOOL: ToolCatalogEntry = { variant: "others", icon: "generic", titleKey: null };

/**
 * 变体自带的图标概念。
 *
 * 逐条对应 vendor 那份 `GenericToolCard.tsx` 的 `VARIANT_ICONS`（同一张 figma 表），
 * 所以下面 {@link TOOLS} 里**大多数条目不写 `icon`**——变体已经把它定了，只有真的该换一个
 * 字形的（垃圾桶、地球、清单、灯泡）才覆盖。少写一遍的好处是变体和图标不会各自漂移。
 */
const VARIANT_ICON: Record<ToolRowVariant, ToolIconName> = {
  search: "search", read: "read", bash: "terminal",
  write: "write", edit: "edit", code: "code", others: "generic",
};

/** 表里一条的原料：变体必填，图标缺省跟变体走，标题键缺省是 `null`（用工具名）。 */
type Row = { variant: ToolRowVariant; icon?: ToolIconName; title?: ToolTitleKey };

/**
 * 工具身份 → 外观。
 *
 * **键是 `identifyTool()` 吐出来的 `key`**，也就是小写 + 过完别名表之后的名字，不是 wire 名。
 * 所以 `Bash` / `shell` / `execute` / `CodexBash` / `run_terminal_cmd` 在这里只占一行 `bash`——
 * 别名表已经把七家的拼法收敛过一次了，这里再收一次就是两处各自漂移。
 *
 * 反过来，**别名表没收的拼法必须在这里各占一行**：gemini / qwen 的 wire 名
 * （`read_file` / `run_shell_command` / `search_file_content` …）一个都没进别名表，
 * happier 那边也不在 UI 层收（它在 CLI 侧的 `backends/gemini/acp/transport.ts` 收）。
 * 漏一条的症状是那家 CLI 的那个工具永远显示泛型图标——不报错，只是看不出来。
 */
const TOOLS: Record<string, Row> = {
  // —— 跑命令 ——
  // `bash` 一行吃掉 Bash / shell / execute / CodexBash / run_terminal_cmd（别名表收的）。
  bash: { variant: "bash", title: "terminal" },
  run_shell_command: { variant: "bash", title: "terminal" },   // gemini / qwen
  local_shell: { variant: "bash", title: "terminal" },         // codex 的另一种拼法
  // 后台任务那两个动作：Claude 的 BashOutput / KillShell，happier 的 task_output / task_stop。
  // 它们不是「再跑一条命令」，而是取输出和叫停，所以标题换掉、停止那个换个字形。
  bashoutput: { variant: "bash", title: "taskOutput" },
  task_output: { variant: "bash", title: "taskOutput" },
  taskoutput: { variant: "bash", title: "taskOutput" },
  killshell: { variant: "bash", icon: "stop", title: "taskStop" },
  task_stop: { variant: "bash", icon: "stop", title: "taskStop" },
  taskstop: { variant: "bash", icon: "stop", title: "taskStop" },

  // —— 读文件 ——
  // `read` 吃掉 Read / read / view（别名表收的，view 是 ACP 的老拼法）。
  read: { variant: "read", title: "readFile" },
  read_file: { variant: "read", title: "readFile" },           // gemini / qwen
  read_many_files: { variant: "read", title: "readFile" },      // gemini / qwen
  notebookread: { variant: "read", title: "readNotebook" },
  view_image: { variant: "read", title: "readFile" },           // codex

  // —— 找东西 ——
  // `grep` 吃掉 Grep / search（别名表收的）。
  //
  // **图标不照抄 happier。** 它给 Grep 配的是 ICON_READ（眼睛），而 Glob / LS / CodeSearch
  // 三个同类都是放大镜——一个「Search Content」配眼睛读起来是读文件不是搜索，看着是上游自己
  // 的疏漏。这里统一走 search 变体自带的放大镜，标题仍按它的分法区分「搜文件名」和「搜内容」。
  grep: { variant: "search", title: "searchContent" },
  search_file_content: { variant: "search", title: "searchContent" },  // gemini / qwen
  glob: { variant: "search", title: "searchFiles" },
  codesearch: { variant: "search", title: "search" },
  ls: { variant: "search", title: "listFiles" },
  list: { variant: "search", title: "listFiles" },              // opencode
  list_directory: { variant: "search", title: "listFiles" },    // gemini / qwen

  // —— 改文件 ——
  // `edit` 吃掉 Edit / edit / str_replace_editor，`patch` 吃掉 apply_patch / CodexPatch，
  // `diff` 吃掉 CodexDiff（都在别名表里）。
  edit: { variant: "edit", title: "editFile" },
  multiedit: { variant: "edit", title: "editFile" },
  replace: { variant: "edit", title: "editFile" },              // gemini / qwen
  notebookedit: { variant: "edit", title: "editNotebook" },
  write: { variant: "write", title: "writeFile" },
  write_file: { variant: "write", title: "writeFile" },         // gemini / qwen
  patch: { variant: "edit", title: "applyChanges" },
  diff: { variant: "edit", title: "viewDiff" },
  // 删除是唯一一个「改文件但不是写字」的动作，给它自己的垃圾桶。别名表把 remove 收到这里。
  delete: { variant: "edit", icon: "delete", title: "delete" },
  move: { variant: "edit", title: "editFile" },                 // ACP

  // —— 上网 ——
  // 地球覆盖掉变体图标：变体要留着（web_fetch 的正文是读回来的网页、web_search 是结果列表），
  // 但「这是网上的东西」比「这是一次读 / 一次搜」更该一眼看出来。
  webfetch: { variant: "read", icon: "web", title: "fetchUrl" },
  web_fetch: { variant: "read", icon: "web", title: "fetchUrl" },
  fetch: { variant: "read", icon: "web", title: "fetchUrl" },   // grok 的 ACP kind
  websearch: { variant: "search", icon: "web", title: "webSearch" },
  web_search: { variant: "search", icon: "web", title: "webSearch" },
  google_web_search: { variant: "search", icon: "web", title: "webSearch" },  // gemini / qwen

  // —— 不动文件也不跑命令的那几类 ——
  // 全落 others 变体（`ToolRow` 的默认样式），靠图标和标题区分。
  todowrite: { variant: "others", icon: "todo", title: "todoList" },
  todoread: { variant: "others", icon: "todo", title: "todoList" },
  todo_write: { variant: "others", icon: "todo", title: "todoList" },
  write_todos: { variant: "others", icon: "todo", title: "todoList" },
  // codex 的 update_plan 存的是一串带状态的步骤，画出来就是一张清单，所以跟 todo 一组
  // 而不是跟 ExitPlanMode 一组——后者是「请你批准这个方案」，一次待办，不是一张表。
  update_plan: { variant: "others", icon: "todo", title: "todoList" },
  think: { variant: "others", icon: "think", title: "reasoning" },
  reasoning: { variant: "others", icon: "think", title: "reasoning" },
  exitplanmode: { variant: "others", icon: "plan", title: "planProposal" },
  exit_plan_mode: { variant: "others", icon: "plan", title: "planProposal" },
  switchmode: { variant: "others", icon: "plan", title: "switchMode" },
  switch_mode: { variant: "others", icon: "plan", title: "switchMode" },
  askuserquestion: { variant: "others", icon: "question", title: "question" },
  task: { variant: "others", icon: "task", title: "task" },
  subagent: { variant: "others", icon: "task", title: "subAgent" },
  change_title: { variant: "others", icon: "edit", title: "changeTitle" },
  run_code: { variant: "code", title: "runCode" },
};

/**
 * 一次工具调用长什么样。
 *
 * @param id - `identifyTool()` 的结果。
 * @returns 变体 + 图标标识 + 标题键；认不出来就是 {@link UNKNOWN_TOOL}。
 */
export function toolCatalogEntry(id: ToolId): ToolCatalogEntry {
  /*
    MCP 先判，和 happier 的 `getToolViewComponent` 同序（前缀规则先于一切）：一个 MCP 工具
    可能正好叫 `read`，但它是谁家的 read 我们不知道，按本地 read 画就是在替它作保。
    `identifyTool` 已经把整串拆成 server + tool 了，这里只认那个 key。
  */
  if (id.key === "mcp") return { variant: "others", icon: "plugin", titleKey: null };
  /*
    `hasOwn` 而不是直接取值：工具名是外部数据（各家 CLI 原样写进 transcript 的字符串），
    而对象字面量带着 Object.prototype——一个叫 `constructor` 或 `toString` 的工具会取到
    原型上的函数，`row.variant` 就是 undefined，`data-variant` 上于是出现字符串 "undefined"。
    不是假想：MCP 服务器的工具名完全由第三方决定，`__proto__` 也是合法的 JSON 键。
  */
  const row = Object.hasOwn(TOOLS, id.key) ? TOOLS[id.key] : undefined;
  if (!row) return UNKNOWN_TOOL;
  return { variant: row.variant, icon: row.icon ?? VARIANT_ICON[row.variant], titleKey: row.title ?? null };
}

/**
 * 标题键的英文兜底，逐字取自 happier 的 `tools.names.*`（`text/translations/en.ts`）。
 *
 * 在这里而不在 `packages/i18n` 里，是因为这一层要能被 `node --test` 直接加载，而那个包
 * 是中英两份互相约束的形状——加一张表要同时改两处。等真要中文了，调用方把这张表换成
 * `t.` 的那一份即可：**键名是接口，文案不是**。
 */
export const TOOL_TITLE_EN: Record<ToolTitleKey, string> = {
  terminal: "Terminal",
  taskOutput: "Task output",
  taskStop: "Stop task",
  readFile: "Read File",
  readNotebook: "Read Notebook",
  listFiles: "List Files",
  searchFiles: "Search Files",
  searchContent: "Search Content",
  search: "Search",
  editFile: "Edit File",
  editNotebook: "Edit Notebook",
  writeFile: "Write File",
  applyChanges: "Update file",
  viewDiff: "Diff",
  delete: "Delete",
  fetchUrl: "Fetch URL",
  webSearch: "Web Search",
  todoList: "Todo List",
  reasoning: "Reasoning",
  planProposal: "Plan proposal",
  switchMode: "Switch mode",
  question: "Question",
  task: "Task",
  subAgent: "Subagent",
  changeTitle: "Change Title",
  runCode: "Run Code",
};

/**
 * 标题键 → 一行字，拿不到键就退回工具名。
 *
 * @param titleKey - {@link toolCatalogEntry} 给的键，`null` = 这张表没有更好的说法。
 * @param fallback - 退回用的名字，通常是 `toolLabel(id, block.name)`。
 * @returns 显示用的标题。
 */
export function toolTitle(titleKey: ToolTitleKey | null, fallback: string): string {
  return titleKey === null ? fallback : TOOL_TITLE_EN[titleKey];
}
