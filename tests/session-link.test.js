'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function functionSource(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `function ${name} must exist`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  const brace = source.indexOf('{', functionStart);
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`function ${name} is not closed`);
}

test('server links concurrent Codex PTYs to different new root sessions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const sent = [];
  const terminals = new Map([
    ['first', {
      engine: 'codex', sessionId: null, codexBaseline: new Set(['old']),
      cwd: '/work', startedAt: 1000, clients: [{ readyState: 1, send: value => sent.push(value) }],
    }],
    ['second', {
      engine: 'codex', sessionId: null, codexBaseline: new Set(['old']),
      cwd: '/work', startedAt: 2000, clients: [{ readyState: 1, send: value => sent.push(value) }],
    }],
  ]);
  const context = { fs, path, terminals, JSON, Set, Date, Math };
  vm.createContext(context);
  for (const name of ['comparablePath', 'sendTerminalSessionLink', 'linkPendingCodexTerminals']) {
    vm.runInContext(functionSource(source, name), context);
  }

  context.linkPendingCodexTerminals([
    { id: 'old', cwd: '/work', createdAt: new Date(500).toISOString(), parentThreadId: null },
    { id: 'one', cwd: '/work', createdAt: new Date(1100).toISOString(), parentThreadId: null },
    { id: 'one', cwd: '/work', createdAt: new Date(1200).toISOString(), parentThreadId: 'parent' },
    { id: 'two', cwd: '/work', createdAt: new Date(2100).toISOString(), parentThreadId: null },
  ]);

  assert.equal(terminals.get('first').sessionId, 'one');
  assert.equal(terminals.get('second').sessionId, 'two');
  assert.deepEqual(sent.map(value => JSON.parse(value).sessionId), ['one', 'two']);
});

test('browser persists a discovered terminal link and marks the session open', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const openSessionIds = new Set();
  const pane = { dataset: {} };
  const name = { tagName: 'SPAN', textContent: 'temporary' };
  const requests = [];
  const calls = [];
  const context = {
    openSessionIds,
    document: { getElementById: id => id.startsWith('pane-') ? pane : name },
    Object, JSON,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true }; },
    displayName: session => session.customName || session.name,
    refreshTerminalChip: () => calls.push('chip'),
    persistTerminals: () => calls.push('persist'),
    renderSessions: () => calls.push('render'),
  };
  vm.createContext(context);
  vm.runInContext(functionSource(source, 'linkTerminalToSession'), context);
  const terminal = {
    sessionId: null, pendingCwd: '/work', sessionIdsAtLaunch: new Set(['old']),
    launchModel: 'model', launchEffort: 'high', name: 'temporary', fixedTitle: false,
  };
  const session = { id: 'new', name: 'Real session', customName: null };

  const linked = context.linkTerminalToSession('term', terminal, 'new', session);
  await Promise.resolve();

  assert.equal(linked, true);
  assert.equal(terminal.sessionId, 'new');
  assert.equal(pane.dataset.sessionId, 'new');
  assert.equal(name.textContent, 'Real session');
  assert.equal(openSessionIds.has('new'), true);
  assert.deepEqual(calls, ['chip', 'persist', 'render', 'persist']);
  assert.equal(requests.length, 1);
});

test('browser safely recovers one live same-cwd session for an old unlinked pane', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const context = { openSessionIds: new Set(), Date };
  vm.createContext(context);
  vm.runInContext(functionSource(source, 'findPendingTerminalSession'), context);
  const terminal = { engine: 'codex', pendingCwd: '/work', recoverUnlinked: true };
  const sessions = [
    { id: 'old', engine: 'codex', cwd: '/work', state: 'idle' },
    { id: 'live', engine: 'codex', cwd: '/work', state: 'running' },
    { id: 'other', engine: 'codex', cwd: '/other', state: 'running' },
  ];

  const candidate = context.findPendingTerminalSession(terminal, sessions);

  assert.equal(candidate.id, 'live');
});

test('session rename updates its card data and open terminal header', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const session = { id: 'session', name: 'Original', customName: null };
  const title = { tagName: 'SPAN', textContent: 'Original' };
  const terminal = { sessionId: 'session', fixedTitle: false, name: 'Original' };
  const requests = [];
  const context = {
    sessionMap: new Map([['session', session]]),
    sessions: [session],
    openTerminals: new Map([['term', terminal]]),
    document: { getElementById: () => title },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true }; },
    persistTerminals: () => {},
  };
  vm.createContext(context);
  vm.runInContext(functionSource(source, 'saveSessionName'), context);

  const effectiveName = await context.saveSessionName('session', 'Renamed');

  assert.equal(effectiveName, 'Renamed');
  assert.equal(session.customName, 'Renamed');
  assert.equal(terminal.name, 'Renamed');
  assert.equal(title.textContent, 'Renamed');
  assert.equal(JSON.parse(requests[0].options.body).customName, 'Renamed');
});
