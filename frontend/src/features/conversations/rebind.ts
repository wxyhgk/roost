import { ApiError } from "../../shared/api/errors";
import type { AiBinding } from "../../shared/api/conversations";

/*
  把一条终端的 AI 绑定挪到当前活着的那条 PTY 上，失败就重试。

  **为什么必须重试，而不是「顺手加上更稳妥」**：绑定的 `revision` 涨得很快——实测约 1 次/秒，
  因为 transcript 摄取一直在往同一条记录上写。而一次换绑要走「读绑定 → 服务端读 PTY 日志
  核验身份 → 写入」整条链，几百毫秒足够它变一次。

  这不是推演，是实测撞到的：第一次手工调用就拿到了 409 `binding version changed`，第二次
  带重试的第一发才成功。**不重试的按钮会随机失败，而且抛给用户的是一句他完全看不懂的话。**

  只重试版本竞态这一种。别的 409（身份认不出、原生会话已被别的终端占着）都是「情况确实不对」，
  重试一百次也一样，而且会把真正的原因盖掉。
*/

/** 服务端在乐观并发失败时给的原话。只认这一句，别的 409 一律不重试。 */
const VERSION_RACE = "binding version changed";

export const MAX_ATTEMPTS = 8;

function isVersionRace(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409
    && (error.serverMessage === VERSION_RACE || error.message === VERSION_RACE);
}

export type RebindIdentity = { terminalInstanceId: string; cliId: string; nativeSessionId: string };

/**
 * 读一次当前版本、换一次绑定；版本被人抢先就重来。
 *
 * 每一轮都**重新读**版本号——拿上一轮那个过期的重试是没有意义的，它注定再输一次。
 */
export async function rebindWithRetry(options: {
  read(): Promise<{ binding: AiBinding }>;
  write(body: RebindIdentity & { expectedGeneration: string; expectedRevision: number }): Promise<{ binding: AiBinding }>;
  identity: RebindIdentity;
  attempts?: number;
}): Promise<AiBinding> {
  const attempts = options.attempts ?? MAX_ATTEMPTS;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { binding } = await options.read();
    try {
      const result = await options.write({
        expectedGeneration: binding.generation,
        expectedRevision: binding.revision,
        ...options.identity,
      });
      return result.binding;
    } catch (error) {
      if (!isVersionRace(error)) throw error;
      last = error;
    }
  }
  throw last;
}
