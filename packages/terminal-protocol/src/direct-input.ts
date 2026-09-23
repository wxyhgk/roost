/**
 * 从网页往终端里的 CLI「直接打一句话」。
 *
 * 它取代的是 ai-commands 那条「排队 → 认领 → 核对身份链 → 等回执」的路：那条路每一环都是
 * 一道「不确定就拒绝」的闸，叠起来几乎不可能全部放行——上线以来零次成功投递，失败还会粘住
 * 后面所有消息。这里的模型是 VS Code 的 `sendText`、tmux 的 `send-keys`：**终端是主角，
 * 网页只是一个更好用的输入框。** 写给哪个终端，就是哪个终端；贴进去、按回车，当场完成。
 *
 * 只留一道闸：画面上是一个选择框的时候不按回车（那一下等于替用户做了选择）。
 * 结果只描述**这一句**发生了什么，从不影响下一句。
 */

/** 正文上限。按字节算：中文一个字三字节，按字符数判会放行超限的内容。 */
export const MAX_DIRECT_INPUT_BYTES = 16 * 1024;

export type DirectInputHold =
  /** 画面底部是一个选择框 / 权限框 / 菜单。按回车等于替用户选，所以一个字节都不写。 */
  | 'dialog'
  /** 前台不是 AI CLI（多半是 shell）。往 shell 里打字再回车就是执行一条命令。 */
  | 'not_cli'
  /** 判断不了前台是谁（进程表读不到等）。不知道收件人就不写。 */
  | 'foreground_unknown'
  /** 服务端没有这块屏幕（刚开、或解析器坏了），没法看一眼再写。 */
  | 'screen_unavailable'
  /** 前台是认得的 CLI，但画面上找不到它的输入框。 */
  | 'no_input_box';

export type DirectInputResult =
  /** 贴进去、看见了、按了回车。CLI 忙的时候它自己会排队（claude、omp 实测如此）。 */
  | { status: 'submitted'; cli: string }
  /** 贴进去了，但没在屏幕上看见它，所以没按回车。正文可能正停在输入框里。 */
  | { status: 'pasted'; cli: string }
  /** 什么都没写。原因见 DirectInputHold。 */
  | { status: 'held'; reason: DirectInputHold; cli: string | null };
