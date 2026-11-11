import { expect, test } from '../../fixtures/standalone';
import { preToolUseBash, stop } from '../../helpers/hooks';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import {
  callMcpThroughAgent,
  installDispatchProbe,
  openOfficeSocket,
  printedOfficeUrl,
  ptyInputOf,
  waitForProbeCount,
} from '../../helpers/taskDispatch';

/**
 * Task dispatch (D1): a Workspace's curator calls the `dispatch_task` MCP tool
 * through the bundled stdio shim, and the server writes the task into another
 * agent's PTY. Both agents are browser-style launches into one non-default
 * Workspace; the operator's actions (create the Workspace, launch, appoint the
 * curator) go over a /ws connection.
 *
 * The `claude` on PATH is the regular mock wrapped by task-dispatch-claude.cjs,
 * which adds what real Claude Code does at the process boundary: bracketed
 * paste on, the --mcp-config stdio server started with the PTY env, raw input.
 * The target's "turn completed" state comes from the mock scenario (PreToolUse
 * for the guard verdict, then Stop). No model is involved: the test plays the
 * curator's model by handing JSON-RPC to its shim.
 */
test.describe('Standalone / task dispatch', () => {
  test.skip(process.platform === 'win32', 'PTY spawn of the mock shim is POSIX-only here');
  test.use({ standaloneOptions: { mockClaude: true } });

  test('the curator dispatches a task into an idle agent of its Workspace; refusals write nothing @area:standalone', async ({
    standalone,
  }) => {
    await waitForClaudeHookSetup(standalone.tmpHome);
    installDispatchProbe(standalone.tmpHome);

    const office = await openOfficeSocket(printedOfficeUrl(standalone.getHostLogs()));
    try {
      // A non-default Workspace owning the start directory.
      office.send({
        type: 'saveWorkspace',
        name: 'Dispatch',
        directoryPaths: [standalone.workspaceDir],
      });
      const loaded = await office.waitFor(
        (m) =>
          m.type === 'workspacesLoaded' &&
          (m.workspaces as Array<{ name: string }>).some((w) => w.name === 'Dispatch'),
      );
      const workspaceId = (loaded.workspaces as Array<{ id: string; name: string }>).find(
        (w) => w.name === 'Dispatch',
      )!.id;

      // Curator first: it only has to stay alive.
      await arrangeNextClaudeInvocation(
        standalone.tmpHome,
        claudeScenario('dispatch curator').holdOpenFor(90_000).build(),
      );
      office.send({ type: 'launchAgent', directoryPath: standalone.workspaceDir });
      const [curatorProbe] = await waitForProbeCount(standalone.tmpHome, 1);
      const curatorOpened = await office.waitFor((m) => m.type === 'terminalSessionOpened');
      const curatorId = curatorOpened.agentId as number;

      // Target: one tool call (the write guard sees a verdict for its session),
      // then the turn ends -- an idle agent with a completed turn.
      await arrangeNextClaudeInvocation(
        standalone.tmpHome,
        claudeScenario('dispatch target')
          .at(1_500)
          .emitHook(preToolUseBash('{{sessionId}}', 'ls') as Record<string, unknown>)
          .at(2_500)
          .emitHook(stop('{{sessionId}}') as Record<string, unknown>)
          .holdOpenFor(90_000)
          .build(),
      );
      office.send({ type: 'launchAgent', directoryPath: standalone.workspaceDir });
      const probes = await waitForProbeCount(standalone.tmpHome, 2);
      const targetProbe = probes[1];
      const targetOpened = await office.waitFor(
        (m) => m.type === 'terminalSessionOpened' && m.agentId !== curatorId,
      );
      const targetId = targetOpened.agentId as number;

      // Both launches into the non-default Workspace carry the shim.
      expect(curatorProbe.mcp).toBe(true);
      expect(targetProbe.mcp).toBe(true);

      await office.waitFor(
        (m) => m.type === 'agentGuardStatus' && m.id === targetId && m.active === true,
        30_000,
      );
      await office.waitFor(
        (m) => m.type === 'agentStatus' && m.id === targetId && m.status === 'waiting',
      );

      const dispatch = (id: number, task: string) => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'dispatch_task', arguments: { targetAgentId: targetId, task } },
      });

      // Refused: the caller is not (yet) the curator. Nothing reaches the PTY.
      const [init, list, refused] = await callMcpThroughAgent(
        standalone.tmpHome,
        curatorProbe.sessionId,
        [
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'e2e', version: '0' },
            },
          },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
          dispatch(3, 'Summarize the meeting notes'),
        ],
      );
      expect(init).toMatchObject({ id: 1, result: { serverInfo: { name: 'pixel-agents' } } });
      expect(list).toMatchObject({ id: 2, result: { tools: [{ name: 'dispatch_task' }] } });
      expect(refused).toEqual({
        jsonrpc: '2.0',
        id: 3,
        result: { content: [{ type: 'text', text: 'Task not dispatched.' }], isError: true },
      });
      expect(ptyInputOf(standalone.tmpHome, targetProbe.sessionId)).toBe('');

      // The operator appoints the curator.
      office.send({ type: 'setWorkspaceCurator', workspaceId, agentId: curatorId });
      await office.waitFor((m) => m.type === 'workspaceCuratorChanged' && m.agentId === curatorId);

      // Allowed: the exact framed bytes arrive on the target's terminal input.
      const [written] = await callMcpThroughAgent(standalone.tmpHome, curatorProbe.sessionId, [
        dispatch(4, 'Summarize the meeting notes\nthen list open questions'),
      ]);
      expect(written).toMatchObject({ id: 4, result: { content: [{ type: 'text' }] } });
      const writtenResult = (
        written as { result: { content: Array<{ text: string }>; isError?: boolean } }
      ).result;
      expect(writtenResult.isError).toBeUndefined();
      expect(writtenResult.content[0].text).toContain('Task written to terminal');
      const expected =
        `\u001b[200~[Task from Workspace KB Writer (agent ${curatorId})]\n` +
        'Summarize the meeting notes\nthen list open questions\u001b[201~\r';
      await expect.poll(() => ptyInputOf(standalone.tmpHome, targetProbe.sessionId)).toBe(expected);

      // Refused again: the first task is still in flight (no new prompt yet).
      const [locked] = await callMcpThroughAgent(standalone.tmpHome, curatorProbe.sessionId, [
        dispatch(5, 'Another task'),
      ]);
      expect(locked).toMatchObject({ id: 5, result: { isError: true } });
      expect(ptyInputOf(standalone.tmpHome, targetProbe.sessionId)).toBe(expected);

      // The server's audit line names caller and target, never the task.
      const logs = standalone.getHostLogs();
      expect(logs).toContain(`Task dispatch: caller=${curatorId} target=${targetId}`);
      expect(logs).not.toContain('Summarize the meeting notes');
    } finally {
      office.close();
    }
  });
});
