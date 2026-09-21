'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} must exist`);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < html.length; index++) {
    if (html[index] === '{') depth++;
    if (html[index] === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`function ${name} is not closed`);
}

function createNotificationController() {
  const timers = new Map();
  const notifications = [];
  const scrolls = [];
  let nextTimer = 1;
  const context = {
    termWaitingSessionIds: new Set(),
    termCodexWorkingIds: new Set(),
    sessionMap: new Map([['session', { id: 'session', name: 'Test session' }]]),
    renderSessions: () => {},
    refreshTerminalChip: () => {},
    scrollTerminalToReplyIfUnfocused: (...args) => scrolls.push(args),
    fireTerminalNotification: (...args) => notifications.push(args.at(-1)),
    setTimeout: callback => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: id => timers.delete(id),
  };
  vm.createContext(context);
  for (const name of ['readTerminalSignals', 'checkTerminalWaiting']) {
    vm.runInContext(functionSource(name), context);
  }
  return { context, notifications, scrolls, timers };
}

function createEntry(text = '', engine = 'claude') {
  const entry = {
    engine,
    sessionId: 'session',
    closing: false,
    lineTexts: Array.isArray(text) ? text : [text],
  };
  entry.xterm = {
    rows: 8,
    buffer: {
      active: {
        baseY: 0,
        getLine: row => {
          const index = row - (8 - entry.lineTexts.length);
          return index >= 0 && index < entry.lineTexts.length
            ? { translateToString: () => entry.lineTexts[index] }
            : null;
        },
      },
    },
  };
  return entry;
}

test('one interactive prompt produces one notification across a redraw flicker', () => {
  const { context, notifications, timers } = createNotificationController();
  const entry = createEntry('Enter to select · Esc to cancel');

  context.checkTerminalWaiting('term', entry);
  entry.lineTexts = [''];
  context.checkTerminalWaiting('term', entry);
  entry.lineTexts = ['Enter to select · Esc to cancel'];
  context.checkTerminalWaiting('term', entry);

  assert.deepEqual(notifications, ['attention']);
  assert.equal(timers.size, 0);
});

test('a cancellable operation without an input control does not notify', () => {
  const { context, notifications } = createNotificationController();
  const entry = createEntry('Running task · Esc to cancel');

  context.checkTerminalWaiting('term', entry);

  assert.deepEqual(notifications, []);
  assert.equal(context.termWaitingSessionIds.has('session'), false);
});

test('a stable reply completion produces one ready notification', () => {
  const { context, notifications, timers } = createNotificationController();
  const entry = createEntry('Thinking (2s, esc to interrupt)');

  context.checkTerminalWaiting('term', entry);
  entry.lineTexts = ['Reply complete'];
  context.checkTerminalWaiting('term', entry);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();

  assert.deepEqual(notifications, ['ready']);
});

test('a missing Codex Working row is not reply completion', () => {
  const { context, notifications, scrolls, timers } = createNotificationController();
  const entry = createEntry([
    '─ Worked for 4s ─────────',
    'Working (2s · esc to interrupt)',
  ], 'codex');

  context.checkTerminalWaiting('term', entry);
  entry.lineTexts = ['─ Worked for 4s ─────────', 'Redrawing status'];
  context.checkTerminalWaiting('term', entry);

  assert.equal(timers.size, 0);
  assert.equal(context.termCodexWorkingIds.has('session'), true);
  assert.deepEqual(scrolls, []);
  assert.deepEqual(notifications, []);
});

test('a new Codex Worked for marker completes the current reply', () => {
  const { context, notifications, scrolls, timers } = createNotificationController();
  const entry = createEntry([
    '─ Worked for 4s ─────────',
    'Working (2s · esc to interrupt)',
  ], 'codex');

  context.checkTerminalWaiting('term', entry);
  entry.lineTexts = ['─ Worked for 4s ─────────', '─ Worked for 9s ─────────'];
  context.checkTerminalWaiting('term', entry);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();

  assert.equal(context.termCodexWorkingIds.has('session'), false);
  assert.equal(scrolls.length, 1);
  assert.deepEqual(notifications, ['ready']);
});

test('session polling does not issue broad waiting-state notifications', () => {
  const loadStart = html.indexOf('async function loadSessions()');
  const loadEnd = html.indexOf('// After each session reload', loadStart);
  const source = html.slice(loadStart, loadEnd);

  assert.equal(source.includes('fireTerminalNotification'), false);
  assert.equal(source.includes('fireWaitingNotification'), false);
});
