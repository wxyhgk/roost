import assert from "node:assert/strict";
import { test } from "node:test";
import { noticeOf } from "../src/features/conversations/directSend.ts";
import type { DirectInputResult } from "@roost/terminal-protocol";

test("发成了：清空输入框，一闪而过的确认，不叫人去终端", () => {
  assert.deepEqual(
    { ...noticeOf({ status: "submitted", cli: "claude" }), text: "" },
    { tone: "ok", text: "", clear: true, jump: false });
});

test("只贴没按回车：也清空——正文已经停在终端输入框里，这边再留一份就会发两遍", () => {
  const notice = noticeOf({ status: "pasted", cli: "claude" });
  assert.equal(notice.clear, true);
  assert.equal(notice.jump, true, "要你去终端按那一下");
  assert.equal(notice.tone, "warn");
});

test("被挡下：一个字都没写，原文留着；只有去终端能解决的才给跳转", () => {
  const held = (reason: string) => noticeOf({ status: "held", reason, cli: "claude" } as DirectInputResult);
  for (const reason of ["dialog", "not_cli", "foreground_unknown", "screen_unavailable", "no_input_box"]) {
    assert.equal(held(reason).clear, false, reason);
    assert.equal(held(reason).tone, "warn", reason);
    assert.ok(held(reason).text && !held(reason).text.includes(reason), `${reason} 要有一句人话，不能漏出标识符`);
  }
  assert.equal(held("dialog").jump, true);
  assert.equal(held("no_input_box").jump, true);
  assert.equal(held("not_cli").jump, false, "shell 在前台，去了终端也没什么可做");
  assert.equal(held("foreground_unknown").jump, false);
  assert.ok(held("some_new_reason").text, "新原因退回一句通用的话");
});

test("认不出的结果：不清空、不宣布成功", () => {
  const notice = noticeOf({ status: "expired" } as unknown as DirectInputResult);
  assert.equal(notice.clear, false);
  assert.equal(notice.tone, "warn");
});
