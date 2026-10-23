import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

/**
 * Claude encodes a project dir by replacing separators with dashes, so the
 * encoded name can't tell "hobbyfi-blog-automation" from ".../hobbyfi/blog/automation".
 * Hook-adopted sessions carry the real cwd: label them with its basename.
 */
describe('AgentRuntime -- hook-adopted Directory name', () => {
  let runtime: AgentRuntime;

  afterEach(() => runtime?.dispose());

  it('names a hook-adopted session after the basename of its cwd', () => {
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    const root = path.join(os.tmpdir(), `pxl-dirname-${crypto.randomUUID()}`);
    const cwd = path.join(root, 'hobbyfi-blog-automation');
    const transcriptPath = path.join(root, 'projects', '-tmp-hobbyfi-blog-automation', 's.jsonl');

    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'dirname-1',
      source: 'startup',
      transcript_path: transcriptPath,
      cwd,
    });
    runtime.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: 'dirname-1' });

    expect([...store.values()].map((a) => a.directoryName)).toEqual(['hobbyfi-blog-automation']);
  });
});
