import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAgentJournal } from "../src/agent-journal.ts";
test("journal bounds retention, paginates below IPC limit and retains source identity", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const journal = createAgentJournal(db, { count: 3, bytes: 8*1024*1024 });
    for (let i=0; i<4; i++) journal.append("s","i",{event:"prompt_submit",query:"x".repeat(140*1024)});
    const first = journal.read("s","i",0);
    assert.equal(first.hasGap,true); assert.equal(first.events.length,1);
    assert.equal(first.events[0].sourceSeq,2); assert.equal(first.more,true);
    const second = journal.read("s","i",first.cursor);
    assert.equal(second.events[0].sourceSeq,3);
    assert.throws(()=>journal.read("other","i",0), /identity/);
    assert.throws(()=>journal.read("s","i",99), /ahead/);
  } finally { db.close(); }
});
test("failed journal writes report unavailable and leave a visible sequence gap after retry", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const journal = createAgentJournal(db);
    journal.append("s","i",{event:"session_start"});
    db.exec("CREATE TRIGGER fail_agent BEFORE INSERT ON agent_journal_events BEGIN SELECT RAISE(ABORT,'disk failure'); END");
    assert.throws(()=>journal.append("s","i",{event:"prompt_submit"}));
    assert.throws(()=>journal.read("s","i",1), /unavailable/);
    db.exec("DROP TRIGGER fail_agent");
    journal.append("s","i",{event:"stop"});
    assert.equal(journal.read("s","i",1).hasGap,true);
    assert.equal(journal.read("s","i",1).events[0].sourceSeq,3);
  } finally { db.close(); }
});
