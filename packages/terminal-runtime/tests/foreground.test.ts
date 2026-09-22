import test from 'node:test';
import assert from 'node:assert/strict';
import { foregroundCli } from '../src/processes.ts';

/*
  前台归属：我们写进 PTY 的字节到底会被谁收到。

  判据是 tpgid——内核记录的「这个终端的前台进程组」。`pid === tpgid` 那一行就是前台进程组
  的组长，即真正在读键盘的那个进程。

  这道闸存在的理由：cliForPid 在整棵子树里找 CLI、找到就返回，所以 claude 起了 vim 时它
  仍然回答「claude」。而 vim 的 normal mode 下正文本身就是命令，**危险全在正文里，不在
  回车里**——「不按回车」那道闸对这种情况一点用都没有。
*/
const row = (pid: number, ppid: number, pgid: number, tpgid: number, args: string) =>
  ({ pid, ppid, pgid, tpgid, args });

test('前台是 claude 时认出来', () => {
  const rows = [row(100, 1, 100, 200, '/bin/zsh -l'), row(200, 100, 200, 200, 'claude')];
  assert.equal(foregroundCli(100, rows), 'claude');
});

test('claude 起了 vim 时，前台不是 claude —— 这是这道闸的全部理由', () => {
  // claude 还在树里（cliForPid 会找到它并回答 claude），但键盘归 vim。
  const rows = [
    row(100, 1, 100, 300, '/bin/zsh -l'),
    row(200, 100, 200, 300, 'claude'),
    row(300, 200, 300, 300, 'vim /tmp/COMMIT_EDITMSG'),
  ];
  assert.equal(foregroundCli(100, rows), null, '必须是 null：前台确定不是 CLI');
  assert.notEqual(foregroundCli(100, rows), undefined, '这不是「判断不了」，是「确定不是」');
});

test('less 分页时同样拦住', () => {
  const rows = [
    row(100, 1, 100, 400, '/bin/zsh -l'),
    row(200, 100, 200, 400, 'claude'),
    row(400, 200, 400, 400, 'less'),
  ];
  assert.equal(foregroundCli(100, rows), null);
});

test('判断不了时返回 undefined，而不是假装前台没问题', () => {
  // 调用方必须把 undefined 当成「不写」。把它和 null 合并就等于「读不到就放行」。
  assert.equal(foregroundCli(100, []), undefined, '进程不在表里');
  // Windows 那条路的行数据没有 tpgid。
  assert.equal(foregroundCli(100, [{ pid: 100, ppid: 1, args: '/bin/zsh' }]), undefined, '没有 tpgid 字段');
  // tpgid = -1：该终端当前没有前台进程组，写进去没有确定的收件人。
  assert.equal(foregroundCli(100, [row(100, 1, 100, -1, '/bin/zsh')]), undefined, 'tpgid 为 -1');
  // 组长不在表里（刚退出）。
  assert.equal(foregroundCli(100, [row(100, 1, 100, 999, '/bin/zsh')]), undefined, '组长不在表里');
});

test('裸 shell 在前台时是 null，不是 undefined', () => {
  // CLI 退出了、回到提示符：确定地「前台不是 CLI」，和「判断不了」必须分开。
  const rows = [row(100, 1, 100, 100, '/bin/zsh -l')];
  assert.equal(foregroundCli(100, rows), null);
});

/*
  前台组的组长是 roost 自己的启动壳，CLI 是它同组的子进程。

  这不是假想：2026-09-22 在这台机器上实测，PTY 的 shell tpgid=72699，而 72699 是
  `node .../roost-cli-launch-XXXX/launch.mjs`，claude 是 72703，pgid 同为 72699。壳必须活着接 SIGINT
  （claude-launch.ts），所以它不能 exec 掉自己让 CLI 当组长。

  只看组长的话，「前台是不是 CLI」在自家终端里**恒为否**——从网页发出的消息永远卡在最后
  一道闸上，界面说「终端里现在是别的程序在前台」，而那个别的程序就是我们自己。
*/
test('前台组的组长是我们自己的启动壳时，要认出组里的 CLI', () => {
  const rows = [
    row(100, 1, 100, 200, '/bin/zsh -i -l -c'),
    row(200, 100, 200, 200, '/path/node /var/folders/xx/roost-cli-launch-AbCdEf/launch.mjs'),
    row(300, 200, 200, 200, 'claude --resume 3749983a'),
  ];
  assert.equal(foregroundCli(100, rows), 'claude', '同一个前台组里有 CLI，字节就是给它的');
});

test('扩大到组内查找，不会放宽 vim / less 那道防线', () => {
  // 作业控制把 vim 拉到前台时，它**自己是一个新的进程组**；扫那个组只有它自己。
  const rows = [
    row(100, 1, 100, 300, '/bin/zsh -i -l -c'),
    row(200, 100, 200, 300, '/path/node /var/folders/xx/roost-cli-launch-AbCdEf/launch.mjs'),
    row(250, 200, 200, 300, 'claude'),
    row(300, 250, 300, 300, 'vim /tmp/COMMIT_EDITMSG'),
  ];
  assert.equal(foregroundCli(100, rows), null, 'claude 在别的组里，键盘归 vim');
});

test('前台组里一个认得出的 CLI 都没有，仍然是「确定不是」', () => {
  const rows = [
    row(100, 1, 100, 200, '/bin/zsh -i -l -c'),
    row(200, 100, 200, 200, '/path/node /var/folders/xx/roost-cli-launch-AbCdEf/launch.mjs'),
    row(300, 200, 200, 200, 'npm run dev'),
  ];
  assert.equal(foregroundCli(100, rows), null);
  assert.notEqual(foregroundCli(100, rows), undefined, '这是「确定不是」，不是「判断不了」');
});
