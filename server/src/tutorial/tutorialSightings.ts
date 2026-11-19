/**
 * What the server can see of the tutorial's quests, as pure functions: the
 * office's facts at one moment (TutorialFacts), and which quests those facts
 * show done against the ones the run started from. Generous on purpose: any
 * new character, any new Directory, any agent the Guide isn't, any saved
 * layout change counts, in whatever order the user does them.
 */

/** The office's facts a quest is judged on. */
export interface TutorialFacts {
  /** Every character's permanent id (the cast). */
  characterIds: readonly string[];
  /** Where the user's Directories are (config `directories`). */
  directoryPaths: readonly string[];
  /** The agents in the office, by id. */
  agentIds: readonly number[];
  /** The saved layout, as one comparable string (layoutSignature). */
  layout: string;
}

/** The quests `now` shows done, seen against the run's start (`from`);
 *  `guideId` is the Guide, whose own launch never counts. */
export function questsSeen(from: TutorialFacts, now: TutorialFacts, guideId?: number): string[] {
  const seen: string[] = [];
  const had = <T>(list: readonly T[]) => new Set(list);

  const characters = had(from.characterIds);
  if (now.characterIds.some((id) => !characters.has(id))) seen.push('create-character');

  const directories = had(from.directoryPaths);
  if (now.directoryPaths.some((p) => !directories.has(p))) seen.push('add-directory');

  const agents = had(from.agentIds);
  if (now.agentIds.some((id) => !agents.has(id) && id !== guideId)) seen.push('launch-agent');

  if (now.layout !== from.layout) seen.push('edit-layout');
  return seen;
}

/** A stored layout as one comparable string: its grid, tiles, colours, wall
 *  sets, furniture and Areas (what an editor save changes). */
export function layoutSignature(layout: Record<string, unknown> | null): string {
  if (!layout) return '';
  const { cols, rows, tiles, tileColors, wallSets, furniture, areas, areaTiles } = layout;
  return JSON.stringify(
    [cols, rows, tiles, tileColors, wallSets, furniture, areas, areaTiles].map((v) => v ?? null),
  );
}
