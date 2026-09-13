# G1 独立反方验证记录

日期：2026-09-09。审查者：`database_skeptic_review`。状态：G1 限定实现范围反方放行。发现的四项问题已修正并独立复测；已查阅 [独立 QA 报告](g1-tests.md)，其 G1 回归通过。此结论不是日常部署/迁移成功，也不包含 G2/G3 通讯能力。

## 本批边界

G1 只交付独立 catalog/sources、历史保留和查询。采用 legacy/local 单来源；不开放多 origin，不宣称 R2 已完成。runs、通讯、原生发送、耐久 changes 和 restore epoch 留后续关卡；不能因为后续项未做而无限扩大 G1。

不操作日常数据库、模型或服务。本记录只接受隔离数据目录的证据。

## 最小兼容门禁方案

1. 新 workspace 连接在迁移前注册 `diy_conversation_writer_v1()`，返回固定能力版本值。它是连接级版本能力，不是面对恶意进程的安全认证。
2. 一次 schema 事务内升级 bridge writer trigger，要求新的 `storageFormat=3`。旧名称的 `CREATE TRIGGER IF NOT EXISTS` 不会替换已有条件，必须明确替换或使用新版名称。
3. 持久历史、原生目录、必要 generation 和 command receipt 的 DELETE 增加连接能力门禁。旧连接缺少函数时必须 fail closed；旧 `deleteSessionRecord` 的整个 savepoint 回滚，不能先丢 commands 再报错。
4. 新版终端删除路径保留独立历史与必要回执。能力门禁只能禁止旧实现，不能代替新版生命周期逻辑。
5. 旧 daemon 未受影响的原表操作可以保留；旧 bridge 写入被拒绝应明确报告需要升级 gateway。不得把“保持 PTY 运行”解释为“旧版本所有读写兼容”。
6. 新升级的目录变动与数据回填同事务；新增表/marker 的存在不代替 writer 门禁。受支持数据备份和恢复流程由实现/QA 验证，不直接复制活跃 WAL 的主文件。

## 已执行的隔离原理探针

使用 `node:sqlite` 和 `mkdtempSync` 创建临时文件库，两个连接共享 WAL：旧连接先建表并 prepare DELETE；新连接注册函数并创建 DELETE trigger；旧连接在 savepoint 内先删除 sessions，再执行已 prepare 的 bodies DELETE。

观察结果：

```text
old_writer_error no such function: diy_conversation_writer_v1
{"refused":true,"bodies":1,"sessions":1}
new_writer_rows 0
```

这证明该运行环境中：旧连接及预先 prepare 的语句不能绕过新 trigger；调用方执行 savepoint 回滚后原数据仍在；有能力的新连接仍可正常写入。临时文件已清理。

这只是 trigger 原理探针，不是实际业务迁移、跨进程 writer 兼容或整套 G1 通过证据。

## 实际实现待查清单

- [ ] 新库/旧库迁移及 schema marker 重试不复制目录。
- [ ] 旧 storageFormat2 INSERT/UPDATE 被拒绝，已有持久记录能由新读取者加载。
- [ ] 所有旧删除路径都在最早破坏性操作后可完整回滚；新版删除终端仍成功。
- [ ] 独立查询不依赖 terminal/generation 仍存在；source_backed 正文没有伪装成已耐久保存。
- [ ] 不因 scope 缺失而悄悄开放多个 origin。
- [ ] 更新/分页/错误码与 API 契约一致，旧 API 所承诺的范围未被误改。
- [ ] QA 使用真实旧格式 fixture 与文件 SQLite；旧测试反向删除断言已按新契约替换。

以上清单由 QA 的完整验收覆盖；反方以下单列自己的实际证据，不把其他 Agent 的执行归为自己的测试。

## 实际实现问题与复测

| 编号 | 严重性 | 实际反例 | 修正与当前结果 |
| --- | --- | --- | --- |
| G1-S1 | 阻塞 | `conversation_sources` 为 9 列但 INSERT 曾有 10 个占位；真实 `bridge.bind()` 直接抛 SQLite 列数错误 | 数据库 Agent 改显式 9 列/9 占位；独立再次 bind/publish 成功 |
| G1-S2 | 重要 | 140 KB 已保存消息末尾含独特搜索词，详情能读到，但 q 只搜 preview 返回 0 条 | q 查询已保存正文并对预览降级；独立复测返回 1 条，不读取原生文件 |
| G1-S3 | 重要 | metadata patch 在 SAVEPOINT 读后写；另一连接在读取后提交修改，原请求收到 `database is locked`，API 会变 503 而非约定 409 | 顶层使用可组合的 `transaction()` / BEGIN IMMEDIATE；真实子进程竞争复测父请求 revision=2，子请求 status=409/code=conflict |
| G1-S4 | 重要 | 迁移前旧连接执行旧项目删除，projects 已删但 catalog.project_id 仍指向旧项目 | 新增 projects DELETE 连接能力门禁；独立复测旧删除失败并回滚，原项目仍存在 |

