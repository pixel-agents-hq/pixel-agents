import { describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { ProgressTracker } from '../src/progress/progressTracker.js';
import { TaskLedger } from '../src/tasks/taskLedger.js';
import {
  addNote,
  commitMessageOf,
  emptyNotes,
  mergeNotes,
  parseNotes,
  todosFromTool,
} from '../src/tasks/workNotes.js';

/** Work notes: what a task did, in words, for the Manager's report. */

describe('commitMessageOf', () => {
  it('reads the subject of -m, -am, single quotes and heredocs', () => {
    expect(commitMessageOf('git commit -m "Fix the strip"')).toBe('Fix the strip');
    expect(commitMessageOf("git add . && git commit -am 'Ship it'")).toBe('Ship it');
    expect(commitMessageOf('git -C repo commit -m "Say \\"hi\\""')).toBe('Say "hi"');
    expect(
      commitMessageOf('git commit -m "$(cat <<\'EOF\'\nfeat: the report\n\nBody text\nEOF\n)"'),
    ).toBe('feat: the report');
    // A relayed command arrives clipped: the subject still counts.
    expect(commitMessageOf('git commit -m "feat: a very long subj…')).toBe(
      'feat: a very long subj…',
    );
    expect(commitMessageOf('git commit --amend --no-edit')).toBeUndefined();
    expect(commitMessageOf('git log -m')).toBeUndefined();
  });
});

describe('notes', () => {
  it('reads plan items from TodoWrite and TaskCreate', () => {
    expect(todosFromTool('TodoWrite', { todos: [{ content: 'A' }, { content: 'B' }, 3] })).toEqual([
      'A',
      'B',
    ]);
    expect(todosFromTool('TaskCreate', { subject: 'C' })).toEqual(['C']);
    expect(todosFromTool('Bash', { command: 'ls' })).toEqual([]);
  });

  it('clips, deduplicates, and keeps the latest outcomes', () => {
    const notes = emptyNotes();
    expect(addNote(notes, 'todos', '  Build   the strip ')).toBe(true);
    expect(addNote(notes, 'todos', 'Build the strip')).toBe(false);
    for (let i = 0; i < 16; i++) addNote(notes, 'outcomes', `turn ${i}`);
    expect(notes.outcomes).toHaveLength(12);
    expect(notes.outcomes[0]).toBe('turn 4');
    expect(notes.outcomes.at(-1)).toBe('turn 15');
    addNote(notes, 'outcomes', 'turn 5');
    expect(notes.outcomes.at(-1)).toBe('turn 5');
    addNote(notes, 'asks', 'x'.repeat(1000));
    expect(notes.asks[0]).toHaveLength(400);
    expect(notes.asks[0].endsWith('…')).toBe(true);
  });

  it('merges and parses', () => {
    const a = { ...emptyNotes(), todos: ['A'] };
    const b = { ...emptyNotes(), todos: ['A', 'B'], commits: ['c'] };
    expect(mergeNotes(a, b)).toEqual({ asks: [], outcomes: [], todos: ['A', 'B'], commits: ['c'] });
    expect(parseNotes({ todos: ['A', 4], outcomes: 'nope' })).toEqual({
      ...emptyNotes(),
      todos: ['A'],
    });
    expect(parseNotes({})).toBeUndefined();
    expect(parseNotes(null)).toBeUndefined();
  });
});

describe('notes in the task log', () => {
  it("credits plan items, commits and turn summaries to the agent's live task", () => {
    const store = new AgentStateStore();
    const tracker = new ProgressTracker(store, { dailyDir: null });
    const ledger = new TaskLedger(store, tracker, { dataDir: null });
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 'mac:s1',
        isExternal: true,
        projectDir: '/work',
        jsonlFile: '',
        directoryName: 'native-re',
      }),
    );
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    tracker.onToolStart(1, 'TodoWrite', { todos: [{ content: 'Decode the format' }] });
    tracker.onToolEnd(1, 'Bash', { command: 'git commit -m "Add decoder"' }, { failed: false });
    tracker.onTurnSummary(1, 'The decoder reads every save file now.');

    const [task] = ledger.tasksWithNotesFor(ledger.snapshot().date);
    expect(task.notes).toEqual({
      asks: [],
      outcomes: ['The decoder reads every save file now.'],
      todos: ['Decode the format'],
      commits: ['Add decoder'],
    });
    // The wire never carries them.
    expect(ledger.snapshot().tasks[0]).not.toHaveProperty('notes');
    ledger.dispose();
    tracker.dispose();
  });
});

describe('stock replies', () => {
  it('are not outcomes', () => {
    const notes = emptyNotes();
    for (const text of [
      'No response requested.',
      "You've hit your session limit · resets 5:40pm (Asia/Kolkata)",
      'API Error: 529 overloaded',
    ]) {
      expect(addNote(notes, 'outcomes', text)).toBe(false);
    }
    expect(addNote(notes, 'outcomes', 'The calendar is merged.')).toBe(true);
  });
});
