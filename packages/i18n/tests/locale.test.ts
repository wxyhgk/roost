import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText, getLocale, getMessages, setLocale, subscribeLocale, t } from "../src/index.ts";

// 中日韩统一表意文字：英文包里出现即漏翻。
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 遍历文案树；函数用空串实参调用一次，返回值也算一条可检查的文案。 */
function walk(node: unknown, path: string, visit: (path: string, text: string) => void): void {
  if (typeof node === "string") return visit(path, node);
  if (typeof node === "function") {
    const fn = node as (...args: string[]) => unknown;
    const out = fn(...Array.from({ length: fn.length }, () => ""));
    if (typeof out === "string") visit(`${path}()`, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key, visit);
  }
}

test("英文包里没有漏翻的中文", () => {
  const previous = getLocale();
  setLocale("en");
  const leaked: string[] = [];
  walk(getMessages(), "", (path, text) => {
    // 语言名保留原生写法，两种语言下都显示「中文」。
    if (path === "settings.dialog.appearance.languageZh") return;
    if (CJK.test(text)) leaked.push(`${path} = ${JSON.stringify(text)}`);
  });
  setLocale(previous);
  assert.deepEqual(leaked, [], `以下文案仍是中文：\n${leaked.join("\n")}`);
});

test("t 与 errorText 跟随当前语言", () => {
  const previous = getLocale();
  setLocale("zh");
  assert.equal(t.library.saveState.saved, "已保存");
  assert.equal(errorText("not_found", 404), "目标不存在");
  setLocale("en");
  assert.equal(t.library.saveState.saved, "Saved");
  assert.equal(errorText("not_found", 404), "not found");
  setLocale(previous);
});

test("订阅者只在语言真正变化时收到通知", () => {
  const previous = getLocale();
  setLocale("zh");
  let calls = 0;
  const off = subscribeLocale(() => {
    calls++;
  });
  setLocale("zh");
  assert.equal(calls, 0, "设置成当前语言不应通知");
  setLocale("en");
  assert.equal(calls, 1);
  off();
  setLocale("zh");
  assert.equal(calls, 1, "退订后不应再收到通知");
  assert.equal(getLocale(), "zh");
  setLocale(previous);
});

test("英文可数名词在 n === 1 时用单数", () => {
  // 中文不区分单复数（「1 个会话」成立），所以逐字对译时这一层最容易漏；
  // 类型检查看签名、漏翻检测看有没有汉字，两者都发现不了「1 sessions」。
  setLocale("en");
  try {
    const cases: [string, string, string][] = [
      ["sidebar.count", t.sidebar.count(1), t.sidebar.count(2)],
      ["files.preview.lines", t.files.preview.lines(1), t.files.preview.lines(2)],
      ["terminal.diagnostics.contextLosses", t.terminal.diagnostics.contextLosses(1), t.terminal.diagnostics.contextLosses(2)],
    ];
    for (const [path, one, many] of cases) {
      assert.ok(!/\b1 \w+s\b/.test(one), `${path} 在 n=1 时仍是复数：${one}`);
      assert.notEqual(one, many, `${path} 单复数应当不同`);
    }
  } finally {
    setLocale("zh");
  }
});