S3 首次复现使用真实 WAL 两连接，仅以 Proxy 在第一条目录 SELECT 后注入第二连接提交，用于固定交错；未 mock 数据库查询。修复复测改为真正子进程：父 BEGIN IMMEDIATE 后读取目录，通过 IPC 让子发起旧 revision 的 patch；父暂留写锁 80 ms 后提交，子获取写锁后收到 409。复测避免同步重入第二连接造成的假死，也避免只用单进程顺序调用冒充并发。

修复后隔离输出：

```text
full_body_tail_search 1
old_project_guard no such function: diy_conversation_writer_v1 project_rows 1
parent_patch 2
child_patch {"status":409,"code":"conflict","message":"conversation was modified"}
```

## 实际版本门禁与备份独立探针

使用实际 `createAiSessionStorage` 和 bridge，迁移前打开旧连接并 prepare command DELETE；新连接迁移后写入隔离测试消息，旧连接删除 command / 写旧 bridge record 均被拒绝。调用实际备份工具后以只读连接打开备份，验证正文和 integrity_check。

```text
old_command_guard no such function: diy_conversation_writer_v1 receipts 1
old_bridge_guard no such function: diy_conversation_writer_v1
backup_body durable
backup_integrity { integrity_check: 'ok' }
```

备份来源当时仍有打开的 WAL 连接；该探针证明实际工具能保存已提交内容并产生可独立读取的快照，不代表测试了所有断电/文件系统故障情形。临时目录、连接与子进程均已清理，未读取私人正文或迁移日常库。

## 阶段性反方结论

- R1 的旧 bridge 写入、旧 terminal command 删除和旧 project 删除门禁已在本环境得到独立反例与正反验证；实际上线仍须匹配版本、先备份，不支持长时间保留被拒写的旧 gateway。
- R3 本批元数据写入及嵌套 command 事务的组合方式已修正；未来收件箱/changes 的跨进程提交仍需 G2 再验，不能由此宣称整个 R3 永久关闭。
- R2 通过明确只开放 legacy-local 限定本批范围，不是已完成多 scope 身份迁移。R4—R8 中投递、回执、sender_scope、restore epoch 等留 G2/G3；本批无发送接口。
- 当前审查未发现尚未处理的 G1 阻塞反例。完整旧格式迁移 fixture、迁移失败回滚、HTTP 契约、全套适用回归和最终 typecheck 以独立 QA/集成报告为准；没有真实 CLI/TUI/GUI 发信验收结论。

## 跨进程 revision 探针的可复现方式

这是反方执行的临时探针，**尚未加入永久 test suite**。以下代码从仓库根目录运行，便于 QA 后续接管为测试；只使用临时 SQLite 与合成对话。关键交错为：父获取写锁并读 revision 后通知子发起 patch，父提交后子继续并返回冲突。

```sh
node --import tsx --input-type=module <<'JS'
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createAiSessionStorage } from './packages/workspace-store/src/ai-sessions.ts';
import { createConversations } from './packages/workspace-store/src/conversations.ts';
import { createAiSessionBridge } from './packages/ai-session-bridge/src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'g1-revision-probe-'));
const file = join(dir, 'db');
const db = new DatabaseSync(file);
let child;
try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  const bridge = createAiSessionBridge({ storage: createAiSessionStorage(db) });
  bridge.bind({ webSessionId: 'w', cliId: 'omp', nativeSessionId: 'n', terminalInstanceId: 'i' });
  const id = createConversations(db).list().items[0].id;
  const code = `
    import { DatabaseSync } from 'node:sqlite';
    import { createAiSessionStorage } from './packages/workspace-store/src/ai-sessions.ts';
    import { createConversations } from './packages/workspace-store/src/conversations.ts';
    const db = new DatabaseSync(process.env.REVIEW_DB);
    db.exec('PRAGMA busy_timeout=5000');
    createAiSessionStorage(db);
    const store = createConversations(db);
    process.send({ ready: true });
    process.on('message', () => {
      try {
        const record = store.patch(process.env.REVIEW_CID, { revision: 1, title: 'B' });
        process.send({ status: 200, revision: record.revision });
      } catch (error) {
        process.send({ status: error.status, code: error.code });
      } finally { db.close(); process.disconnect(); }
    });`;
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(), env: { ...process.env, REVIEW_DB: file, REVIEW_CID: id },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = once(child, 'exit');
  await once(child, 'message');
  const reply = once(child, 'message');
  let sent = false;
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return sql => {
        const statement = target.prepare(sql);
        if (!sql.startsWith('SELECT c.*,s.id')) return statement;
        return new Proxy(statement, {
          get(s, k) {
            if (k === 'get') return (...args) => {
              const result = s.get(...args);
              if (!sent) {
                sent = true; child.send({ go: true });
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
              }
              return result;
            };
            const value = Reflect.get(s, k, s);
            return typeof value === 'function' ? value.bind(s) : value;
          },
        });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  console.log('parent_revision', createConversations(wrapped).patch(id, { revision: 1, title: 'A' }).revision);
  console.log('child_result', (await reply)[0]);
  await exited;
} finally {
  if (child && child.exitCode === null && !child.killed) child.kill();
  db.close(); rmSync(dir, { recursive: true, force: true });
}
JS
```

预期 `parent_revision 2`，`child_result {status:409, code:'conflict'}`。这个探针固定一组写锁交错，不是压力测试或所有多进程时序的穷举。
