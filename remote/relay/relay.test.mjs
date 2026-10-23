import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  addSource,
  answersForToolInput,
  createRelayServer,
  discoverBoard,
  discoverServers,
  findSource,
  forwardEvent,
  forwardUsage,
  loadConfig,
  MAX_BODY_BYTES,
  permissionHookOutput,
  permissionWaitBody,
  removeSource,
  SENDER_EVENTS,
  senderHooks,
  senderStatusLine,
  statusLineText,
  transformEvent,
  usageReportBody,
  usageWindows,
  waitOnBoard,
} from './relay.mjs';

const LAPTOP = { id: 'laptop', label: 'Laptop', kind: 'computer' };
const URL_ = 'https://desk.tail1234.ts.net/ingest';

describe('senderHooks', () => {
  it('installs one async hook per event Pixel Agents listens to', () => {
    const hooks = senderHooks({ url: URL_, cloud: false });
    assert.deepEqual(Object.keys(hooks).sort(), [...SENDER_EVENTS].sort());
    for (const event of SENDER_EVENTS) {
      const [entry] = hooks[event];
      assert.equal(entry.hooks.length, 1);
      assert.equal(entry.hooks[0].type, 'command');
      assert.equal(entry.hooks[0].async, true);
      assert.ok(entry.hooks[0].command.includes(URL_));
    }
  });

  it('a computer sender reads its key from ~/.pixel-agents/ingest-key and always runs', () => {
    const { command } = senderHooks({ url: URL_, cloud: false }).Stop[0].hooks[0];
    assert.ok(command.includes('Authorization: Bearer $(cat ~/.pixel-agents/ingest-key)'));
    assert.equal(command.includes('CLAUDE_CODE_REMOTE'), false);
  });

  it('a cloud sender carries no key and is a no-op outside cloud sessions', () => {
    const { command } = senderHooks({ url: URL_, cloud: true }).Stop[0].hooks[0];
    assert.equal(command.includes('Authorization'), false);
    assert.ok(command.startsWith('[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0;'));
  });

  it('rejects URLs that are not plain https', () => {
    assert.throws(() => senderHooks({ url: 'http://desk.ts.net/ingest', cloud: true }));
    assert.throws(() =>
      senderHooks({ url: "https://desk.ts.net/ingest'; rm -rf ~; '", cloud: true }),
    );
    assert.throws(() => senderHooks({ url: 'not a url', cloud: true }));
  });

  it('defaults to the bash curl hook, unchanged', () => {
    const hooks = senderHooks({ url: URL_, cloud: false });
    assert.deepEqual(senderHooks({ url: URL_, cloud: false, shell: 'bash' }), hooks);
    assert.deepEqual(hooks.Stop[0].hooks[0], {
      type: 'command',
      command:
        `curl -s -m 5 -X POST -H 'Content-Type: application/json'` +
        ` -H "Authorization: Bearer $(cat ~/.pixel-agents/ingest-key)"` +
        ` --data-binary @- '${URL_}' >/dev/null 2>&1; exit 0`,
      async: true,
      timeout: 10,
    });
  });

  it('a powershell sender runs every hook async in powershell', () => {
    const hooks = senderHooks({ url: URL_, cloud: false, shell: 'powershell' });
    assert.deepEqual(Object.keys(hooks).sort(), [...SENDER_EVENTS].sort());
    for (const event of SENDER_EVENTS) {
      const [entry] = hooks[event];
      assert.equal(entry.hooks.length, 1);
      assert.equal(entry.hooks[0].type, 'command');
      assert.equal(entry.hooks[0].shell, 'powershell');
      assert.equal(entry.hooks[0].async, true);
      assert.equal(entry.hooks[0].timeout, 10);
    }
  });

  it('a powershell sender reads its key from USERPROFILE and posts UTF-8 bytes', () => {
    const { command } = senderHooks({ url: URL_, cloud: false, shell: 'powershell' }).Stop[0]
      .hooks[0];
    assert.ok(command.includes(`$env:USERPROFILE + '\\.pixel-agents\\ingest-key'`));
    assert.ok(command.includes(`-Uri '${URL_}'`));
    assert.ok(command.includes("Authorization = 'Bearer ' + $k"));
    assert.ok(command.includes('[Text.Encoding]::UTF8.GetBytes($b)'));
    assert.ok(command.includes('-TimeoutSec 5'));
    assert.ok(command.endsWith('} catch {}; exit 0'));
    assert.equal(/[\r\n"]/.test(command), false);
  });

  it('rejects powershell for cloud senders and unknown shells', () => {
    assert.throws(() => senderHooks({ url: URL_, cloud: true, shell: 'powershell' }), /Linux/);
    assert.throws(() => senderHooks({ url: URL_, cloud: false, shell: 'zsh' }));
    assert.throws(() =>
      senderHooks({
        url: "https://desk.ts.net/ingest'; calc; '",
        cloud: false,
        shell: 'powershell',
      }),
    );
  });
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-relay-test-'));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, { method = 'POST', path: p = '/ingest', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('transformEvent', () => {
  const prCreated = (overrides = {}) => ({
    session_id: 'abc',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'gh pr create --title "Fix hero image" --fill' },
    tool_response: {
      stdout: 'Creating pull request...\nhttps://github.com/anshhoff/hobbyfi-web/pull/12\n',
    },
    ...overrides,
  });

  it('keeps only the PR url from a successful gh pr create', () => {
    const out = transformEvent(prCreated(), LAPTOP);
    assert.equal(out.pr_url, 'https://github.com/anshhoff/hobbyfi-web/pull/12');
    assert.equal('tool_response' in out, false);
  });

  it('finds the PR url in a PowerShell tool response too', () => {
    const out = transformEvent(
      prCreated({
        tool_name: 'PowerShell',
        tool_response: { output: 'https://github.com/o/r/pull/7' },
      }),
      LAPTOP,
    );
    assert.equal(out.pr_url, 'https://github.com/o/r/pull/7');
  });

  it('sets no pr_url for other commands, failures, or forged fields', () => {
    const other = transformEvent(prCreated({ tool_input: { command: 'gh pr view 12' } }), LAPTOP);
    assert.equal('pr_url' in other, false);
    const failed = transformEvent(prCreated({ hook_event_name: 'PostToolUseFailure' }), LAPTOP);
    assert.equal('pr_url' in failed, false);
    const forged = transformEvent(
      { session_id: 'abc', hook_event_name: 'Stop', pr_url: 'https://evil.example/pull/1' },
      LAPTOP,
    );
    assert.equal('pr_url' in forged, false);
  });

  it('rejects events without session_id or hook_event_name', () => {
    assert.equal(transformEvent({ hook_event_name: 'Stop' }, LAPTOP), null);
    assert.equal(transformEvent({ session_id: 'abc' }, LAPTOP), null);
    assert.equal(transformEvent(null, LAPTOP), null);
    assert.equal(transformEvent([], LAPTOP), null);
  });

  it('namespaces the session id and stamps the source', () => {
    const out = transformEvent({ session_id: 'abc', hook_event_name: 'Stop' }, LAPTOP);
    assert.equal(out.session_id, 'laptop:abc');
    assert.deepEqual(out.pixel_source, LAPTOP);
  });

  it('drops transcript paths, tool output and any forged source', () => {
    const out = transformEvent(
      {
        session_id: 'abc',
        hook_event_name: 'PostToolUse',
        transcript_path: '/root/.claude/projects/x/abc.jsonl',
        agent_transcript_path: '/root/.claude/projects/x/sub.jsonl',
        tool_response: { stdout: 'x'.repeat(10_000) },
        pixel_source: { id: 'local', label: 'Forged', kind: 'computer' },
      },
      LAPTOP,
    );
    assert.equal('transcript_path' in out, false);
    assert.equal('agent_transcript_path' in out, false);
    assert.equal('tool_response' in out, false);
    assert.deepEqual(out.pixel_source, LAPTOP);
  });

  it('truncates long strings inside tool_input and keeps short ones', () => {
    const out = transformEvent(
      {
        session_id: 'abc',
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/a.ts',
          new_string: 'y'.repeat(5_000),
          nested: { s: 'z'.repeat(5_000) },
        },
      },
      LAPTOP,
    );
    assert.equal(out.tool_input.file_path, 'src/a.ts');
    assert.ok(out.tool_input.new_string.length <= 301);
    assert.ok(out.tool_input.nested.s.length <= 301);
  });
});

