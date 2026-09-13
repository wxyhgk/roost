import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCliIdentity, cliLabel } from '../src/shared/ui/cli-identity.ts';
import { reducer, empty } from '../src/shared/store/state.ts';

test('explicit absent and unknown modern identities cannot inherit the legacy brand', () => {
  assert.equal(resolveCliIdentity('codex', undefined).label, 'Codex');
  assert.equal(resolveCliIdentity('codex', null).label, 'Shell');
  assert.equal(resolveCliIdentity('codex', 'deleted').src, null);
  assert.equal(resolveCliIdentity(null, 'opencode').label, 'AI CLI');
  assert.equal(cliLabel('__proto__'), 'AI CLI');
});
test('config names and icons replace legacy presentation including explicit generic icon', () => {
  const custom = { id: 'chemist', name: 'Chemist', iconUrl: '/api/cli-icons/a', iconRef: 'a' };
  assert.equal(resolveCliIdentity(null, 'chemist', custom).src, custom.iconUrl);
  assert.equal(resolveCliIdentity(null, 'chemist', { ...custom, name: 'Chemistry', iconUrl: null }).label, 'Chemistry');
  assert.equal(resolveCliIdentity('codex', undefined, { ...custom, id: 'codex', iconUrl: null }).src, null);
  assert.equal(resolveCliIdentity('grok', 'grok', { ...custom, id: 'grok' }).monoLogo, false);
});
test('workspace polling and websocket updates preserve null and legacy omission semantics', () => {
  const session = { id: 'one', title: 'one', cwd: '/tmp', projectId: null, closed: false, cli: null, cliId: 'chemist' };
  const state = { ...empty, sessions: [session], selectedId: session.id };
  assert.equal(reducer(state, { type: 'patchLive', sessions: [session] }), state);
  const removed = reducer(state, { type: 'patchLive', sessions: [{ ...session, cliId: null }] });
  assert.equal(removed.sessions[0].cliId, null);
  assert.equal(reducer(state, { type: 'patchSession', id: 'one', cwd: '/other' }).sessions[0].cliId, 'chemist');
  assert.equal(reducer(state, { type: 'patchSession', id: 'one', cli: 'codex', cliId: undefined }).sessions[0].cliId, undefined);
});
