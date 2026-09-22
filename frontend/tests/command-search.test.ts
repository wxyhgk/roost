/*
  命令面板的打分。

  这几个函数决定「你想要的那一条排第几」，而它们**一个测试都没有**。失效模式不是崩溃，
  是搜不到——调错一个常数、把某一档的基数写反，表现只是「明明有这个文件，输进去却排在
  第七条」，没有人会报 bug，只会觉得这个面板不好用。

  所以这里钉的是**相对次序和分层意图**，不是具体数值。数值可以调，次序不能反；
  真要改次序，得先在这里改，那时就得说清楚为什么。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, matchFile, matchItem } from '../src/features/workspace/commandSearch';

test('不是子序列就是不匹配——不给「勉强算一点」的分', () => {
  assert.equal(fuzzyScore('abc', 'acb'), -1, '顺序不对不算');
  assert.equal(fuzzyScore('xyz', 'abc'), -1);
  assert.equal(fuzzyScore('abcd', 'abc'), -1, '查询比文本长');
  assert.ok(fuzzyScore('abc', 'abc') > 0);
});

test('空查询匹配一切——面板刚打开时要能列出东西', () => {
  assert.equal(matchItem('', 'whatever', 'sub'), 1);
  /*
    `matchItem` 那句 `if (!q) return 1` 不是多余的短路。空查询进 `fuzzyScore` 时循环一次
    都不跑，但末尾 `t.startsWith('')` 恒真、白送 20 分——于是**每一条都是 20，全场平局**，
    排序退化成输入顺序。显式返回 1 让「没输入时的排序」这件事由调用方自己决定。
  */
  assert.equal(fuzzyScore('', 'whatever'), 20);
  assert.equal(fuzzyScore('', 'anything else'), 20, '空查询对谁都是同一个分');
});

test('连着敲中的比零散拼出来的分高——这是模糊匹配唯一的立身之本', () => {
  /*
    两边都**不是前缀**，否则赢的是末尾那 20 分的前缀加成，连续加成去掉了也照样通过——
    我第一版就是这么写的，变异测试当场戳穿（把 `10 + consec * 5` 改成 `10` 仍然全绿）。
    零散那一侧还故意用 `-` 分隔，让它拿满词边界加成：连续必须在这种最不利的对比下还赢。
  */
  const together = fuzzyScore('roost', 'x-roost-config');
  const scattered = fuzzyScore('roost', 'x-r-o-o-s-t-config');
  assert.ok(together > scattered, `连续 ${together} 应该高于零散 ${scattered}`);
});

test('从头开始的比从中间开始的分高', () => {
  assert.ok(fuzzyScore('log', 'logger.ts') > fuzzyScore('log', 'catalog.ts'));
});

test('落在词边界上的比落在词中间的分高', () => {
  // 边界是 / 空格 - _ 四种，落在它们后面的那个字符额外加分。
  for (const sep of ['/', ' ', '-', '_']) {
    const boundary = fuzzyScore('b', `a${sep}b`);
    const middle = fuzzyScore('b', `axb`);
    assert.ok(boundary > middle, `分隔符 ${JSON.stringify(sep)}: ${boundary} 应高于 ${middle}`);
  }
});

/*
  文件的三档是这个面板最容易被改坏的地方：三档的基数（2000 / 1000 / raw）一旦写近了，
  「文件名里就有这个词」会被「路径里某处有这个词」盖过去，而后者往往有几十条。
*/
test('文件三档不许串档：文件名包含 > 路径包含 > 文件名模糊', () => {
  const nameHit = matchFile('server', 'server.ts', 'src/a/server.ts');
  const pathHit = matchFile('server', 'index.ts', 'src/server/index.ts');
  const fuzzyHit = matchFile('svr', 'server.ts', 'src/a/server.ts');
  assert.ok(nameHit > pathHit, `文件名命中 ${nameHit} 必须高于路径命中 ${pathHit}`);
  assert.ok(pathHit > fuzzyHit, `路径命中 ${pathHit} 必须高于模糊命中 ${fuzzyHit}`);
  assert.ok(fuzzyHit > 0);
});

test('同为文件名包含：前缀的优先，长度相同则短名优先', () => {
  assert.ok(matchFile('log', 'logger.ts', 'a/logger.ts') > matchFile('log', 'catalog.ts', 'a/catalog.ts'));
  // 长度扣分很轻（0.01/字符），只在其余条件相同时做平局裁决。
  const short = matchFile('log', 'log.ts', 'a/log.ts');
  const long = matchFile('log', 'log-with-a-very-long-name.ts', 'a/log-with-a-very-long-name.ts');
  assert.ok(short > long);
  assert.ok(long > 1000, '再长也不许掉进「路径包含」那一档');
  /*
    **长度扣分不许翻越前缀加成。** 前缀那 50 分表达的是「你就是在找这个」，而长度扣分只是
    平局裁决。系数一旦调大（比如从 0.01 改成 1），一个名字够长的前缀命中就会被一个短的
    中间命中压过去——那正是「明明打对了开头，想要的却排在后面」。

    这里故意用一个 60 字符的前缀命中对一个 9 字符的中间命中：0.01 下前者赢 50 分上下，
    系数改成 1 就会反过来。（变异测试发现的：原来那两句在 ×100 下照样全绿。）
  */
  const longPrefix = 'log' + 'a'.repeat(57);
  assert.ok(matchFile('log', longPrefix + '.ts', `a/${longPrefix}.ts`) > matchFile('log', 'catalog.ts', 'a/catalog.ts'),
    '打对开头的那个必须排在前面，不管它名字多长');
});

test('模糊只看文件名，不跨路径拼——否则深目录里什么都能拼出来', () => {
  assert.equal(matchFile('src', 'index.ts', 'src/a/index.ts'), 1000, '只应命中「路径包含」那一档');
  assert.equal(matchFile('zqx', 'index.ts', 'src/zqx/index.ts'), 1000);
  assert.equal(matchFile('zqx', 'index.ts', 'src/a/index.ts'), -1, '哪一档都不沾就是不匹配');
  /*
    关键的一条：查询在**路径里是子序列、但不是子串，而且在文件名里连子序列都不是**。
    三档都不该沾。把最后那句模糊回退从 `name` 改成 `path` 时，只有这条会红——
    前三句在两种写法下结果相同（变异测试发现的）。

    `sad` 在 `src/a/deep/index.ts` 里：s@0、a@4、d@6，是子序列；但不是子串，
    而 `index.ts` 里 s 之后再没有 a。
  */
  assert.equal(matchFile('sad', 'index.ts', 'src/a/deep/index.ts'), -1,
    '跨路径拼出来的子序列不算——否则目录一深，什么查询都能在某条路径上拼出来');
});

test('条目会连 sub 一起匹配，但取两者较高的那个', () => {
  // 只有 sub 里有的词也能搜到。
  assert.ok(matchItem('python', 'untitled', 'python') > 0);
  // 标题能单独命中时，不该因为拼上 sub 变长而掉分。
  const titleOnly = matchItem('note', 'note', '');
  const withSub = matchItem('note', 'note', 'plaintext');
  assert.ok(withSub >= titleOnly);
});

test('sub 为空时不去拼一个带尾空格的字符串来匹配', () => {
  assert.equal(matchItem('x', 'abc', ''), fuzzyScore('x', 'abc'));
});