describe('sources', () => {
  let home;
  beforeEach(() => {
    home = tmpDir();
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('addSource returns a key once and stores only its hash', () => {
    const key = addSource(home, LAPTOP);
    assert.match(key, /^pxr_[A-Za-z0-9_-]{40,}$/);
    const raw = fs.readFileSync(path.join(home, '.pixel-agents', 'relay.json'), 'utf-8');
    assert.equal(raw.includes(key), false);
    assert.deepEqual(findSource(loadConfig(home), key), LAPTOP);
  });

  it('findSource rejects unknown and empty keys', () => {
    addSource(home, LAPTOP);
    const config = loadConfig(home);
    assert.equal(findSource(config, 'pxr_wrong'), null);
    assert.equal(findSource(config, ''), null);
    assert.equal(findSource(config, undefined), null);
  });

  it('addSource replaces the key of an existing source id', () => {
    const first = addSource(home, LAPTOP);
    const second = addSource(home, LAPTOP);
    const config = loadConfig(home);
    assert.equal(config.sources.length, 1);
    assert.equal(findSource(config, first), null);
    assert.deepEqual(findSource(config, second), LAPTOP);
  });

  it('removeSource revokes the key', () => {
    const key = addSource(home, LAPTOP);
    assert.equal(removeSource(home, 'laptop'), true);
    assert.equal(findSource(loadConfig(home), key), null);
    assert.equal(removeSource(home, 'laptop'), false);
  });

  it('rejects invalid source ids and kinds', () => {
    assert.throws(() => addSource(home, { ...LAPTOP, id: 'bad id' }));
    assert.throws(() => addSource(home, { ...LAPTOP, kind: 'phone' }));
  });
});

describe('discoverServers', () => {
  let home;
  beforeEach(() => {
    home = tmpDir();
    fs.mkdirSync(path.join(home, '.pixel-agents', 'servers'), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const write = (name, value) =>
    fs.writeFileSync(path.join(home, '.pixel-agents', 'servers', name), JSON.stringify(value));

  it('returns live, well-formed entries only', () => {
    write('a.json', { port: 3100, pid: process.pid, token: 't1' });
    write('dead.json', { port: 3101, pid: 999_999_999, token: 't2' });
    write('bad.json', { port: 'x' });
    fs.writeFileSync(path.join(home, '.pixel-agents', 'servers', 'junk.json'), '{not json');
    assert.deepEqual(discoverServers(home), [{ port: 3100, token: 't1' }]);
  });

  it('returns [] when the registry is missing', () => {
    assert.deepEqual(discoverServers(tmpDir()), []);
  });
});

describe('forwardEvent', () => {
  it('posts the event to each server with its bearer token', async () => {
    const received = [];
    const target = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.end('ok');
      });
    });
    const port = await listen(target);
    try {
      await forwardEvent({ session_id: 'laptop:abc', hook_event_name: 'Stop' }, [
        { port, token: 'tok' },
      ]);
      assert.equal(received.length, 1);
      assert.equal(received[0].url, '/api/hooks/claude');
      assert.equal(received[0].auth, 'Bearer tok');
      assert.equal(received[0].body.session_id, 'laptop:abc');
    } finally {
      target.close();
    }
  });

  it('never rejects when a server is down', async () => {
    await forwardEvent({ session_id: 's', hook_event_name: 'Stop' }, [{ port: 1, token: 't' }]);
  });
});

describe('relay HTTP server', () => {
  let home;
  let key;
  let server;
  let port;
  let forwarded;

  beforeEach(async () => {
    home = tmpDir();
    key = addSource(home, LAPTOP);
    forwarded = [];
    server = createRelayServer({
      getConfig: () => loadConfig(home),
      forward: (event) => {
        forwarded.push(event);
      },
    });
    port = await listen(server);
  });

  afterEach(() => {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const event = JSON.stringify({
    session_id: 'abc',
    hook_event_name: 'Stop',
    cwd: '/home/user/repo',
  });
  const auth = () => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });

  it('accepts an authenticated event and forwards the transformed copy', async () => {
    assert.equal(await request(port, { headers: auth(), body: event }), 204);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].session_id, 'laptop:abc');
    assert.deepEqual(forwarded[0].pixel_source, LAPTOP);
  });

  it('also accepts POST / for a proxy that strips the mount path', async () => {
    assert.equal(await request(port, { path: '/', headers: auth(), body: event }), 204);
    assert.equal(forwarded.length, 1);
  });

  it('rejects missing or wrong keys without forwarding', async () => {
    assert.equal(await request(port, { body: event }), 401);
    assert.equal(
      await request(port, { headers: { authorization: 'Bearer pxr_nope' }, body: event }),
      401,
    );
    assert.equal(forwarded.length, 0);
  });

  it('rejects malformed bodies', async () => {
    assert.equal(await request(port, { headers: auth(), body: '{oops' }), 400);
    assert.equal(await request(port, { headers: auth(), body: '{"session_id":"x"}' }), 400);
    assert.equal(forwarded.length, 0);
  });

  it('rejects bodies over the size limit', async () => {
    const big = JSON.stringify({
      session_id: 'a',
      hook_event_name: 'Stop',
      pad: 'x'.repeat(MAX_BODY_BYTES),
    });
    assert.equal(await request(port, { headers: auth(), body: big }), 413);
    assert.equal(forwarded.length, 0);
  });

  it('serves nothing else', async () => {
    assert.equal(await request(port, { method: 'GET', path: '/ingest' }), 404);
    assert.equal(
      await request(port, { path: '/api/hooks/claude', headers: auth(), body: event }),
      404,
    );
  });

  it('still answers 204 when forwarding throws', async () => {
    server.close();
    server = createRelayServer({
      getConfig: () => loadConfig(home),
      forward: () => {
        throw new Error('board down');
      },
    });
    port = await listen(server);
    assert.equal(await request(port, { headers: auth(), body: event }), 204);
  });
});

