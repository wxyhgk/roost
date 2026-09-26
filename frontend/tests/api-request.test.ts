import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { request, fetchWithSession, onSessionExpired, acceptAuthenticatedSession } from "../src/shared/api/request.ts";
import { request as libraryRequest } from "../src/features/library/api.ts";
import { createCliConfigStore } from "../src/shared/cli-configs/store.ts";
import { listDir, readFilePreview } from "../src/shared/api/files.ts";

/*
  `session-fetch` 的「已登出就不再发请求」是**模块级**状态（和 authGeneration 一样，一个页面
  一个会话）。用例之间会继承它：前一个用例触发过 401，下一个用例的请求就会被短路，连 mock
  都碰不到。所以每个用例显式声明自己从「已登录」开始。
*/
beforeEach(() => acceptAuthenticatedSession());

const realFetch = globalThis.fetch;
async function withFetch<T>(stub: typeof globalThis.fetch, run: () => Promise<T>) {
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = realFetch; }
}
const respond = (status: number, body: string) =>
  (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;

test("an unreachable backend reports in the UI language, not the browser's", async () => {
  // fetch rejects with a browser-authored English message; it used to reach the sidebar verbatim.
  await withFetch((async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof globalThis.fetch,
    async () => {
      await assert.rejects(request("/api/workspace"), (err: Error) => {
        assert.equal(err.message, "无法连接后端");
        return true;
      });
    });
});

test("an aborted or timed-out request is named as such", async () => {
  for (const name of ["TimeoutError", "AbortError"]) {
    await withFetch((async () => { throw new DOMException("aborted", name); }) as unknown as typeof globalThis.fetch,
      async () => {
        await assert.rejects(request("/api/workspace"), (err: Error) => {
          assert.equal(err.message, "请求超时");
          return true;
        });
      });
  }
});

test("a backend error keeps its own body, and falls back to a translated status", async () => {
  await withFetch(respond(409, "目标文件已被修改"), async () => {
    await assert.rejects(request("/api/file"), (err: Error) => {
      assert.equal(err.message, "目标文件已被修改", "the backend's own wording wins");
      return true;
    });
  });
  await withFetch(respond(500, ""), async () => {
    await assert.rejects(request("/api/file"), (err: Error) => {
      assert.equal(err.message, "请求失败（500）");
      return true;
    });
  });
});

test("a successful response is parsed as JSON", async () => {
  await withFetch(respond(200, '{"ok":true}'), async () => {
    assert.deepEqual(await request("/api/workspace"), { ok: true });
  });
});

test("a stable code is shown in the UI language, not the backend's wording", async () => {
  // code 完全确定含义时，后端那句英文只是实现细节。
  await withFetch(respond(403, JSON.stringify({ error: { code: "path_escape", message: "path escapes workspace" } })),
    async () => {
      await assert.rejects(request("/api/fs"), (err: Error) => {
        assert.equal(err.message, "路径超出工作目录范围");
        return true;
      });
    });
});

test("validation messages survive, because only the backend knows which field failed", async () => {
  // invalid_request 的 message 本身是载荷，覆盖成「请求无效」等于删掉用户需要的信息。
  await withFetch(respond(400, JSON.stringify({ error: { code: "invalid_request", message: "priority must be an integer between -1000 and 1000" } })),
    async () => {
      await assert.rejects(request("/api/cli-configs"), (err: Error) => {
        assert.equal(err.message, "priority must be an integer between -1000 and 1000");
        return true;
      });
    });
});

test("an unknown code falls back rather than showing a blank or a raw code", async () => {
  await withFetch(respond(418, JSON.stringify({ error: { code: "brand_new_code", message: "" } })),
    async () => {
      await assert.rejects(request("/api/file"), (err: Error) => {
        assert.equal(err.message, "请求失败（418）");
        return true;
      });
    });
});

test("a proxy HTML error page is never rendered as the message", async () => {
  await withFetch(respond(502, "<html><body><h1>502 Bad Gateway</h1></body></html>"),
    async () => {
      await assert.rejects(request("/api/workspace"), (err: Error) => {
        assert.equal(err.message, "请求失败（502）");
        return true;
      });
    });
});

test("the 409 conflict body still carries the current file for the conflict UI", async () => {
  const conflict = { message: "file changed", mtime: 42, content: "disk", name: "a.ts", path: "a.ts", binary: false, truncated: false };
  await withFetch(respond(409, JSON.stringify({ ...conflict, error: { code: "file_conflict", message: "file changed" } })),
    async () => {
      await assert.rejects(request("/api/file"), (err: Error & { code?: string; body?: Record<string, unknown> }) => {
        assert.equal(err.message, "文件已被其他程序修改");
        assert.equal(err.code, "file_conflict");
        assert.equal(err.body?.mtime, 42, "the flat conflict preview is preserved alongside error{}");
        return true;
      });
    });
});


/*
  文件读取必须自带截止时间。

  没有它的时候，一个不回来的请求会让文件面板永远停在「加载中…」：promise 不 settle，
  `finally` 不跑，`loading` 不清——界面既不报错也不给重试入口。这不是理论问题，
  是实际遇到过的现象。有限的失败远好过无限的沉默。
*/
test("目录列表带着截止时间发出，不会永远等下去", async () => {
  let seen: AbortSignal | undefined | null;
  await withFetch((async (_input: unknown, init?: RequestInit) => {
    seen = init?.signal;
    return new Response("[]");
  }) as unknown as typeof globalThis.fetch, () => listDir("/root", ""));
  assert.ok(seen instanceof AbortSignal, "listDir 必须给 fetch 传一个 signal");
  assert.equal(seen.aborted, false);
});

test("文件预览同样带截止时间", async () => {
  let seen: AbortSignal | undefined | null;
  await withFetch((async (_input: unknown, init?: RequestInit) => {
    seen = init?.signal;
    return new Response(JSON.stringify({ name: "a", path: "a", binary: false, truncated: false, content: "", mtime: 0 }));
  }) as unknown as typeof globalThis.fetch, () => readFilePreview("/root", "a"));
  assert.ok(seen instanceof AbortSignal);
});

/*
  调用方的 signal 和超时是**两个**理由，必须同时生效。

  用调用方的 signal 顶掉超时（或反过来）都会退回原来的毛病：前者让挂死的请求重新
  变成无限等待，后者让切目录时的旧请求继续占着连接、在慢链路上排在新请求前面。
*/
test("effect 清理时中止，请求立刻结束而不是等超时", async () => {
  const controller = new AbortController();
  await withFetch((async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    // 真实的 fetch 就是这样响应 signal 的：中止即拒绝，不管超时还有多久。
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as unknown as typeof globalThis.fetch, async () => {
    const pending = listDir("/root", "", controller.signal);
    controller.abort();
    await assert.rejects(pending, (err: Error) => {
      assert.equal(err.message, "请求超时");
      return true;
    });
  });
});

/*
  兜底截止时间必须在 `request()` 这一层，不能指望每个调用点自己记得传。

  漏掉的代价不是「慢一点」：一个不回来的请求会把调用方永久钉在加载态。最坏的一处是
  登录关卡——它是页面第一个请求、也是唯一的解锁条件，而那里的重试按钮只在 error
  分支渲染，所以它挂住就是整页死锁，用户只能刷新。
*/
test("没传任何 init 的请求也带着截止时间发出", async () => {
  let seen: AbortSignal | undefined | null;
  await withFetch((async (_input: unknown, init?: RequestInit) => {
    seen = init?.signal;
    return new Response("{}");
  }) as unknown as typeof globalThis.fetch, () => request("/api/auth/session"));
  assert.ok(seen instanceof AbortSignal, "request() 必须自带兜底 signal");
  assert.equal(seen.aborted, false);
});

test("调用方传了自己的 signal 时，兜底不被顶掉、调用方也不被顶掉", async () => {
  const controller = new AbortController();
  await withFetch((async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as unknown as typeof globalThis.fetch, async () => {
    const pending = request("/api/workspace", { signal: controller.signal });
    controller.abort();
    // 调用方那一侧仍然生效：说明合并没有丢掉它
    await assert.rejects(pending, (err: Error) => {
      assert.equal(err.message, "请求超时");
      return true;
    });
  });
});

/*
  401 广播和兜底截止时间这两件事**必须对每一个请求都成立**，不只是走 `request<T>` 的那些。

  `features/library`（笔记/片段/命令面板）和 `shared/cli-configs`（所有 SessionLogo 的图标
  来源）原来用裸 `fetch`：会话过期时它们的 401 不触发登录关卡，界面停在那儿而人不知道
  自己已经登出；请求挂住就永远停在「加载中」，没有重试入口。
*/
test("fetchWithSession 也广播 401——绕过它的调用方原来会静默停在登出状态", async () => {
  const seen: string[] = [];
  const off = onSessionExpired(() => seen.push("expired"));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const res = await fetchWithSession("/api/anything");
    assert.equal(res.status, 401, "响应原样交回调用方——错误类型归它自己管");
    assert.deepEqual(seen, ["expired"]);
  } finally { globalThis.fetch = original; off(); }
});

test("非 401 不广播", async () => {
  const seen: string[] = [];
  const off = onSessionExpired(() => seen.push("expired"));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    await fetchWithSession("/api/anything");
    assert.deepEqual(seen, [], "500 不是登出");
  } finally { globalThis.fetch = original; off(); }
});

test("调用方自己的 signal 仍然有效——截止时间是第二个中止理由,不是替代", async () => {
  /*
    合并而不是覆盖：调用方的 signal 被覆盖的话，切走的请求会继续占着连接、在慢链路上
    排在新请求前面；截止时间被覆盖的话，挂死的请求又变回无限等待。
  */
  const original = globalThis.fetch;
  try {
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const controller = new AbortController();
    const pending = fetchWithSession("/api/slow", { signal: controller.signal });
    controller.abort();
    /*
      **不能直接 `assert.rejects`**：signal 真被覆盖时这个 promise 永远不落地，用例表现为
      整个测试进程挂死而不是失败——那是个糟糕的信号，看不出是哪一条坏了。
      和一个短定时器赛跑，把「挂住」变成一句明确的断言失败。
    */
    const settled = await Promise.race([
      pending.then(() => "resolved", (err: Error) => err.name),
      new Promise<string>(resolve => setTimeout(() => resolve("挂住了"), 200)),
    ]);
    assert.equal(settled, "AbortError", "调用方 abort 之后请求必须真的中止；挂住说明 signal 被截止时间覆盖了");
  } finally { globalThis.fetch = original; }
});

/*
  下面两条测的是**接线**，不是逻辑。

  上面那些只证明 `fetchWithSession` 自己会广播 401；变异测试显示把 library 和 cli-configs
  改回裸 `fetch`，所有用例照样绿——也就是说「它们真的走了这一层」从来没有被钉住过。
  这一类「逻辑有覆盖、接线没有」的缺口，这一轮里已经出现第三次了。
*/
test("library 的请求走 fetchWithSession——否则笔记和命令面板的 401 静默丢掉", async () => {
  const seen: string[] = [];
  const off = onSessionExpired(() => seen.push("expired"));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "authentication_required" } }), { status: 401 })) as typeof fetch;
    await libraryRequest("notes").catch(() => {});
    assert.deepEqual(seen, ["expired"]);
  } finally { globalThis.fetch = original; off(); }
});

test("cli-configs 的默认 transport 也走它——所有 SessionLogo 的图标都从这儿来", async () => {
  const seen: string[] = [];
  const off = onSessionExpired(() => seen.push("expired"));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    // 不注入 transport，正是要验默认值这一格。
    await createCliConfigStore().refresh().catch(() => {});
    assert.deepEqual(seen, ["expired"]);
  } finally { globalThis.fetch = original; off(); }
});
