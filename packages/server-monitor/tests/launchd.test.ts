import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLabels, parseCpuTime, parseDisabled, parseElapsed, parseLaunchdPrint, parsePs, toServiceInfo } from '../src/launchd.ts';

/* 取自真实的 `launchctl print gui/501/com.roost.terminal`，只删掉了无关的长段落。 */
const PRINT = `gui/501/com.roost.terminal = {
	active count = 1
	path = /Users/u/Library/LaunchAgents/com.roost.terminal.plist
	type = LaunchAgent
	state = running

	program = /opt/node/bin/node
	arguments = {
		/opt/node/bin/node
		--import
		tsx
		deploy/terminal-owner.mts
	}

	environment = {
		PATH => /opt/node/bin:/usr/bin
		state => 这一行是陷阱
	}

	domain = gui/501 [100015]
	runs = 3
	pid = 33913
	last exit code = (never exited)

	resource coalition = {
		ID = 26647
		state = active
		name = com.roost.terminal
	}
}`;

/*
  输出是一棵缩进树，嵌套块里也有 state=、name= 这类键。只认最外层那一级缩进，
  否则 resource coalition 里的 `state = active` 会盖掉服务真正的 `state = running`。
*/
test('print 只取最外层的键，不被嵌套块里的同名键污染', () => {
  const fields = parseLaunchdPrint(PRINT);
  assert.equal(fields.state, 'running');
  assert.equal(fields.pid, '33913');
  assert.equal(fields.runs, '3');
  assert.equal(fields['last exit code'], '(never exited)');
  assert.equal(fields.path, '/Users/u/Library/LaunchAgents/com.roost.terminal.plist');
  // 嵌套块内部的东西一律不要。
  assert.equal(fields.ID, undefined);
  assert.equal(fields.name, undefined);
});

test('runs 是启动次数，重启次数要减一', () => {
  const info = toServiceInfo('com.roost.terminal', parseLaunchdPrint(PRINT), { memory: 1024, cpuSeconds: 2, uptime: 60 }, false);
  // 第一次起来就是 runs=1；照抄的话每个刚装好的服务都会显示「重启过 1 次」。
  assert.equal(info.restarts, 2);
  assert.equal(info.active, 'active');
  assert.equal(info.sub, 'running');
  assert.equal(info.pid, 33913);
  assert.equal(info.result, 'success');
  assert.equal(info.enabled, 'enabled');
  assert.deepEqual([info.memory, info.cpuSeconds, info.uptime], [1024, 2, 60]);
  // launchd 没有服务描述，macOS 没有 cgroup——这两格如实留空，不编。
  assert.equal(info.description, '');
  assert.equal(info.tasks, null);
});

test('没装载的服务降级成 not-found，不抛错', () => {
  const info = toServiceInfo('com.nope', null, undefined, false);
  assert.equal(info.load, 'not-found');
  assert.equal(info.active, 'unknown');
  assert.equal(info.pid, null);
});

test('非零退出码记成 exit-code', () => {
  const fields = { state: 'not running', runs: '5', 'last exit code': '1' };
  assert.equal(toServiceInfo('x', fields, undefined, false).result, 'exit-code');
  assert.equal(toServiceInfo('x', { ...fields, 'last exit code': '0' }, undefined, false).result, 'success');
  assert.equal(toServiceInfo('x', { state: 'waiting' }, undefined, false).active, 'activating');
});

test('停用的服务标成 disabled', () => {
  assert.equal(toServiceInfo('x', parseLaunchdPrint(PRINT), undefined, true).enabled, 'disabled');
  const disabled = parseDisabled('disabled services = {\n\t"com.a" => disabled\n\t"com.b" => enabled\n\t"com.c" => true\n}');
  assert.deepEqual([...disabled].sort(), ['com.a', 'com.c']);
});

/* launchd 的标签不带 .service——normalizeServices 那边补后缀，在这边会指向一个不存在的东西。 */
test('标签校验不加 .service 后缀，并挡住注入与超量', () => {
  assert.deepEqual(normalizeLabels(['com.roost.terminal', 'caddy', 'com.roost.terminal']), ['com.roost.terminal', 'caddy']);
  for (const bad of [['a;id'], ['--all'], ['/etc/passwd'], ['x y'], ['$(id)'], ['a\nb'], Array(25).fill('a'), 'a', [1]]) {
    assert.throws(() => normalizeLabels(bad as unknown[]));
  }
});

test('ps 的 etime 三种格式都认，rss 从 KiB 换成字节', () => {
  assert.equal(parseElapsed('05:30'), 330);
  assert.equal(parseElapsed('01:00:00'), 3600);
  assert.equal(parseElapsed('2-03:04:05'), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(parseElapsed('乱码'), null);
  assert.equal(parseCpuTime('0:45.51'), 45.51);
  assert.equal(parseCpuTime('1:02:03'), 3723);
  const samples = parsePs(' 33913 247392 36:08 0:45.51\n 33915  12000 01:00:00 1:02:03\n垃圾行\n');
  assert.deepEqual(samples.get(33913), { memory: 247392 * 1024, cpuSeconds: 45.51, uptime: 36 * 60 + 8 });
  assert.equal(samples.get(33915)?.uptime, 3600);
  assert.equal(samples.size, 2);
});
