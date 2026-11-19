/**
 * Generated Worktree names: two words, adjective-noun, kebab case
 * (`brave-otter`). Short enough to read in a label, distinct enough to tell
 * apart, and valid as a folder name and a branch name everywhere.
 */

const ADJECTIVES = [
  'amber',
  'bold',
  'brave',
  'bright',
  'brisk',
  'calm',
  'clever',
  'cosy',
  'crisp',
  'dapper',
  'eager',
  'fancy',
  'fleet',
  'gentle',
  'glad',
  'golden',
  'happy',
  'humble',
  'jolly',
  'keen',
  'kind',
  'lively',
  'lucky',
  'mellow',
  'merry',
  'mighty',
  'neat',
  'nimble',
  'noble',
  'plucky',
  'polite',
  'proud',
  'quick',
  'quiet',
  'rapid',
  'rosy',
  'shiny',
  'silver',
  'sleek',
  'snappy',
  'steady',
  'sunny',
  'swift',
  'tidy',
  'trusty',
  'vivid',
  'warm',
  'witty',
  'zesty',
  'zippy',
] as const;

const NOUNS = [
  'badger',
  'beacon',
  'bison',
  'brook',
  'canyon',
  'cedar',
  'comet',
  'coral',
  'crane',
  'dune',
  'falcon',
  'fern',
  'fjord',
  'fox',
  'gecko',
  'glacier',
  'harbor',
  'heron',
  'island',
  'lantern',
  'lark',
  'lynx',
  'maple',
  'meadow',
  'meteor',
  'moose',
  'nebula',
  'oak',
  'orchid',
  'otter',
  'owl',
  'panda',
  'pebble',
  'pine',
  'quail',
  'raven',
  'reef',
  'river',
  'robin',
  'sparrow',
  'spruce',
  'summit',
  'tiger',
  'tulip',
  'valley',
  'walrus',
  'willow',
  'wombat',
  'yak',
  'zebra',
] as const;

/** One generated name. `random` is injectable so a test can pick the words. */
export function randomWorktreeName(random: () => number = Math.random): string {
  const pick = <T>(words: readonly T[]): T => words[Math.floor(random() * words.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

/** The longest name a user may give a Worktree (it is a folder name and part
 *  of a branch name, and shows in labels). */
export const WORKTREE_NAME_MAX_LENGTH = 64;

/** Why `name` can't name a Worktree, or null when it can: one folder name
 *  (letters, digits, `.`, `_`, `-`, starting with a letter or digit, never
 *  `..`, never ending `.` or `.lock`) that is also a valid branch name part.
 *  Generated names always pass. */
export function worktreeNameProblem(name: string): string | null {
  if (name.length === 0) return 'Give the worktree a name.';
  if (name.length > WORKTREE_NAME_MAX_LENGTH) {
    return `A worktree name can be at most ${WORKTREE_NAME_MAX_LENGTH} characters.`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return 'A worktree name can only use letters, digits, ".", "_" and "-", starting with a letter or digit.';
  }
  if (name.includes('..') || name.endsWith('.') || name.toLowerCase().endsWith('.lock')) {
    return `"${name}" can't be a branch name.`;
  }
  return null;
}
