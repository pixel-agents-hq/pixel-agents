import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

test('relay resolves prepared secrets inside hooks and sees later availability and rotation', async (t) => {
  const fixture = { token: undefined, resolveCalls: 0, preparedCalls: 0 };
  globalThis.__pixelRelayFixture = fixture;
  const result = await build({
    entryPoints: ['integrations/openclaw/index.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'mock-openclaw-sdk',
        setup(builder) {
          builder.onResolve({ filter: /^openclaw\/plugin-sdk\// }, (args) => ({
            path: args.path,
            namespace: 'mock-sdk',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'mock-sdk' }, (args) => ({
            contents: args.path.endsWith('plugin-entry')
              ? 'export const definePluginEntry = value => value;'
              : `export function getPreparedPluginSecretInput() {
                 globalThis.__pixelRelayFixture.preparedCalls++;
                 return {value:globalThis.__pixelRelayFixture.token,revision:1};
               }
               export async function resolveConfiguredSecretInputString() {
                 globalThis.__pixelRelayFixture.resolveCalls++;
                 return {};
               }`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  const { default: plugin, remoteEndpoint } = await import(
    'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
  );
  await t.test('remote endpoints require TLS except for literal loopback destinations', () => {
    for (const host of ['127.0.0.1', '127.1', '[::1]', 'localhost']) {
      assert.ok(remoteEndpoint(`http://${host}:3100/api/hooks/openclaw`), host);
    }
    assert.equal(
      remoteEndpoint('https://office.example/api/hooks/openclaw/'),
      'https://office.example/api/hooks/openclaw',
    );
    for (const endpoint of [
      'http://127.attacker.example/api/hooks/openclaw',
      'http://office.example/api/hooks/openclaw',
      'http://192.0.2.1/api/hooks/openclaw',
      'https://user:password@office.example/api/hooks/openclaw',
      'https://office.example/api/hooks/openclaw?token=secret',
      'https://office.example/api/hooks/openclaw#fragment',
      'https://office.example/redirect',
      'ftp://localhost/api/hooks/openclaw',
    ])
      assert.equal(remoteEndpoint(endpoint), null, endpoint);
  });
  const hooks = new Map();
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (endpoint, options) => {
    sent.push({ endpoint, options });
    return new Response('ok');
  };
  try {
    plugin.register({
      pluginConfig: {
        localDiscovery: false,
        agentNames: { 'probe-manual': 'Manual Desk Name' },
        remote: {
          endpoint: 'http://127.0.0.1:13100/api/hooks/openclaw',
          token: { source: 'file', provider: 'test', id: 'value' },
        },
      },
      runtime: {
        config: {
          current: () => ({
            agents: {
              entries: {
                probe: {
                  workspace: '/configured-probe-workspace',
                  identity: { name: 'Friendly Probe' },
                },
              },
              list: [{ id: 'list-probe', name: 'Configured List Name', workspace: '/list' }],
            },
          }),
        },
      },
      logger: { warn: () => {} },
      on: (name, handler) => hooks.set(name, handler),
    });
    assert.equal(
      fixture.preparedCalls,
      0,
      'register must not read a not-yet-published secret snapshot',
    );
    const context = { sessionKey: 'private-session-key', workspaceDir: '/test-workspace' };
    await hooks.get('model_call_started')({}, context);
    assert.equal(sent.length, 0);
    fixture.token = 'fake-hook-only-token-one';
    await hooks.get('model_call_started')({ prompt: 'must-not-forward' }, context);
    assert.equal(sent.length, 1, 'later availability must not remain cached as unavailable');
    assert.equal(sent[0].options.headers.authorization, 'Bearer fake-hook-only-token-one');
    assert.equal(sent[0].options.redirect, 'error', 'never redirect bearer credentials');
    fixture.token = 'fake-hook-only-token-two';
    await hooks.get('before_tool_call')(
      { toolName: 'exec', toolCallId: 'private-tool-id', params: { secret: 'never-forward' } },
      context,
    );
    assert.equal(sent.length, 4);
    assert.equal(sent.at(-1).options.headers.authorization, 'Bearer fake-hook-only-token-two');
    assert.equal(JSON.parse(sent.at(-1).options.body).event, 'tool_start');
    assert.equal(
      sent.some((item) =>
        /private-session-key|private-tool-id|must-not-forward|never-forward/.test(
          item.options.body,
        ),
      ),
      false,
    );
    assert.equal(fixture.resolveCalls, 1, 'prepared credentials should avoid cold resolution');
    await hooks.get('model_call_started')({}, { agentId: 'probe', sessionKey: 'agent:probe:test' });
    assert.equal(JSON.parse(sent.at(-1).options.body).cwd, '/configured-probe-workspace');
    assert.equal(JSON.parse(sent.at(-1).options.body).display_name, 'Friendly Probe');
    const firstActor = JSON.parse(sent.at(-1).options.body).session_id;
    assert.equal(JSON.parse(sent.at(-1).options.body).is_subagent, false);
    await hooks.get('model_call_started')(
      {},
      { agentId: 'probe', sessionKey: 'agent:probe:another-chat' },
    );
    assert.equal(JSON.parse(sent.at(-1).options.body).session_id, firstActor);
    await hooks.get('model_call_started')(
      {},
      { agentId: 'probe-manual', sessionKey: 'agent:probe-manual:test', workspaceDir: '/manual' },
    );
    assert.equal(JSON.parse(sent.at(-1).options.body).display_name, 'Manual Desk Name');
    assert.notEqual(JSON.parse(sent.at(-1).options.body).session_id, firstActor);
    await hooks.get('model_call_started')({}, { sessionKey: 'agent:list-probe:chat' });
    assert.equal(JSON.parse(sent.at(-1).options.body).display_name, 'Configured List Name');
    assert.equal(JSON.parse(sent.at(-1).options.body).cwd, '/list');
    await hooks.get('model_call_started')(
      {},
      { agentId: 'fallback-agent', sessionKey: 'agent:fallback-agent:chat', workspaceDir: '/test' },
    );
    assert.equal(JSON.parse(sent.at(-1).options.body).display_name, 'fallback-agent');
    const childContext = { agentId: 'probe', sessionKey: 'agent:probe:subagent:test-child' };
    await hooks.get('model_call_started')({}, childContext);
    const childActor = JSON.parse(sent.at(-1).options.body).session_id;
    assert.notEqual(childActor, firstActor, 'genuine delegated children remain distinct');
    assert.equal(JSON.parse(sent.at(-1).options.body).display_name, 'Friendly Probe · subtask');
    assert.equal(JSON.parse(sent.at(-1).options.body).is_subagent, true);
    await hooks.get('subagent_progress')({
      phase: 'ended',
      childSessionKey: childContext.sessionKey,
    });
    assert.equal(JSON.parse(sent.at(-1).options.body).event, 'session_end');
    assert.equal(JSON.parse(sent.at(-1).options.body).session_id, childActor);
    assert.equal(hooks.has('agent_end'), false, 'must not request conversation access');
    await t.test('equal agent IDs in different Gateway namespaces remain separate', async () => {
      const actorIds = [];
      for (const gatewayId of ['gateway-one', 'gateway-two']) {
        const scopedHooks = new Map();
        plugin.register({
          pluginConfig: {
            gatewayId,
            localDiscovery: false,
            remote: { endpoint: 'https://office.example/api/hooks/openclaw', token: 'fixture' },
          },
          runtime: {
            config: { current: () => ({ agents: { defaults: { workspace: '/test' } } }) },
          },
          logger: { warn: () => {} },
          on: (name, handler) => scopedHooks.set(name, handler),
        });
        await scopedHooks.get('model_call_started')(
          {},
          {
            agentId: 'probe',
            sessionKey: 'agent:probe:same-chat',
          },
        );
        actorIds.push(JSON.parse(sent.at(-1).options.body).session_id);
        await scopedHooks.get('gateway_stop')();
      }
      assert.notEqual(actorIds[0], actorIds[1]);
    });
    await hooks.get('after_tool_call')(
      { toolName: 'exec', toolCallId: 'private-tool-id', result: 'must-not-forward-result' },
      context,
    );
    await hooks.get('model_call_ended')({}, context);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(JSON.parse(sent.at(-1).options.body).event, 'turn_end');
    await hooks.get('gateway_stop')();
    assert.equal(JSON.parse(sent.at(-1).options.body).event, 'session_end');
    assert.equal(JSON.parse(sent.at(-1).options.body).reason, 'gateway_stop');
    assert.equal(
      sent.some((item) => item.options.body.includes('must-not-forward-result')),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__pixelRelayFixture;
  }
});

test('session aggregation obeys working > tools > reading > idle and closes only after the last session', async () => {
  const bundled = await build({
    entryPoints: ['integrations/openclaw/sessionActivity.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
  });
  const { SessionActivityAggregator } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
  );
  const events = [];
  const aggregator = new SessionActivityAggregator(async (e) => events.push(e));
  const send = (session_id, event, extra = {}) =>
    aggregator.accept({ session_id, event, ...extra });
  const start = (sid) =>
    send(sid, 'session_start', {
      actor_id: 'one-actor',
      display_name: 'Friendly Agent',
      cwd: '/workspace',
    });
  await start('reading');
  await send('reading', 'tool_start', { tool_id: 'read-tool', tool_name: 'web_fetch' });
  assert.equal(events.at(-1).tool_name, 'web_fetch');
  const beforeIdleFallback = events.length;
  await send('reading', 'model_idle');
  assert.equal(
    events.length,
    beforeIdleFallback,
    'model completion must not interrupt a live tool',
  );
  await start('tool');
  await send('tool', 'tool_start', { tool_id: 'exec-tool', tool_name: 'exec' });
  assert.equal(events.at(-1).tool_name, 'exec');
  await start('working');
  assert.equal(events.at(-1).event, 'session_start');
  assert.equal(events.at(-1).display_name, 'Friendly Agent');
  const checkpoint = events.length;
  await send('reading', 'turn_end');
  assert.ok(
    !events.slice(checkpoint).some((e) => e.event === 'turn_end'),
    'another idle session cannot override working',
  );
  await send('working', 'turn_end');
  assert.equal(events.at(-1).tool_name, 'exec');
  await start('reading');
  await send('reading', 'tool_start', { tool_id: 'read-tool', tool_name: 'web_fetch' });
  assert.equal(events.at(-1).tool_name, 'exec');
  await send('tool', 'turn_end');
  assert.equal(events.at(-1).tool_name, 'web_fetch');
  await send('reading', 'turn_end');
  assert.equal(events.at(-1).event, 'turn_end');
  assert.deepEqual([...new Set(events.map((e) => e.session_id))], ['one-actor']);
  await send('reading', 'session_end');
  await send('tool', 'session_end');
  assert.ok(!events.some((e) => e.event === 'session_end'));
  await send('working', 'session_end');
  assert.equal(events.at(-1).event, 'session_end');
});

test('separate agents, tools and concurrent delivery stay isolated', async () => {
  const bundled = await build({
    entryPoints: ['integrations/openclaw/sessionActivity.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
  });
  const { SessionActivityAggregator } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
  );
  const events = [];
  const aggregator = new SessionActivityAggregator(async (e) => {
    await new Promise((r) => setTimeout(r, 1));
    events.push(e);
  });
  await Promise.all([
    aggregator.accept({
      event: 'session_start',
      session_id: 'chat-a',
      actor_id: 'agent-a',
      cwd: '/a',
    }),
    aggregator.accept({
      event: 'session_start',
      session_id: 'chat-b',
      actor_id: 'agent-b',
      cwd: '/b',
    }),
    aggregator.accept({ event: 'turn_end', session_id: 'chat-a' }),
  ]);
  assert.deepEqual(
    events.filter((e) => e.session_id === 'agent-a').map((e) => e.event),
    ['session_start', 'session_start', 'turn_end'],
  );
  assert.equal(events.filter((e) => e.session_id === 'agent-b').length, 1);
  await Promise.all([
    aggregator.accept({ event: 'session_end', session_id: 'chat-a' }),
    aggregator.accept({
      event: 'session_start',
      session_id: 'chat-a-new',
      actor_id: 'agent-a',
      cwd: '/a',
    }),
  ]);
  assert.equal(
    events.filter((e) => e.session_id === 'agent-a').at(-1).event,
    'session_start',
    'late close cannot erase a reopened actor',
  );
  await aggregator.stop();
  assert.equal(events.filter((e) => e.reason === 'gateway_stop').length, 2);
});
