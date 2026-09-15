import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canRun, sendBlock, shouldOfferRun } from "../src/features/conversations/sendability";
import { getLocale, getMessages, setLocale } from "@roost/i18n";

const live = { selectedHistory: false, current: false, state: "quiet" as const, cliId: "claude" };

test("CLI 在跑但没报到 —— daemon 重启后的必然状态", () => {
  // instanceId 不落盘，daemon 一重启全部换新，绑定要等 CLI 下一次报事件才更新。
  // 这正是用户遇到的那一种，它必须有自己的说法，不能落回「没有在跑的终端」。
  assert.equal(sendBlock(live), "unbound");
  assert.equal(sendBlock({ ...live, state: "active" }), "unbound");
});

test("状态流没连上时不谎报「没有 CLI」", () => {
  // 这三种状态下 cliId 一律是 null（store.ts 的 initial/disconnected/unknown 就是这么定的）。
  // 照着 cliId 判就会说「这个终端里没有 AI CLI」——我们其实什么都不知道。
  for (const state of ["connecting", "disconnected", "unavailable"] as const) {
    assert.equal(sendBlock({ ...live, state, cliId: null }), "statusOffline", state);
  }
});

test("终端真没了和终端里没 CLI 是两件事", () => {
  for (const state of ["exited", "closed", "unknown"] as const) {
    assert.equal(sendBlock({ ...live, state, cliId: null }), "terminalGone", state);
  }
  // 终端活着、只是没启动 CLI：做法是去启动一个，和上面那组完全不同。
  assert.equal(sendBlock({ ...live, state: "quiet", cliId: null }), "noCli");
  assert.equal(sendBlock({ ...live, state: "active", cliId: null }), "noCli");
});

test("自己选了历史不是故障；身份核验通过就能发", () => {
  // 选历史优先于一切：哪怕当前 CLI 正好在这个对话里，用户看的也是别的那条。
  assert.equal(sendBlock({ ...live, selectedHistory: true, current: true }), "history");
  assert.equal(sendBlock({ ...live, selectedHistory: true, state: "exited", cliId: null }), "history");
  assert.equal(sendBlock({ ...live, current: true }), null);
});

test("五种成因在两种语言里都各说各的", () => {
  // 反证的是「合并回一句」：只要有人把其中两条说成同一句话，这里立刻红。
  const previous = getLocale();
  try {
    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      const m = getMessages().misc.conversations.detail.send;
      const texts = [m.noRun, m.blocked.statusOffline, m.blocked.terminalGone, m.blocked.noCli, m.blocked.unbound];
      assert.equal(new Set(texts).size, texts.length, locale);
      // 两条能动手的必须给出做法，否则用户知道坏了也不知道怎么办。
      assert.ok(m.blocked.noCliHint.length > 0 && m.blocked.unboundHint.length > 0, locale);
    }
  } finally { setLocale(previous); }
});

const UUID = "550e8400-e29b-41d4-a716-446655440000";

test("能不能拼出恢复命令，判据和后端同一份", () => {
  assert.equal(canRun("claude", UUID), true);
  assert.equal(canRun("omp", "abc-123"), true);
  // gemini 在 registry 里没有 resume 配方：给它画按钮就是画一个必然失败的东西。
  assert.equal(canRun("gemini", UUID), false);
  assert.equal(canRun("claude", null), false);
  assert.equal(canRun(null, UUID), false);
});

test("CLI 已经附着时不给「跑起来」——两个进程抢同一份 transcript", () => {
  // 这条是这个按钮最危险的一格：unbound 的意思是「有 CLI 附着着，只是没报出是哪条」。
  // 后端的 already_running 拦不住它（它查的是 active run，而这一格定义上就没有），
  // 所以闸只能在这里。把它放开，就会开出第二个 claude 去 --resume 同一条会话。
  assert.equal(shouldOfferRun("unbound", "claude", UUID), false);
  // 什么都不知道的时候也不动手。
  assert.equal(shouldOfferRun("statusOffline", "claude", UUID), false);
});

test("没有已知附着进程的几格都给按钮", () => {
  for (const blocked of ["history", "terminalGone", "noCli", null] as const) {
    assert.equal(shouldOfferRun(blocked, "claude", UUID), true, String(blocked));
    // 不管哪一格，拼不出命令就一律不画。
    assert.equal(shouldOfferRun(blocked, "gemini", UUID), false, String(blocked));
  }
});
