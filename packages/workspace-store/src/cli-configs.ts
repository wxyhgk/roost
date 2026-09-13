import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CLI_DEFINITIONS, type CliDefinition } from '@roost/cli-adapters';
import { transaction } from './database.ts';

type DefinitionRow = { definition_json: string };
type CliPatch = Partial<Pick<CliDefinition, 'name' | 'command' | 'rules' | 'iconRef' | 'enabled' | 'priority'>>;

/** Called inside the workspace schema transaction; seeding never overwrites edits. */
export function migrateCliConfigs(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 FROM meta WHERE key='schema.cli-configs.v1'").get()) {
    db.exec(`CREATE TABLE cli_configs (
      id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.prepare("INSERT INTO meta(key,value) VALUES ('schema.cli-configs.v1','1')").run();
  }
  // 每次打开都补齐缺失的内置：新版本加进 DEFAULT_CLI_DEFINITIONS 的条目，
  // 不会经过上面那段只跑一次的建表播种，老库因此永远看不到它们。
  // OR IGNORE 保证不覆盖用户对既有内置的改动（改名、停用、调优先级）。
  const insert = db.prepare('INSERT OR IGNORE INTO cli_configs VALUES (?,?,?)');
  for (const definition of DEFAULT_CLI_DEFINITIONS) {
    insert.run(definition.id, JSON.stringify(definition), Date.now());
  }
}

export function createCliConfigs(db: DatabaseSync) {
  const get = (id: string): CliDefinition | null => {
    const row = db.prepare('SELECT definition_json FROM cli_configs WHERE id=?').get(id) as DefinitionRow | undefined;
    return row ? JSON.parse(row.definition_json) : null;
  };
  const write = (definition: CliDefinition) => {
    db.prepare('UPDATE cli_configs SET definition_json=?,updated_at=? WHERE id=?')
      .run(JSON.stringify(definition), Date.now(), definition.id);
    return get(definition.id)!;
  };
  return {
    get,
    list(): CliDefinition[] {
      const rows = db.prepare('SELECT definition_json FROM cli_configs ORDER BY id').all() as DefinitionRow[];
      return rows.map(row => JSON.parse(row.definition_json));
    },
    create(definition: CliDefinition) {
      return transaction(db, () => {
        if (get(definition.id)) return null;
        db.prepare('INSERT INTO cli_configs VALUES (?,?,?)')
          .run(definition.id, JSON.stringify({ ...definition, builtin: false }), Date.now());
        return get(definition.id);
      });
    },
    update(id: string, patch: CliPatch) {
      return transaction(db, () => {
        const current = get(id);
        return current ? write({ ...current, ...patch }) : null;
      });
    },
    remove(id: string) {
      return transaction(db, () => {
        const current = get(id);
        if (!current) return false;
        // Built-ins stay addressable so restore-default can always recover them.
        if (current.builtin) write({ ...current, enabled: false });
        else db.prepare('DELETE FROM cli_configs WHERE id=?').run(id);
        return true;
      });
    },
    reset(id: string) {
      const defaults = DEFAULT_CLI_DEFINITIONS.find(def => def.id === id);
      return defaults ? transaction(db, () => write({ ...defaults })) : null;
    },
  };
}
