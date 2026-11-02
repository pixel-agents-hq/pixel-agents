import assert from 'node:assert/strict';

import { test } from 'vitest';

import { TERMINAL_WS_PREFIX } from '../../core/src/constants.js';
import { socketUrl } from '../src/transport/socketUrl.js';

test('at the host root /ws stays /ws', () => {
  assert.equal(socketUrl('ws', 'http://127.0.0.1:3100/', null), 'ws://127.0.0.1:3100/ws');
  assert.equal(
    socketUrl('ws', 'http://127.0.0.1:3100/?token=abc#x', 'abc'),
    'ws://127.0.0.1:3100/ws?token=abc',
  );
});

test('a sub-path mount keeps the prefix and https becomes wss', () => {
  assert.equal(socketUrl('ws', 'https://host/pa/', null), 'wss://host/pa/ws');
  assert.equal(
    socketUrl('ws', 'https://host/pa/index.html?token=t', 't'),
    'wss://host/pa/ws?token=t',
  );
});

test('route prefixes with a leading slash resolve relative to the mount', () => {
  assert.equal(
    socketUrl(`${TERMINAL_WS_PREFIX}/7`, 'https://host/pa/', 'a b'),
    'wss://host/pa/terminal/7?token=a%20b',
  );
  assert.equal(
    socketUrl(`${TERMINAL_WS_PREFIX}/7`, 'http://localhost:3100/', 'tok'),
    'ws://localhost:3100/terminal/7?token=tok',
  );
});
