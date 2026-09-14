import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

/**
 * 引用环检测。
 *
 * 起因是一个真实的环：`Mode` 这个类型长在 `Shell.tsx` 里，而 `Shell` 渲染
 * `TerminalPane`，于是 `TerminalPane` 反过来 import 自己的父组件。它是 type-only
 * import、构建时会被擦掉，所以从来没报过错——**正因为不报错，它才会一直长下去**，
 * 直到某天有人顺着这条边加了一个真的值引用，然后在初始化顺序上撞上 TDZ。
 *
 * 解法是把这类「界面此刻在看什么」的类型收进 src/view.ts，谁都不用反向依赖。
 * 这条测试守的就是它：再引出一个环就直接红。
 */

const ROOT = resolve(import.meta.dirname, '../src');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(normalize(path));
  }
  return out;
}

/**
 * 只看静态 import / re-export，**不看 `import()`**。
 *
 * 动态 import 是按需求值的，环在它身上不会造成初始化顺序问题；而且代码分割本来就
 * 常拿它当断环的手段，把它算进来会把正当写法误判成问题。
 */
const SPECIFIER = /^\s*(?:import|export)\s(?:[^'"]*?\sfrom\s)?['"]([^'"]+)['"]/gm;

function resolveSpecifier(from: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = normalize(resolve(dirname(from), spec));
  /*
    `.js` 要换回 `.ts` 再找一次。moduleResolution 是 "bundler"，一条以 .js 结尾的相对
    说明符会正常解析到同名的 .ts，tsc 一声不吭——而这里如果不换，整条边会被当成「解析
    不到」直接丢掉，环就隐形了。同仓的 scripts/check-boundaries.mjs 早就做了这个互换，
    这边是漏的。

    （这段话本身也踩过一次坑：原来照抄了一行带引号的示例，被 check-boundaries 的启发式
    正则当成了真的 import。AGENTS 第四节说的就是它——撞上了改措辞，别放宽检查。）
  */
  const swapped = base.replace(/\.(js|jsx|mjs|cjs)$/, m => ({ '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' }[m]!));
  for (const candidate of [base, swapped, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

/** Tarjan：一次遍历就能拿到所有强连通分量，节点数多了也不会退化成指数。 */
function cycles(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], onStack = new Set<string>(), found: string[][] = [];
  let counter = 0;

  function connect(node: string) {
    index.set(node, counter); low.set(node, counter); counter++;
    stack.push(node); onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) { connect(next); low.set(node, Math.min(low.get(node)!, low.get(next)!)); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!));
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    // 单点分量只有指向自己时才算环；其余都是正常的叶子。
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) found.push(component);
  }

  for (const node of graph.keys()) if (!index.has(node)) connect(node);
  return found;
}

test('frontend modules import in one direction only', () => {
  const files = sources(ROOT);
  const known = new Set(files);
  const graph = new Map<string, string[]>();

  for (const file of files) {
    /*
      先去掉注释再扫。`SPECIFIER` 里的 `[^'"]*?` 会跨整行懒扫，所以一行以 import/export
      开头、注释里又恰好出现 `from "……"` 时，会报出一个**并不存在的环**——而它的错误信息
      是「import cycles found」，比 check-boundaries 那句直白的 reason 更难让人联想到
      「是我注释写的」。AGENTS 第四节只警告了 check-boundaries 那一侧。
    */
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const edges: string[] = [];
    for (const match of text.matchAll(SPECIFIER)) {
      const target = resolveSpecifier(file, match[1], known);
      if (target) edges.push(target);
    }
    graph.set(file, edges);
  }

  assert.ok(files.length > 50, `expected to walk the whole tree, saw ${files.length} files`);
  const found = cycles(graph);
  const report = found.map(group => group.map(path => relative(ROOT, path)).sort().join(' <-> ')).join('\n  ');
  assert.deepEqual(found, [], `import cycles found:\n  ${report}`);
});
