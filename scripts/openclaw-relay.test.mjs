import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

test('relay resolves prepared secrets inside hooks and sees later availability and rotation', async () => {
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
  const { default: plugin } = await import(
    'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
  );
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
        remote: {
          endpoint: 'http://127.0.0.1:13100/api/hooks/openclaw',
          token: { source: 'file', provider: 'test', id: 'value' },
        },
      },
      runtime: {
        config: {
          current: () => ({
            agents: { entries: { probe: { workspace: '/configured-probe-workspace' } } },
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
    fixture.token = 'fake-hook-only-token-two';
    await hooks.get('before_tool_call')(
      { toolName: 'exec', toolCallId: 'private-tool-id', params: { secret: 'never-forward' } },
      context,
    );
    assert.equal(sent.length, 3);
    assert.equal(sent[2].options.headers.authorization, 'Bearer fake-hook-only-token-two');
    assert.equal(JSON.parse(sent[2].options.body).event, 'tool_start');
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
    await hooks.get('agent_end')({ messages: ['must-not-forward-final-reply'] }, context);
    assert.equal(JSON.parse(sent.at(-1).options.body).event, 'turn_end');
    await hooks.get('gateway_stop')();
    assert.equal(JSON.parse(sent.at(-1).options.body).event, 'session_end');
    assert.equal(JSON.parse(sent.at(-1).options.body).reason, 'gateway_stop');
    assert.equal(
      sent.some((item) => item.options.body.includes('must-not-forward-final-reply')),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__pixelRelayFixture;
  }
});
