// 跨面板跳转通道：命令面板发布，目标面板消费。
// 发布时目标可能尚未挂载（右面板按 tab 条件挂载），因此保留一份 pending，
// 订阅方挂载时 takeNav 取走；已挂载的走实时订阅。单次消费，取走即清。
export type NavTarget =
  | { kind: "file"; path: string }
  | { kind: "note"; id: string }
  | { kind: "snippet"; id: string };

type NavRequest = NavTarget & { nonce: number };

const listeners = new Set<(r: NavRequest) => void>();
let pending: NavRequest | null = null;
let seq = 0;

export function publishNav(target: NavTarget) {
  const req: NavRequest = { ...target, nonce: ++seq };
  pending = req;
  for (const fn of [...listeners]) fn(req);
}

export function subscribeNav(fn: (r: NavRequest) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// 取走匹配的 pending（单次消费）；同时清掉，避免以后误触。
export function takeNav(kind: NavTarget["kind"]): NavRequest | null {
  if (pending && pending.kind === kind) {
    const req = pending;
    pending = null;
    return req;
  }
  return null;
}

export function clearNav(req: NavRequest) {
  if (pending === req) pending = null;
}
