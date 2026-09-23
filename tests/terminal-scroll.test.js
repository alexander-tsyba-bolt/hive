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

function createController({ deferFrames = false } = {}) {
  const frames = [];
  const context = {
    documentFocused: false,
    paneContainsFocus: false,
    activeTerminalReaderId: null,
    document: {
      activeElement: {},
      hasFocus: () => context.documentFocused,
      getElementById: () => ({ contains: () => context.paneContainsFocus }),
    },
    requestAnimationFrame: callback => {
      if (deferFrames) frames.push(callback); else callback();
      return frames.length || 1;
    },
    cancelAnimationFrame: () => {},
    flushFrames: () => frames.splice(0).forEach(callback => callback()),
  };
  vm.createContext(context);
  for (const name of [
    'terminalPaneHasFocus',
    'terminalIsAtBottom',
    'holdTerminalViewport',
    'installTerminalViewportController',
    'captureTerminalViewport',
    'restoreTerminalViewport',
    'scrollTerminalToReplyIfUnfocused',
  ]) {
    vm.runInContext(functionSource(name), context);
  }
  return context;
}

function createEntry(viewportY, baseY, cursorY = 10) {
  const calls = [];
  const marker = {
    line: viewportY,
    disposed: false,
    dispose() { this.disposed = true; },
  };
  const entry = {
    viewportMode: viewportY >= baseY ? 'bottom' : 'held',
    viewportRevision: 0,
    xterm: {
      buffer: { active: { viewportY, baseY, cursorY } },
      registerMarker: () => marker,
      scrollToBottom: () => calls.push(['bottom']),
      scrollToLine: line => calls.push(['line', line]),
    },
  };
  return { entry, calls, marker };
}

test('a bottom pane stays at the new bottom after reflow', () => {
  const controller = createController();
  const { entry, calls } = createEntry(100, 100);
  const snapshot = controller.captureTerminalViewport(entry);

  entry.xterm.buffer.active.baseY = 180;
  controller.restoreTerminalViewport(entry, snapshot);

  assert.equal(entry.viewportMode, 'bottom');
  assert.deepEqual(calls.at(-1), ['bottom']);
});

test('a held pane follows its marked content through reflow', () => {
  const controller = createController();
  const { entry, calls, marker } = createEntry(40, 100);
  const snapshot = controller.captureTerminalViewport(entry);

  marker.line = 67;
  entry.xterm.buffer.active.baseY = 150;
  controller.restoreTerminalViewport(entry, snapshot);

  assert.equal(entry.viewportMode, 'held');
  assert.deepEqual(calls.at(-1), ['line', 67]);
  assert.equal(marker.disposed, true);
});

test('a newer reader scroll wins over an older write callback', () => {
  const controller = createController();
  const { entry, calls, marker } = createEntry(40, 100);
  const snapshot = controller.captureTerminalViewport(entry);

  entry.viewportRevision++;
  controller.restoreTerminalViewport(entry, snapshot);

  assert.deepEqual(calls, []);
  assert.equal(marker.disposed, true);
});

test('starting a manual scroll releases bottom mode synchronously', () => {
  const controller = createController();
  const { entry } = createEntry(100, 100);

  controller.holdTerminalViewport(entry);
  entry.xterm.buffer.active.viewportY = 80;
  const snapshot = controller.captureTerminalViewport(entry);

  assert.equal(entry.viewportMode, 'held');
  assert.equal(entry.viewportRevision, 1);
  assert.equal(snapshot.wasAtBottom, false);
});

test('wheel events over the terminal body enter held mode before output can arrive', () => {
  const controller = createController({ deferFrames: true });
  const { entry } = createEntry(100, 100);
  const listeners = new Map();
  const body = {
    addEventListener: (type, callback) => listeners.set(type, callback),
  };
  entry.xterm.onKey = () => {};

  controller.installTerminalViewportController('term', entry, body, entry.xterm);
  listeners.get('wheel')();

  assert.equal(entry.viewportMode, 'held');
  assert.equal(entry.viewportRevision, 1);
  entry.xterm.buffer.active.viewportY = 80;
  controller.flushFrames();
  assert.equal(entry.viewportMode, 'held');
});

test('an invalidated marker falls back to the absolute row, not the moving bottom', () => {
  const controller = createController();
  const { entry, calls, marker } = createEntry(40, 100);
  const snapshot = controller.captureTerminalViewport(entry);

  marker.line = -1;
  entry.xterm.buffer.active.baseY = 180;
  controller.restoreTerminalViewport(entry, snapshot);

  assert.equal(entry.viewportMode, 'held');
  assert.deepEqual(calls.at(-1), ['line', 40]);
});

test('reply completion moves only an unfocused pane to the bottom', () => {
  const controller = createController();
  const { entry, calls } = createEntry(40, 100);

  controller.documentFocused = true;
  controller.paneContainsFocus = true;
  controller.scrollTerminalToReplyIfUnfocused('term', entry);
  assert.equal(entry.viewportMode, 'held');
  assert.deepEqual(calls, []);

  controller.documentFocused = false;
  controller.paneContainsFocus = false;
  controller.scrollTerminalToReplyIfUnfocused('term', entry);
  assert.equal(entry.viewportMode, 'bottom');
  assert.deepEqual(calls.at(-1), ['bottom']);
});

test('reply completion does not leave bottom mode if the pane gains focus', () => {
  const controller = createController({ deferFrames: true });
  const { entry, calls } = createEntry(40, 100);

  controller.documentFocused = false;
  controller.scrollTerminalToReplyIfUnfocused('term', entry);
  controller.documentFocused = true;
  controller.paneContainsFocus = true;
  controller.flushFrames();

  assert.equal(entry.viewportMode, 'held');
  assert.deepEqual(calls, []);
});

test('a wheel-selected reader pane counts as focused without keyboard focus', () => {
  const controller = createController();
  const { entry, calls } = createEntry(40, 100);

  controller.documentFocused = true;
  controller.paneContainsFocus = false;
  controller.activeTerminalReaderId = 'term';
  controller.scrollTerminalToReplyIfUnfocused('term', entry);

  assert.equal(entry.viewportMode, 'held');
  assert.deepEqual(calls, []);
});
