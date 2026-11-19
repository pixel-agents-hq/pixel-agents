/**
 * The tutorial's quests: one list for the server (progress, the Guide's skill)
 * and the office (the checklist). Pure data. They have no order: the user does
 * them in any order, and the list's order is only how the checklist shows them.
 *
 * Every quest is completed by the server alone, when it sees the office change
 * (tutorial/tutorialSightings.ts); the user can skip any. Nobody else marks one:
 * a model saying "done" is not the office seeing it (docs/adr/0004).
 */

/** The Guide's Nickname (its card reads "<Directory> · Guide"); the office
 *  knows the Guide's launch by it. */
export const TUTORIAL_NICKNAME = 'Guide';

export interface TutorialQuest {
  id: string;
  /** A few words, as the checklist lists it. */
  title: string;
  /** What the user does, in one line that stands on its own. */
  goal: string;
  /** For the Guide: what the office counts, and the follow-ups it unlocks. */
  forGuide: string;
}

export const TUTORIAL_QUESTS: readonly TutorialQuest[] = [
  {
    id: 'create-character',
    title: 'Create your first character',
    goal: 'Open the roster (the arrow beside +), press + New, dress them up, and Save.',
    forGuide:
      "Counts when an office saves the cast with a character that was not there before. There is no Characters button: the arrow beside the + card opens the roster, and its + New (or a card's pencil) opens the Characters view: the roster on the left, the wardrobe tabs, colours, the pixel editor; nothing is kept until Save. Follow-up: a Directory can wear it by default (its default characters, in the Directory's pencil), and the arrow beside + launches one agent as any character.",
  },
  {
    id: 'add-directory',
    title: 'Add a project',
    goal: 'Press + and add a folder you work in as a Directory, so agents can start there.',
    forGuide:
      'Counts when a Directory that was not there before is saved. A Directory is a folder agents launch into; the + drawer lists them and each row launches an agent there. Follow-ups: give it an Area (its pencil, Area) so its agents sit together there — the default office has two, Studio (the room with desks) and Lounge — and default characters its agents wear.',
  },
  {
    id: 'launch-agent',
    title: 'Put an agent to work',
    goal: 'Press + and pick a Directory: a real Claude Code agent starts there and takes a desk.',
    forGuide:
      "Counts when any agent other than you joins the office, in any Directory. Then point out what they see: its character at a desk, its card, its terminal (a real Claude Code session in that folder they can use), its status as it works, and that the card's × closes it. Follow-up: the recent conversations panel (the button above the zoom buttons; on a phone, the menu at the top-left) lists each Directory's past sessions; pressing one resumes it (claude --resume) wearing its old character, back at its old seat when free.",
  },
  {
    id: 'edit-layout',
    title: 'Make the office yours',
    goal: 'Press Layout, change anything you like (paint a floor, move a desk, add a plant), and Save.',
    forGuide:
      'Counts when an office saves a layout that differs from the one before. Your own layout edits never count, so never edit the layout for this one. The editor has floor, walls, furniture, Areas, undo and Save. Follow-up: agents the office launches, you included, can change the layout for them through the Pixel Office MCP when asked.',
  },
];

export function tutorialQuest(id: string): TutorialQuest | undefined {
  return TUTORIAL_QUESTS.find((q) => q.id === id);
}
