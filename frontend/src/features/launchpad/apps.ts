/*
  把「在监听的端口」这张表，变成启动台上的一排应用。

  两者不是一回事，差别全在**取舍**上：端口表要如实列出机器上的一切，启动台要列出
  「点一下能用的东西」。所以这里做三件端口表不做的事——挡掉不是 HTTP 的、把同一个进程的
  多个端口并成一项、给每一项起一个人能认出来的名字。
*/
import type { ListeningService } from '../../shared/api/serverMonitor';

export type LaunchApp = {
  /** 打开哪个端口。同一进程占多个端口时，这是挑出来的那一个。 */
  port: number;
  /** 卡片上显示的名字。 */
  name: string;
  /** 名字下面那行小字：从哪条会话起的，或者命令行。 */
  detail: string | null;
  /** 属于哪条 roost 会话；认不出是 null。 */
  terminalId: string | null;
  /** 这个进程还占着的其他端口，显示在详情里。 */
  alsoOn: number[];
  pid: number;
};

/** 名字本身不区分任何东西的那些词。见 `appName`。 */
const RUNTIME = /^(?:node|bun|deno|python\d?(?:\.\d+)?|ruby|perl|php|java)$/i;

/**
 * 从命令行里取一个能当应用名的词。
 *
 * 卡片是用来**认**的，所以只要一个词：`vite --port 5199 --strictPort` 就叫 `vite`，
 * 参数留在 detail 里。
 *
 * **但第一个词经常是解释器，而解释器名不区分任何东西。** 实测本机 11 张卡里有两张叫
 * `python`、两张叫 `node`——一屏四张卡两两同名，这个列表就白排了。所以第一个词是解释器
 * 时再往后找：
 *
 * - `python -m retainpdf_ai` → `retainpdf_ai`（`-m` 后面就是模块名，这一格是明确的）
 * - `node --import tsx backend/src/index.ts` → `index.ts`（取最后一个像脚本的段）
 * - `node -e <一段内联代码>` → 仍然是 `node`（后面没有脚本，硬取会取到那段代码）
 *
 * 注：这里的示例刻意不写成真的内联代码。`check-boundaries` 扫的是文本，不剥注释，
 * 注释里出现一个 `require("…")` 会被当成真的依赖拦下来——第一版就是这么被拦的。
 *
 * 找不到更好的就退回解释器名——**宁可两张卡同名，也不要把一段代码当标题**。
 */
export function appName(label: string | null, port: number): string {
  const words = label?.trim().split(/\s+/).filter(Boolean) ?? [];
  // 没有命令行（进程已退出，但端口还在 lsof 里）时用端口号，别画一张没名字的卡片。
  if (!words.length) return `:${port}`;
  const [first, ...rest] = words;
  if (!RUNTIME.test(first!)) return first!;
  const moduleFlag = rest.indexOf('-m');
  if (moduleFlag >= 0 && rest[moduleFlag + 1] && !rest[moduleFlag + 1]!.startsWith('-')) return rest[moduleFlag + 1]!;
  // 像脚本的段：带扩展名，或者是个路径。取**最后一个**——`--import tsx foo.ts` 里
  // 真正被跑的是 foo.ts，tsx 只是加载器。
  // 取**最后一个**：`--require ./setup.js server.js` 里真正被跑的是 server.js。
  const script = rest.filter(word => !word.startsWith('-') && /\.[a-z]{1,5}$|\//i.test(word)).at(-1);
  return script ? script.slice(script.lastIndexOf('/') + 1) : first!;
}

/**
 * 同一个进程占了多个端口时，挑一个当「打开」的目标。
 *
 * **挑最小的那个。** 这不是随便定的：一个进程同时监听多个端口时，小的那个几乎总是
 * 主服务，大的是调试端口、metrics、或者随机分配的辅助端口（本机 retain-pdf 那个进程
 * 就是 41000 主服务 + 42000 辅助）。挑错了点开是一张 404。
 */
export function primaryPort(ports: readonly number[]): number {
  return [...ports].sort((a, b) => a - b)[0]!;
}

/**
 * 端口表 → 启动台。
 *
 * **`http === false` 的一律挡掉，`null` 的一律放行。** null 是「没探测」，把它当成
 * 「不是 HTTP」会让整个启动台变空——这两格的区别就是为此存在的。
 */
export function launchApps(services: readonly ListeningService[],
  titleOf: (terminalId: string) => string | undefined): LaunchApp[] {
  const byPid = new Map<number, ListeningService[]>();
  for (const service of services) {
    if (service.port === null || service.http === false) continue;
    byPid.set(service.pid, [...(byPid.get(service.pid) ?? []), service]);
  }
  const apps: LaunchApp[] = [];
  for (const [pid, group] of byPid) {
    const ports = group.map(service => service.port!);
    const port = primaryPort(ports);
    const service = group.find(one => one.port === port)!;
    const title = service.terminalId ? titleOf(service.terminalId) : undefined;
    apps.push({
      port, pid, terminalId: service.terminalId,
      name: appName(service.label, port),
      /*
        detail 优先显示会话标题：「这东西是我在哪儿起的」比再看一遍命令行有用得多。
        认不出会话时退回命令行——那时命令行是唯一的线索。
      */
      detail: title ?? (service.terminalId ? service.terminalId : service.label),
      alsoOn: ports.filter(other => other !== port).sort((a, b) => a - b),
    });
  }
  /*
    排序：认得出会话的排前面，其余按端口号。

    启动台上人要找的几乎总是自己刚起的那个，而那正是认得出会话的一批；把它们压在
    Chrome 的调试端口下面，等于每次都要扫一遍才找得到。
  */
  return apps.sort((a, b) =>
    Number(!!b.terminalId) - Number(!!a.terminalId) || a.port - b.port);
}

/** 这个应用在 roost 上的地址。反代那一层认的就是这个前缀。 */
export const appUrl = (port: number) => `/api/app/${port}/`;
