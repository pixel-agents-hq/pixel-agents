import { describe, expect, it } from 'vitest';

import { labelDensity, originLabel, truncateText } from '../src/office/agentLabel.js';

describe('truncateText', () => {
  it('leaves text that fits alone', () => {
    expect(truncateText('hobbyfi-blog', 12)).toBe('hobbyfi-blog');
  });

  it('cuts to the limit, the last character an ellipsis, no trailing space before it', () => {
    expect(truncateText('Draft review by email', 10)).toBe('Draft rev…');
    expect(truncateText('Draft review by email', 7)).toBe('Draft…');
  });

  it('never splits an emoji', () => {
    expect(truncateText('🚀🚀🚀🚀', 3)).toBe('🚀🚀…');
  });

  it('degrades to a lone ellipsis for a tiny limit', () => {
    expect(truncateText('abc', 1)).toBe('…');
  });
});

describe('originLabel', () => {
  it('reads <title> · <repo> for a titled local agent', () => {
    expect(originLabel({ title: 'Draft review by email', directoryName: 'hobbyfi-blog' })).toBe(
      'Draft review by email · hobbyfi-blog',
    );
  });

  it('falls back to just the repo with no title (today’s text)', () => {
    expect(originLabel({ directoryName: 'hobbyfi-blog' })).toBe('hobbyfi-blog');
    expect(originLabel({ title: '   ', directoryName: 'hobbyfi-blog' })).toBe('hobbyfi-blog');
  });

  it('keeps the source prefix for a remote agent: 💻 Mac · repo', () => {
    const source = { label: 'Mac', kind: 'computer' as const };
    expect(originLabel({ directoryName: 'hobbyfi-blog', source })).toBe('💻 Mac · hobbyfi-blog');
    expect(originLabel({ source: { label: 'Cloud box', kind: 'cloud' } })).toBe('☁ Cloud box');
  });

  it('puts a remote agent’s title between the source and the repo', () => {
    expect(
      originLabel({
        title: 'Fix CI',
        directoryName: 'pixel-agents',
        source: { label: 'Mac', kind: 'computer' },
      }),
    ).toBe('💻 Mac · Fix CI · pixel-agents');
  });

  it('cuts only the title, so the repo stays readable', () => {
    expect(
      originLabel(
        { title: 'Draft review by email for the blog', directoryName: 'hobbyfi-blog' },
        13,
      ),
    ).toBe('Draft review… · hobbyfi-blog');
  });

  it('is undefined when there is nothing to say', () => {
    expect(originLabel({})).toBeUndefined();
  });
});

describe('labelDensity', () => {
  it('compacts only on a phone with always-show on, for unfocused labels', () => {
    expect(labelDensity({ compactLabels: true, alwaysShow: true, focused: false })).toBe('compact');
  });

  it('keeps the focused (hovered/selected) agent’s label full', () => {
    expect(labelDensity({ compactLabels: true, alwaysShow: true, focused: true })).toBe('full');
  });

  it('never compacts on desktop', () => {
    expect(labelDensity({ compactLabels: false, alwaysShow: true, focused: false })).toBe('full');
  });

  it('never compacts with always-show off (only focused labels show then)', () => {
    expect(labelDensity({ compactLabels: true, alwaysShow: false, focused: false })).toBe('full');
  });
});
