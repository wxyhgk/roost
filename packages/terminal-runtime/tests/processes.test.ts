import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cliForPid } from '../src/processes.ts';

test('CLI discovery delegates executable recognition and handles direct PTYs and nested launchers', () => {
  assert.equal(cliForPid(1, [{pid:1,ppid:0,args:'/opt/opencode'}]), 'opencode');
  assert.equal(cliForPid(1, [
    {pid:1,ppid:0,args:'/bin/zsh'}, {pid:2,ppid:1,args:'echo claude'},
    {pid:3,ppid:1,args:'node /opt/node_modules/@qwen-code/qwen-code/cli.js'},
  ]), 'qwen');
  assert.equal(cliForPid(1, [{pid:1,ppid:2,args:'zsh'},{pid:2,ppid:1,args:'sh'}]), null);
});
