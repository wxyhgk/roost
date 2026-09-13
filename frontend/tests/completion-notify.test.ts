import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionTracker } from '../src/features/session-status/completion';
import type { ActivityView, AgentState } from '../src/features/session-status/store';
const view = (state: AgentState, extra: Partial<ActivityView> = {}): ActivityView => ({
 state:'active',instanceId:'pty',cliId:'claude',unread:false,lastOutputAt:1,
 agent:{state,name:'claude',agentSessionId:'native',since:1,waitingFor:null,summary:null,toolName:null,toolInputPreview:null},...extra,
});
test('silence, tool activity and permission waits do not signal completion',()=>{
 const tracker=createCompletionTracker();
 for(const state of [view('working'),view('working',{state:'quiet',lastOutputAt:0}),view('blocked'),view('working'),view('failed')]) assert.equal(tracker.observe('s',state),false);
});
test('an observed completion signals once per turn, regardless of duplicate stop timestamps',()=>{
 const tracker=createCompletionTracker();tracker.observe('s',view('working'));
 assert.equal(tracker.observe('s',view('done')),true);
 const duplicate=view('done');duplicate.agent!.since=200;
 assert.equal(tracker.observe('s',duplicate),false);
 tracker.observe('s',view('working'));
 assert.equal(tracker.observe('s',view('done')),true);
});
test('initial completed snapshots, reconnection and another native session never replay completion alerts',()=>{
 const tracker=createCompletionTracker();assert.equal(tracker.observe('s',view('done')),false);
 tracker.observe('s',view('working'));tracker.observe('s',view('working',{state:'disconnected'}));
 assert.equal(tracker.observe('s',view('done')),false);
 tracker.observe('s',view('working'));
 const switched=view('done');switched.agent!.agentSessionId='different';
 assert.equal(tracker.observe('s',switched),false);
 tracker.observe('s',view('working'));assert.equal(tracker.observe('s',view('done',{instanceId:'new-pty'})),false);
});
test('stale agent metadata from the previous CLI cannot generate a completion sound',()=>{
 const tracker=createCompletionTracker();tracker.observe('s',view('working'));
 assert.equal(tracker.observe('s',view('done',{cliId:'omp'})),false);
});
test('session-list changes preserve existing baselines and removing a session forgets it',()=>{
 const tracker=createCompletionTracker();tracker.observe('s',view('working'));tracker.retain(['s','other']);
 assert.equal(tracker.observe('s',view('done')),true);
 tracker.observe('s',view('working'));tracker.retain([]);
 assert.equal(tracker.observe('s',view('done')),false);
});