// ── Approvals ───────────────────────────────────────────────────────────────

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which meter should stay?',
      header: 'Meter',
      multiSelect: false,
      options: [
        { label: 'Server room', description: 'the wall display' },
        { label: 'Limit meter', description: 'the branch' },
      ],
    },
    {
      question: 'Ship to which hosts?',
      header: 'Hosts',
      multiSelect: true,
      options: [{ label: 'PC' }, { label: 'Mac' }, { label: 'Café' }],
    },
  ],
};

const PERMISSION_REQUEST = {
  session_id: 'abc',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
  cwd: '/Users/me/repo',
  transcript_path: '/Users/me/.claude/projects/x/abc.jsonl',
};

describe('senderHooks approvals', () => {
  it('adds a synchronous wait hook for PermissionRequest after the async event hook', () => {
    const hooks = senderHooks({ url: URL_, cloud: false });
    assert.equal(hooks.PermissionRequest.length, 2);
    assert.equal(hooks.PermissionRequest[0].hooks[0].async, true);
    const wait = hooks.PermissionRequest[1].hooks[0];
    assert.equal(wait.async, undefined);
    assert.equal(wait.timeout, 660);
    assert.equal(
      wait.command,
      `curl -sf -m 650 -X POST -H 'Content-Type: application/json'` +
        ` -H "Authorization: Bearer $(cat ~/.pixel-agents/ingest-key)"` +
        ` --data-binary @- '${URL_}/permission' 2>/dev/null; exit 0`,
    );
    for (const event of SENDER_EVENTS.filter((e) => e !== 'PermissionRequest')) {
      assert.equal(hooks[event].length, 1);
    }
  });

  it('--no-approvals leaves PermissionRequest async only', () => {
    const hooks = senderHooks({ url: URL_, cloud: false, approvals: false });
    assert.equal(hooks.PermissionRequest.length, 1);
  });

  it('cloud and powershell senders get the wait hook too', () => {
    const cloud = senderHooks({ url: URL_, cloud: true }).PermissionRequest[1].hooks[0];
    assert.ok(cloud.command.startsWith('[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0;'));
    assert.equal(cloud.command.includes('Authorization'), false);
    const ps = senderHooks({ url: `${URL_}/`, cloud: false, shell: 'powershell' })
      .PermissionRequest[1].hooks[0];
    assert.equal(ps.shell, 'powershell');
    assert.ok(ps.command.includes(`-Uri '${URL_}/permission'`));
    assert.ok(ps.command.includes('-TimeoutSec 650'));
    assert.ok(ps.command.includes('if ($r.StatusCode -eq 200)'));
    assert.equal(/[\r\n"]/.test(ps.command), false);
  });
});

describe('permissionWaitBody', () => {
  it('namespaces the session, stamps the source, drops the transcript', () => {
    const body = permissionWaitBody(PERMISSION_REQUEST, LAPTOP);
    assert.equal(body.session_id, 'laptop:abc');
    assert.equal(body.tool_name, 'Bash');
    assert.deepEqual(body.tool_input, { command: 'rm -rf build' });
    assert.equal(body.cwd, '/Users/me/repo');
    assert.deepEqual(body.pixel_source, LAPTOP);
    assert.equal(body.transcript_path, undefined);
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  });

  it("keeps an AskUserQuestion's options (the event path's depth limit would drop them)", () => {
    const body = permissionWaitBody(
      { ...PERMISSION_REQUEST, tool_name: 'AskUserQuestion', tool_input: QUESTION_INPUT },
      LAPTOP,
    );
    assert.deepEqual(body.tool_input, QUESTION_INPUT);
  });

  it('rejects anything but a PermissionRequest with a session and tool', () => {
    const bad = (patch) => permissionWaitBody({ ...PERMISSION_REQUEST, ...patch }, LAPTOP);
    assert.equal(bad({ hook_event_name: 'Stop' }), null);
    assert.equal(bad({ tool_name: '' }), null);
    assert.equal(bad({ session_id: 5 }), null);
    assert.equal(permissionWaitBody([], LAPTOP), null);
  });
});

describe('permissionHookOutput', () => {
  const parse = (text) => JSON.parse(text).hookSpecificOutput;

  it('allow and deny, nothing else passed through', () => {
    assert.deepEqual(parse(permissionHookOutput({ decision: { behavior: 'allow' } }, 'Bash', {})), {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    });
    const denied = parse(
      permissionHookOutput(
        {
          decision: {
            behavior: 'deny',
            message: 'no',
            updatedPermissions: [{ type: 'addRules' }],
            interrupt: true,
          },
        },
        'Bash',
        {},
      ),
    );
    assert.deepEqual(denied.decision, { behavior: 'deny', message: 'no' });
  });

  it('prints nothing for no decision or a bad one', () => {
    assert.equal(permissionHookOutput({}, 'Bash', {}), null);
    assert.equal(permissionHookOutput(null, 'Bash', {}), null);
    assert.equal(permissionHookOutput({ decision: { behavior: 'ask' } }, 'Bash', {}), null);
  });

  it('answers a question from the ORIGINAL input, ASCII-escaped', () => {
    const text = permissionHookOutput(
      { decision: { behavior: 'allow', answers: [{ options: [0] }, { options: [2, 1] }] } },
      'AskUserQuestion',
      QUESTION_INPUT,
    );
    assert.equal(/[^\x20-\x7e]/.test(text), false);
    const { decision } = parse(text);
    assert.deepEqual(decision.updatedInput, {
      ...QUESTION_INPUT,
      answers: {
        'Which meter should stay?': 'Server room',
        'Ship to which hosts?': 'Mac, Café',
      },
    });
  });

  it('a question allowed without fitting answers prints nothing', () => {
    const out = (answers) =>
      permissionHookOutput(
        { decision: { behavior: 'allow', answers } },
        'AskUserQuestion',
        QUESTION_INPUT,
      );
    assert.equal(out(undefined), null);
    assert.equal(out([{ options: [0] }]), null); // one short
    assert.equal(out([{ options: [0, 1] }, { options: [0] }]), null); // two on single-select
    assert.equal(out([{ options: [5] }, { options: [0] }]), null); // out of range
    assert.equal(out([{ options: [] }, { options: [0] }]), null); // unanswered
  });
});

describe('answersForToolInput', () => {
  it('appends "Other" text after the chosen labels', () => {
    assert.deepEqual(
      answersForToolInput(QUESTION_INPUT, [
        { options: [], other: '  Both  ' },
        { options: [0], other: 'NAS' },
      ]),
      { 'Which meter should stay?': 'Both', 'Ship to which hosts?': 'PC, NAS' },
    );
  });
});

describe('discoverBoard', () => {
  it('prefers the newest standalone server', () => {
    const home = tmpDir();
    const dir = path.join(home, '.pixel-agents', 'servers');
    fs.mkdirSync(dir, { recursive: true });
    const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    write('vscode.json', { port: 1, pid: process.pid, token: 'v', startedAt: 30 });
    write('old.json', { port: 2, pid: process.pid, token: 'o', startedAt: 10, standalone: {} });
    write('new.json', { port: 3, pid: process.pid, token: 'n', startedAt: 20, standalone: {} });
    try {
      assert.deepEqual(discoverBoard(home), { port: 3, token: 'n' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('waitOnBoard', () => {
  it('posts to the board wait route with its token and returns its answer', async () => {
    let seen;
    const board = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ decision: { behavior: 'allow' } }));
      });
    });
    const port = await listen(board);
    try {
      const answer = await waitOnBoard({ requestId: 'r1' }, { port, token: 'tok' });
      assert.deepEqual(answer, { decision: { behavior: 'allow' } });
      assert.equal(seen.url, '/api/permissions/wait');
      assert.equal(seen.auth, 'Bearer tok');
      assert.equal(seen.body.requestId, 'r1');
    } finally {
      board.close();
    }
  });

  it('aborting ends the board request; no board or a dead one is null', async () => {
    let closed;
    const closedOnBoard = new Promise((resolve) => (closed = resolve));
    const board = http.createServer((req) => {
      req.resume();
      req.socket.on('close', closed);
    });
    const port = await listen(board);
    try {
      const controller = new AbortController();
      const pending = waitOnBoard({ requestId: 'r2' }, { port, token: 't' }, controller.signal);
      setTimeout(() => controller.abort(), 50);
      assert.equal(await pending, null);
      await closedOnBoard;
    } finally {
      board.close();
    }
    assert.equal(await waitOnBoard({}, undefined), null);
    assert.equal(await waitOnBoard({}, { port: 1, token: 't' }), null);
  });
});

function requestWithBody(port, { path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: p, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('relay permission route', () => {
  let home;
  let key;
  let server;
  let port;
  let waited;
  let answer;

  const start = async (opts = {}) => {
    server = createRelayServer({
      getConfig: () => loadConfig(home),
      forward: () => {},
      waitForDecision: (body, signal) => {
        waited.push({ body, signal });
        return typeof answer === 'function' ? answer(signal) : answer;
      },
      ...opts,
    });
    port = await listen(server);
  };

  beforeEach(async () => {
    home = tmpDir();
    key = addSource(home, LAPTOP);
    waited = [];
    answer = { decision: { behavior: 'allow' } };
    await start();
  });

  afterEach(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const auth = () => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
  const body = JSON.stringify(PERMISSION_REQUEST);
  const openWait = () => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/ingest/permission',
      headers: auth(),
    });
    req.on('error', () => {});
    req.end(body);
    return req;
  };

  for (const p of ['/ingest/permission', '/permission']) {
    it(`answers 200 with the hook output on ${p}`, async () => {
      const res = await requestWithBody(port, { path: p, headers: auth(), body });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body).hookSpecificOutput.decision, { behavior: 'allow' });
      assert.equal(waited[0].body.session_id, 'laptop:abc');
    });
  }

  it('204 when the board has no answer', async () => {
    answer = {};
    const res = await requestWithBody(port, { path: '/ingest/permission', headers: auth(), body });
    assert.deepEqual(res, { status: 204, body: '' });
  });

  it('401 without a key, 400 for a non-PermissionRequest', async () => {
    assert.equal((await requestWithBody(port, { path: '/ingest/permission', body })).status, 401);
    const stop = JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' });
    const res = await requestWithBody(port, {
      path: '/ingest/permission',
      headers: auth(),
      body: stop,
    });
    assert.equal(res.status, 400);
    assert.equal(waited.length, 0);
  });

  it('the sender going away aborts the board wait', async () => {
    let aborted;
    const abortSeen = new Promise((resolve) => (aborted = resolve));
    answer = (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted();
          resolve(null);
        });
      });
    const req = openWait();
    await new Promise((resolve) => setTimeout(resolve, 50));
    req.destroy();
    await abortSeen;
  });

  it('past the wait cap, answers 204 without waiting', async () => {
    server.close();
    answer = () => new Promise(() => {});
    await start({ maxWaits: 1 });
    const first = openWait();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const res = await requestWithBody(port, { path: '/ingest/permission', headers: auth(), body });
    assert.equal(res.status, 204);
    assert.equal(waited.length, 1);
    first.destroy();
  });

  it('no permission route without waitForDecision', async () => {
    server.close();
    await start({ waitForDecision: undefined });
    const res = await requestWithBody(port, { path: '/ingest/permission', headers: auth(), body });
    assert.equal(res.status, 404);
  });
});

