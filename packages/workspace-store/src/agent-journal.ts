import type { DatabaseSync } from "node:sqlite";
import type { AgentEvent, AgentReplay } from "@roost/terminal-protocol";
import { transaction } from "./database.ts";
export function createAgentJournal(db: DatabaseSync, limits = { count: 4096, bytes: 8 * 1024 * 1024 }) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_journal_heads (
    instance TEXT PRIMARY KEY, session TEXT NOT NULL, seq INTEGER NOT NULL, dropped INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_journal_events (
    instance TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY(instance, seq));`);
  const failed = new Map<string, number>();
  const head = (instance: string) => db.prepare("SELECT * FROM agent_journal_heads WHERE instance=?").get(instance) as
    { session: string; seq: number; dropped: number } | undefined;
  return {
    remove(session: string) {
      // Deletion can participate in the workspace's cross-domain transaction.
      db.exec("SAVEPOINT agent_journal_remove");
      try {
        db.prepare("DELETE FROM agent_journal_events WHERE instance IN (SELECT instance FROM agent_journal_heads WHERE session=?)").run(session);
        db.prepare("DELETE FROM agent_journal_heads WHERE session=?").run(session);
        db.exec("RELEASE agent_journal_remove");
      } catch (error) {
        db.exec("ROLLBACK TO agent_journal_remove; RELEASE agent_journal_remove");
        throw error;
      }
    },
    append(session: string, instance: string, agent: AgentEvent) {
      const previous = head(instance);
      if (previous && previous.session !== session) throw new Error("agent journal identity conflict");
      const sourceSeq = Math.max(previous?.seq ?? 0, failed.get(instance) ?? 0) + 1;
      const event = { terminalInstanceId: instance, sourceSeq, agent };
      const body = JSON.stringify(event), bytes = Buffer.byteLength(body);
      try {
        transaction(db, () => {
          if (bytes > 1024 * 1024) throw new Error("agent event too large");
          db.prepare("INSERT INTO agent_journal_heads VALUES (?,?,?,?) ON CONFLICT(instance) DO UPDATE SET seq=excluded.seq,dropped=excluded.dropped")
            .run(instance, session, sourceSeq, Math.max(previous?.dropped ?? 0, failed.get(instance) ?? 0));
          db.prepare("INSERT INTO agent_journal_events VALUES (?,?,?,?)").run(instance, sourceSeq, body, bytes);
          const rows = db.prepare("SELECT seq,bytes FROM agent_journal_events WHERE instance=? ORDER BY seq").all(instance) as {seq:number;bytes:number}[];
          let total = rows.reduce((sum, row) => sum + row.bytes, 0), count = rows.length, dropped = 0;
          for (const row of rows) {
            if (count <= limits.count && total <= limits.bytes) break;
            total -= row.bytes; count--; dropped = row.seq;
          }
          if (dropped) {
            db.prepare("DELETE FROM agent_journal_events WHERE instance=? AND seq<=?").run(instance,dropped);
            db.prepare("UPDATE agent_journal_heads SET dropped=MAX(dropped,?) WHERE instance=?").run(dropped,instance);
          }
        });
        failed.delete(instance); return event;
      } catch (error) { failed.set(instance, sourceSeq); throw error; }
    },
    read(session: string, instance: string, after = 0): AgentReplay {
      if (typeof instance !== "string" || !Number.isSafeInteger(after) || after < 0) throw new Error("invalid agent cursor");
      if (failed.has(instance)) throw new Error("agent journal temporarily unavailable");
      const current = head(instance);
      if (current && current.session !== session) throw new Error("agent journal identity conflict");
      if (after > (current?.seq ?? 0)) throw new Error("agent cursor ahead");
      const rows = db.prepare("SELECT body FROM agent_journal_events WHERE instance=? AND seq>? ORDER BY seq LIMIT 4096").all(instance,after) as {body:string}[];
      const events: AgentReplay["events"] = []; let bytes = 0;
      for (const row of rows) {
        const size = Buffer.byteLength(row.body);
        if (events.length && bytes + size > 256 * 1024) break;
        events.push(JSON.parse(row.body)); bytes += size;
      }
      const cursor = events.at(-1)?.sourceSeq ?? current?.seq ?? after;
      return { events, cursor, highWater: current?.seq ?? 0, hasGap: after < (current?.dropped ?? 0), more: cursor < (current?.seq ?? 0) };
    },
  };
}
