/*
  把「要监控哪些服务」那个文本框里的一段自由文本解析成清单。

  **整份拒绝，不逐条剔除。** 这份名单是用户自己一行行敲进去的，里面有一条打错时静默丢掉
  那一条、保存剩下的，等于替他做了一个他没同意的决定——保存成功之后界面上少了一行，
  而少的正是他刚敲的那行。所以 `invalid` 一旦为真，调用方一条都不保存，让他自己改。

  分隔符收两种：换行是这个多行文本框的自然形状，逗号是从别处粘进来的形状。

  上限（24 条 / 每条 180 字符）挡的是把一整份 `systemctl list-units` 粘进来这种事：
  launchd 那边每条名字都要 fork 一次 `launchctl print`（见 server-monitor 包里的
  `readLaunchdServices`），条数是直接乘在 5 秒那条轮询的成本上的。
*/
const MAX_UNITS = 24, MAX_UNIT_LENGTH = 180;
/** systemd 的 unit 名和 launchd 的标签共用这一条：字母数字开头，后面允许 `_.@:-`。 */
const UNIT = /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/;
export function parseServiceUnits(draft: string): { units: string[]; invalid: boolean } {
  const units = draft.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  return { units, invalid: units.length > MAX_UNITS || units.some(s => s.length > MAX_UNIT_LENGTH || !UNIT.test(s)) };
}
