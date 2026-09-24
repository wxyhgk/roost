import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseServiceUnits } from '../src/features/server-monitor/units.ts';

test('service units come from newlines or commas, and blank draft is a valid empty list', () => {
  assert.deepEqual(parseServiceUnits(''), { units: [], invalid: false });
  /* 「一个都不监控」是合法的选择——清空文本框保存，等于把这张表关掉，不该报格式错。 */
  assert.deepEqual(parseServiceUnits('\n\n , , \n'), { units: [], invalid: false });
  assert.deepEqual(parseServiceUnits('  sshd.service \n, nginx.service,\ncom.roost.web  ').units,
    ['sshd.service', 'nginx.service', 'com.roost.web']);
  // 两边各自的合法形状都要收：systemd 的 `name@instance.service`、launchd 的反域名标签。
  assert.deepEqual(parseServiceUnits('getty@tty1.service\nssh-agent:0\na_b-c.d').invalid, false);
});

test('one bad unit rejects the whole draft, and the parsed list still comes back', () => {
  /*
    **整份拒绝，不是逐条剔除。** 静默丢掉打错的那一条会让保存「成功」之后界面上少一行，
    而少的正是他刚敲的那行。所以只要有一条不合法，invalid 就为真，一条都不该保存。
  */
  const bad = parseServiceUnits('sshd.service\n../etc/passwd\nnginx.service');
  assert.equal(bad.invalid, true);
  assert.deepEqual(bad.units, ['sshd.service', '../etc/passwd', 'nginx.service']);
  for (const unit of ['-leading.dash', '.hidden', '_under', 'has space', 'semi;colon', 'quote"d', '$var', 'a/b'])
    assert.equal(parseServiceUnits(unit).invalid, true, unit);
  for (const unit of ['0', 'Z', 'a-b', 'a_b', 'a.b', 'a@b', 'a:b'])
    assert.equal(parseServiceUnits(unit).invalid, false, unit);
});

test('the count and length ceilings are the last accepted value, not the first rejected one', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `s${i}.service`).join('\n');
  assert.equal(parseServiceUnits(list(24)).invalid, false);
  assert.equal(parseServiceUnits(list(25)).invalid, true);
  // 条数超限时 units 照样是切好的 25 条：判据在 invalid 上，不靠把列表截短来表达。
  assert.equal(parseServiceUnits(list(25)).units.length, 25);
  assert.equal(parseServiceUnits('a'.repeat(180)).invalid, false);
  assert.equal(parseServiceUnits('a'.repeat(181)).invalid, true);
  /* 长度算的是单条，不是整段：24 条各 180 字符（共 4 KB 出头）是合法的。 */
  assert.equal(parseServiceUnits(Array.from({ length: 24 }, () => 'a'.repeat(180)).join(',')).invalid, false);
});
