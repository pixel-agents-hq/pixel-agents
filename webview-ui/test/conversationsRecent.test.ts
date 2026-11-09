import { describe, expect, it } from 'vitest';

import type { DirectoryConversations } from '../../core/src/messages.js';
import { recentAcross } from '../src/conversations/recent.js';

const dir = (name: string, times: number[]): DirectoryConversations => ({
  name,
  path: `/${name}`,
  conversations: times.map((t) => ({
    sessionId: `${name}-${t}`,
    title: `${name} ${t}`,
    updatedAt: t,
  })),
});

describe('recentAcross', () => {
  it('takes the newest across Directories, each with its Directory', () => {
    const recent = recentAcross([dir('a', [9, 4, 1]), dir('b', [8, 7, 2]), dir('c', [])], 4);
    expect(recent.map((r) => r.conversation.sessionId)).toEqual(['a-9', 'b-8', 'b-7', 'a-4']);
    expect(recent[1].directory.path).toBe('/b');
  });

  it('returns fewer when there are fewer', () => {
    expect(recentAcross([dir('a', [3])], 5)).toHaveLength(1);
    expect(recentAcross([], 5)).toEqual([]);
  });
});