// ── Usage ───────────────────────────────────────────────────────────────────

const HOUR_S = 3600;
const nowS = () => Math.floor(Date.now() / 1000);
const statusInput = (limits) => ({
  session_id: 'abc',
  cwd: '/Users/me/secret-repo',
  transcript_path: '/Users/me/.claude/projects/x/abc.jsonl',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  cost: { total_cost_usd: 1.23 },
  rate_limits: limits,
});

describe('usage', () => {
  it('usageWindows keeps live windows only; usageReportBody carries numbers only', () => {
    const resets5 = nowS() + HOUR_S;
    const resets7 = nowS() + 24 * HOUR_S;
    const windows = usageWindows(
      statusInput({
        five_hour: { used_percentage: 46.7, resets_at: resets5 },
        seven_day: { used_percentage: 140, resets_at: resets7 },
      }),
    );
    assert.deepEqual(windows, {
      fiveHour: { usedPercentage: 46.7, resetsAt: resets5 * 1000 },
      sevenDay: { usedPercentage: 100, resetsAt: resets7 * 1000 },
    });
    assert.deepEqual(usageReportBody(windows), {
      rate_limits: {
        five_hour: { used_percentage: 46.7, resets_at: resets5 * 1000 },
        seven_day: { used_percentage: 100, resets_at: resets7 * 1000 },
      },
    });
    assert.equal(usageWindows(statusInput(undefined)), undefined);
    assert.equal(
      usageWindows(statusInput({ five_hour: { used_percentage: 5, resets_at: nowS() - 10 } })),
      undefined,
    );
    assert.equal(usageWindows(statusInput({ five_hour: { used_percentage: '5' } })), undefined);
  });

  it('statusLineText: model, then the usage, ASCII only', () => {
    const input = statusInput({});
    const windows = {
      fiveHour: { usedPercentage: 46.9, resetsAt: Date.now() + 3_600_000 },
      sevenDay: { usedPercentage: 12, resetsAt: Date.now() + 86_400_000 },
    };
    const line = statusLineText(input, windows);
    assert.match(line, /^Opus 5\.5 \| 5h 46% \(resets .+\) \| 7d 12%$/);
    assert.equal(/[^\x20-\x7e]/.test(line), false);
    assert.equal(statusLineText(input, undefined), 'Opus 5.5');
    assert.equal(statusLineText({ model: { display_name: 'Opus  X' } }, undefined), 'OpusX');
  });

  it('senderStatusLine posts to /usage and prints the answer; sender-config shape', () => {
    assert.deepEqual(senderStatusLine({ url: URL_ }), {
      type: 'command',
      command:
        `curl -sf -m 3 -X POST -H 'Content-Type: application/json'` +
        ` -H "Authorization: Bearer $(cat ~/.pixel-agents/ingest-key)"` +
        ` --data-binary @- '${URL_}/usage' 2>/dev/null; exit 0`,
      padding: 0,
    });
    const ps = senderStatusLine({ url: URL_, shell: 'powershell' });
    assert.equal(ps.shell, 'powershell');
    assert.ok(ps.command.includes(`-Uri '${URL_}/usage'`));
    assert.equal(/[\r\n"]/.test(ps.command), false);
    assert.throws(() => senderStatusLine({ url: 'http://x/ingest' }));
  });

  describe('relay usage route', () => {
    let home;
    let key;
    let server;
    let port;
    let reports;

    beforeEach(async () => {
      home = tmpDir();
      key = addSource(home, LAPTOP);
      reports = [];
      server = createRelayServer({
        getConfig: () => loadConfig(home),
        forward: () => {},
        forwardUsage: (body) => {
          reports.push(body);
        },
      });
      port = await listen(server);
    });

    afterEach(() => {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    });

    const auth = () => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });

    for (const p of ['/ingest/usage', '/usage']) {
      it(`answers the line and forwards only the windows on ${p}`, async () => {
        const resets = nowS() + HOUR_S;
        const res = await requestWithBody(port, {
          path: p,
          headers: auth(),
          body: JSON.stringify(
            statusInput({ five_hour: { used_percentage: 23, resets_at: resets } }),
          ),
        });
        assert.equal(res.status, 200);
        assert.match(res.body, /^Opus 5\.5 \| 5h 23% \(resets .+\)\n$/);
        assert.deepEqual(reports, [
          {
            rate_limits: {
              five_hour: { used_percentage: 23, resets_at: resets * 1000 },
              seven_day: undefined,
            },
          },
        ]);
        assert.equal(JSON.stringify(reports).includes('secret-repo'), false);
      });
    }

    it('no usage: prints the model, forwards nothing', async () => {
      const res = await requestWithBody(port, {
        path: '/ingest/usage',
        headers: auth(),
        body: JSON.stringify(statusInput(undefined)),
      });
      assert.deepEqual(res, { status: 200, body: 'Opus 5.5\n' });
      assert.equal(reports.length, 0);
    });

    it('needs the key', async () => {
      const res = await requestWithBody(port, { path: '/ingest/usage', body: '{}' });
      assert.equal(res.status, 401);
    });
  });

  it('forwardUsage posts to /api/usage with the token', async () => {
    let seen;
    const board = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
        res.end();
      });
    });
    const port = await listen(board);
    try {
      await forwardUsage({ rate_limits: {} }, [{ port, token: 'tok' }]);
      assert.deepEqual(seen, { url: '/api/usage', auth: 'Bearer tok', body: { rate_limits: {} } });
    } finally {
      board.close();
    }
  });
});
