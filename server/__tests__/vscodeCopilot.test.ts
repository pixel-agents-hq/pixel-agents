import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  extractModelName,
  extractSessionId,
  mapToolName,
  parseOtelRecord,
  vscodeCopilotProvider,
} from '../src/providers/hook/vscode-copilot/copilot.js';
import { CopilotOtelTailer } from '../src/providers/hook/vscode-copilot/copilotOtelTailer.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('VS Code Copilot OTel provider', () => {
  it('extracts session and requested/resolved model names without model-specific logic', () => {
    const span = {
      name: 'invoke_agent copilot',
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'copilot_chat.chat_session_id': 'chat-1',
        'gen_ai.request.model': 'requested-model',
        'gen_ai.response.model': 'resolved-model',
      },
    };
    expect(extractSessionId(span)).toBe('chat-1');
    expect(extractModelName(span)).toBe('requested-model');
    expect(parseOtelRecord(span).map((event) => event.hook_event_name)).toEqual([
      'OtelTurnStart',
      'OtelTurnEnd',
    ]);
  });

  it('maps read, search, edit, terminal, and subagent tools', () => {
    expect(mapToolName('readFile')).toBe('Read');
    expect(mapToolName('semantic_search')).toBe('Search');
    expect(mapToolName('apply_patch')).toBe('Edit');
    expect(mapToolName('runCommand')).toBe('Terminal');
    expect(mapToolName('runSubagent')).toBe('Agent');
  });

  it('maps execute_tool into shared tool lifecycle events', () => {
    const events = parseOtelRecord({
      spanId: 'span-1',
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.conversation.id': 'session-1',
        'gen_ai.tool.name': 'readFile',
        'gen_ai.tool.call.arguments': '{"filePath":"src/app.ts"}',
      },
    });
    expect(events.map((event) => event.hook_event_name)).toEqual([
      'OtelToolStart',
      'OtelToolEnd',
    ]);
    expect(events[0]).toMatchObject({
      session_id: 'session-1',
      toolId: 'span-1',
      toolName: 'Read',
    });
  });

  it('ignores malformed and unrelated records', () => {
    expect(parseOtelRecord({ name: 'not a span' })).toEqual([]);
    expect(vscodeCopilotProvider.normalizeHookEvent({})).toBeNull();
  });
});

describe('CopilotOtelTailer', () => {
  it('handles partial lines, malformed lines, and simultaneous sessions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-copilot-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'otel.jsonl');
    const received: Record<string, unknown>[] = [];
    const tailer = new CopilotOtelTailer(file, (event) => received.push(event), 1000, false);

    fs.writeFileSync(
      file,
      '{"spanId":"a","attributes":{"gen_ai.operation.name":"invoke_agent","gen_ai.conversation.id":"s1"}}\n' +
        '{"broken"',
    );
    tailer.read();
    expect(received.filter((event) => event.hook_event_name === 'SessionStart')).toHaveLength(1);
    expect(received.some((event) => event.session_id === 's1')).toBe(true);

    fs.appendFileSync(
      file,
      '\n' +
      '{"spanId":"b","attributes":{"gen_ai.operation.name":"invoke_agent","gen_ai.conversation.id":"s2"}}\n',
    );
    tailer.read();
    expect(new Set(received.map((event) => event.session_id))).toEqual(new Set(['s1', 's2']));
    tailer.stop();
  });
});
