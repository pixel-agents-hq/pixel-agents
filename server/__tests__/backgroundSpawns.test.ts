import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { restoredAgentInit } from '../src/agentPersistence.js';
import type { BackgroundSpawns } from '../src/backgroundSpawns.js';
import {
  classifySpawn,
  completionNotice,
  launchSpawn,
  noticeTime,
  pausedSpawnFate,
  readCompletionNotice,
  stillRunningSpawns,
} from '../src/backgroundSpawns.js';
import { PAUSED_SPAWN_END_MS } from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
import { setHookProvider } from '../src/transcriptParser.js';
import { finishedNotice, interimNotice, noticeRecord } from './fixtures/taskNotifications.js';

const launch = (toolId: string, taskId: string) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: toolId,
          type: 'tool_result',
          content: [
            { type: 'text', text: `Async agent launched successfully. agentId: ${taskId}` },
          ],
        },
      ],
    },
  });

const notice = (inner: string) =>
  JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<task-notification>\n${inner}\n<status>completed</status>\n</task-notification>`,
  });

describe('stillRunningSpawns: a restored lead drops spawns that finished before the last save', () => {
  let dir: string;
  let file: string;
  const write = (...lines: string[]) => fs.writeFileSync(file, lines.join('\n') + '\n');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-spawns-'));
    file = path.join(dir, 'lead.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('drops a spawn whose completion is in the transcript, keeps one still running', () => {
    write(
      launch('toolu_a', 'task-a'),
      launch('toolu_b', 'task-b'),
      notice('<task-id>task-a</task-id>\n<tool-use-id>toolu_a</tool-use-id>'),
    );
    const spawns: BackgroundSpawns = new Map([
      ['toolu_a', { taskId: 'task-a' }],
      ['toolu_b', { taskId: 'task-b' }],
    ]);
    expect([...stillRunningSpawns(spawns, file).keys()]).toEqual(['toolu_b']);
  });

  it('a crash notice naming only the task id ends it', () => {
    write(launch('toolu_a', 'task-a'), notice('<task-id>task-a</task-id>'));
    expect(stillRunningSpawns(new Map([['toolu_a', { taskId: 'task-a' }]]), file).size).toBe(0);
  });

  it('a notice from before the launch is not its end (a revived agent reuses its task id)', () => {
    write(
      launch('toolu_first', 'task-a'),
      notice('<task-id>task-a</task-id>\n<tool-use-id>toolu_first</tool-use-id>'),
      launch('toolu_revive', 'task-a'),
    );
    const spawns: BackgroundSpawns = new Map([['toolu_revive', { taskId: 'task-a' }]]);
    expect([...stillRunningSpawns(spawns, file).keys()]).toEqual(['toolu_revive']);
  });

  it('keeps a spawn whose last notice is interim, drops one that then finished', () => {
    write(
      launch('toolu_a', 'task-a'),
      launch('toolu_b', 'task-b'),
      noticeRecord(interimNotice('task-a', 'toolu_a')),
      noticeRecord(interimNotice('task-b', 'toolu_b')),
      noticeRecord(interimNotice('task-b')),
      noticeRecord(finishedNotice('task-b')),
    );
    const spawns: BackgroundSpawns = new Map([
      ['toolu_a', { taskId: 'task-a' }],
      ['toolu_b', { taskId: 'task-b' }],
    ]);
    expect([...stillRunningSpawns(spawns, file, claudeTeamProvider).keys()]).toEqual(['toolu_a']);
  });

  it('a spawn whose last notice is interim comes back paused since that notice', () => {
    const at = '2026-10-29T20:58:11.963Z';
    write(
      launch('toolu_a', 'task-a'),
      launch('toolu_b', 'task-b'),
      JSON.stringify({
        ...JSON.parse(noticeRecord(interimNotice('task-a', 'toolu_a'))),
        timestamp: at,
      }),
    );
    const spawns: BackgroundSpawns = new Map([
      ['toolu_a', { taskId: 'task-a' }],
      ['toolu_b', { taskId: 'task-b', pausedAt: 1 }],
    ]);
    expect([...stillRunningSpawns(spawns, file, claudeTeamProvider)]).toEqual([
      ['toolu_a', { taskId: 'task-a', pausedAt: Date.parse(at) }],
      ['toolu_b', { taskId: 'task-b' }],
    ]);
  });

  it('keeps every spawn when the transcript cannot be read', () => {
    const spawns: BackgroundSpawns = new Map([['toolu_a', { taskId: 'task-a' }]]);
    expect(stillRunningSpawns(spawns, path.join(dir, 'missing.jsonl'))).toBe(spawns);
  });

  it('restoredAgentInit applies it', () => {
    write(launch('toolu_a', 'task-a'), notice('<tool-use-id>toolu_a</tool-use-id>'));
    const init = restoredAgentInit({
      id: 6,
      sessionId: 'lead',
      terminalName: '',
      jsonlFile: file,
      projectDir: dir,
      backgroundSpawns: [{ toolId: 'toolu_a', taskId: 'task-a' }],
    });
    expect(init.backgroundSpawns?.size).toBe(0);
  });

  it('restoredAgentInit asks the registered provider which notices are interim', () => {
    setHookProvider(claudeProvider);
    write(launch('toolu_a', 'task-a'), noticeRecord(interimNotice('task-a', 'toolu_a')));
    const init = restoredAgentInit({
      id: 6,
      sessionId: 'lead',
      terminalName: '',
      jsonlFile: file,
      projectDir: dir,
      backgroundSpawns: [{ toolId: 'toolu_a', taskId: 'task-a' }],
    });
    expect([...(init.backgroundSpawns?.keys() ?? [])]).toEqual(['toolu_a']);
  });
});

describe('readCompletionNotice: which live spawns a notice ends, and which it only pauses', () => {
  const spawns = (): BackgroundSpawns =>
    new Map([
      ['toolu_a', { taskId: 'task-a' }],
      ['toolu_b', { taskId: 'task-b' }],
    ]);
  const read = (content: string) => {
    const { ended, paused } = readCompletionNotice(spawns(), content, claudeTeamProvider);
    return { ended: [...ended], paused: [...paused] };
  };

  it('an interim notice ends nothing and pauses its spawn, by tool id or by task id alone', () => {
    expect(read(interimNotice('task-a', 'toolu_a'))).toEqual({ ended: [], paused: ['toolu_a'] });
    expect(read(interimNotice('task-a'))).toEqual({ ended: [], paused: ['toolu_a'] });
  });

  it('a finished notice ends its spawn', () => {
    expect(read(finishedNotice('task-a', 'toolu_a')).ended).toEqual(['toolu_a']);
    expect(read(finishedNotice('task-a')).ended).toEqual(['toolu_a']);
  });

  it('a crash notice (status stopped, several task ids) ends them all', () => {
    const crash =
      '<task-notification>\n<task-id>task-a</task-id>\n<task-id>task-b</task-id>\n<status>stopped</status>\n</task-notification>';
    expect(read(crash).ended).toEqual(['toolu_a', 'toolu_b']);
  });

  it('a notice without a note (older CLI versions) ends its spawn', () => {
    expect(
      read(
        '<task-notification> <task-id>task-a</task-id> <tool-use-id>toolu_a</tool-use-id> <output>done</output>',
      ).ended,
    ).toEqual(['toolu_a']);
  });

  it('an interim notice spares only its own agent when notices arrive together', () => {
    expect(read(interimNotice('task-a') + '\n' + finishedNotice('task-b'))).toEqual({
      ended: ['toolu_b'],
      paused: ['toolu_a'],
    });
  });

  it('a spawn paused and then finished in one batch is ended, not paused', () => {
    expect(read(interimNotice('task-a') + '\n' + finishedNotice('task-a'))).toEqual({
      ended: ['toolu_a'],
      paused: [],
    });
  });
});

describe('pausedSpawnFate: a paused background agent that never comes back is let go', () => {
  const pausedAt = Date.parse('2026-10-29T20:58:11.963Z');

  it('stays paused while quiet for less than PAUSED_SPAWN_END_MS', () => {
    expect(pausedSpawnFate(pausedAt, pausedAt - 100, pausedAt + PAUSED_SPAWN_END_MS - 1)).toBe(
      'paused',
    );
  });

  it('ends once quiet for PAUSED_SPAWN_END_MS (its stop-hook write just before the notice is quiet)', () => {
    expect(pausedSpawnFate(pausedAt, pausedAt - 100, pausedAt + PAUSED_SPAWN_END_MS)).toBe('ended');
    expect(pausedSpawnFate(pausedAt, pausedAt + 1000, pausedAt + 14 * 3_600_000)).toBe('ended');
  });

  it('ends a spawn whose transcript cannot be found', () => {
    expect(pausedSpawnFate(pausedAt, undefined, pausedAt + PAUSED_SPAWN_END_MS)).toBe('ended');
  });

  it('a transcript written after the notice means it resumed, however long ago', () => {
    expect(pausedSpawnFate(pausedAt, pausedAt + 60_000, pausedAt + 14 * 3_600_000)).toBe('resumed');
  });
});

describe('noticeTime', () => {
  it("is the record's timestamp, else now", () => {
    expect(noticeTime({ timestamp: '2026-10-29T20:58:11.963Z' }, 5)).toBe(
      Date.parse('2026-10-29T20:58:11.963Z'),
    );
    expect(noticeTime({}, 5)).toBe(5);
    expect(noticeTime({ timestamp: 'nope' }, 5)).toBe(5);
  });
});

describe('launchSpawn', () => {
  it('records a launch under its tool id, with the task id it names', () => {
    const spawns: BackgroundSpawns = new Map();
    expect(launchSpawn(spawns, 'toolu_a', 'task-a')).toBe(true);
    expect(launchSpawn(spawns, 'toolu_b')).toBe(true);
    expect([...spawns]).toEqual([
      ['toolu_a', { taskId: 'task-a' }],
      ['toolu_b', { taskId: undefined }],
    ]);
  });

  it('starts nothing for a result naming a task that is already live', () => {
    const spawns: BackgroundSpawns = new Map([['toolu_a', { taskId: 'task-a' }]]);
    expect(launchSpawn(spawns, 'toolu_msg', 'task-a')).toBe(false);
    expect([...spawns.keys()]).toEqual(['toolu_a']);
  });
});

describe('completionNotice', () => {
  it('is the content of an enqueue queue-operation', () => {
    expect(completionNotice({ type: 'queue-operation', operation: 'enqueue', content: 'x' })).toBe(
      'x',
    );
  });

  it('is null for anything else', () => {
    expect(completionNotice({ type: 'queue-operation', operation: 'dequeue', content: 'x' })).toBe(
      null,
    );
    expect(completionNotice({ type: 'user', operation: 'enqueue', content: 'x' })).toBe(null);
    expect(completionNotice({ type: 'queue-operation', operation: 'enqueue', content: [] })).toBe(
      null,
    );
    expect(completionNotice({ type: 'queue-operation', operation: 'enqueue' })).toBe(null);
  });
});

describe('classifySpawn', () => {
  const lead = (launched: string[], namedCalls: string[] = []) => ({
    backgroundSpawns: new Map(launched.map((id) => [id, {}])) as BackgroundSpawns,
    teammateSpawnToolIds: new Set(namedCalls),
  });

  it('a named, launched spawn is a Teammate', () => {
    expect(classifySpawn(lead(['t']), 't', true)).toBe('teammate');
  });

  it('an unnamed launched spawn is a Sub-agent', () => {
    expect(classifySpawn(lead(['t']), 't', false)).toBe('subagent');
  });

  it('a foreground (never launched) spawn is a Sub-agent, named or not', () => {
    expect(classifySpawn(lead([]), 't', true)).toBe('subagent');
    expect(classifySpawn(lead([]), 't', false)).toBe('subagent');
  });

  it('a named spawn call waits for its launch result', () => {
    expect(classifySpawn(lead([], ['t']), 't', true)).toBe('wait');
    expect(classifySpawn(lead(['t'], ['t']), 't', true)).toBe('teammate');
  });
});
