/*
  **这个模块一个 import 都不许有。**

  `features/library` 只准引用自己目录、或者「可证明是叶子」的共享模块（见
  `scripts/check-boundaries.mjs` 里 `LIBRARY_LEAF_IMPORTS` 那段）。那条规则的实现会在
  构建时检查名单里每个文件自己有没有 import——所以这里的「零依赖」不是一句约定，是机器
  盯着的事实。

  为什么要让 library 够得着这一块：401 广播和兜底截止时间是**必须对每一个请求都成立**的
  两件事，而 library 有自己的错误类型（`LibraryError` 要带 status 和冲突时的 `current`），
  用不了 `request<T>`。第一版直接让 library 引 `request.ts`，当场被边界检查拦下——拦得对，
  那个文件引着 i18n 和 errors，引它等于把整条链拖进 library。把这两件事单独放在这里，
  两边就都拿得到，而 library 仍然是叶子。

  一并搬过来的还有 `request<T>` 用的那份实现，所以两边用的是同一个，不是两份手抄。
*/
/**
 * 登录失效的全局信号。
 *
 * 401 可能从任何一个请求上回来（后台轮询、文件监听重连、发信……）。让每个调用点
 * 各自处理必然会漏，所以在这里统一广播一次，由登录关卡订阅。
 */
const expiredListeners = new Set<() => void>();
let authGeneration = 0;
/** A newly accepted cookie supersedes requests sent with the previous cookie. */
export function acceptAuthenticatedSession() { authGeneration++; }
export function onSessionExpired(fn: () => void) {
  expiredListeners.add(fn);
  return () => { expiredListeners.delete(fn); };
}

/**
 * 所有请求的兜底截止时间。
 *
 * 没有它的时候，一个不回来的请求会把调用方永远钉在「加载中」：promise 不 settle，
 * `finally` 不跑，loading 不清，界面既不报错也没有重试入口。
 *
 * 最坏的一处是登录关卡：`fetchAuthSession` 是页面发出的**第一个**请求，也是整个应用
 * 唯一的解锁条件，而那里的重试按钮只在 error 分支渲染——它挂住就是整页死锁，
 * 用户只能刷新页面。**有限的失败远好过无限的沉默。**
 *
 * 放在这一层而不是各个调用点：调用点总有漏的，而漏掉的代价是永久卡死。
 */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * `fetch` 的形状，但补上这一层**必须全局成立**的两件事：兜底截止时间，和 401 广播。
 *
 * 单独导出，是因为并不是每个调用方都能用上面那个 `request<T>`——它把响应体也一起管了
 * （解析 JSON、抛 `ApiError`），而 `features/library` 有自己的 `LibraryError`（要带
 * `status` 和冲突时的 `current`），`shared/cli-configs` 则是把 `fetch` 作为参数注入以便
 * 测试。这两处原来直接用裸 `fetch`，于是**绕过了这两件事**：
 *
 * - 会话过期时它们的 401 不会触发登录关卡，界面就停在那儿，而人不知道自己已经登出
 * - 请求挂住就永远停在「加载中」，没有重试入口——正是下面那段注释描述的失效模式
 *
 * 所以这一层给出裸 `Response`，body 和错误类型仍归调用方；两件全局的事一个都不少。
 */
export const fetchWithSession: typeof fetch = async (input, init) => {
  const generation = authGeneration;
  /*
    调用方自己的 signal（effect 清理、切换目标）和这道截止时间是**两个**中止理由，
    必须同时生效。用 any 合并而不是让谁覆盖谁：前者被覆盖的话，切走的请求会继续占着
    连接、在慢链路上排在新请求前面；后者被覆盖的话，挂死的请求又变回无限等待。
  */
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const res = await fetch(input, { ...init, signal });
  // 旧 Cookie 的迟到 401 仍向调用者报错，但不能撤销一次已成功的登录。
  // 注意**不要**在这里自动跳登录或重试：未提交的输入必须留在原地，由界面决定怎么提示。
  if (res.status === 401 && generation === authGeneration) for (const fn of [...expiredListeners]) fn();
  return res;
};

