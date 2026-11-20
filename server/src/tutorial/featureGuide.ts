/**
 * What Pixel Agents does, for agents: the user-facing features, in the
 * glossary's words (CONTEXT.md), served by the Pixel Office MCP's
 * get_feature_guide tool (docs/adr/0004). Describes what the code does today,
 * on which adapter; a feature that changes changes here too.
 */

export interface FeatureGuideTopic {
  id: string;
  title: string;
  body: string;
}

export const FEATURE_GUIDE: readonly FeatureGuideTopic[] = [
  {
    id: 'office',
    title: 'The office and its characters',
    body:
      'Every AI coding session the office tracks is an agent, drawn as a pixel-art character. ' +
      'An active agent sits at its seat and types (or reads, for reading tools); one that is done wanders the office; ' +
      'one waiting for input or a permission stays seated. Above each character: its activity label ' +
      '("Reading foo.ts") and a context gauge, a small health bar of the context window left. ' +
      'Click a character to select it (white outline) and the camera follows it; click a free chair to give it that seat. ' +
      'Middle-drag pans, the zoom buttons (top-left) zoom. Pets wander too and belong to nobody. ' +
      'Agents are launched from the office or adopted: a Claude Code session started in a terminal of your own ' +
      'in one of the office\'s folders joins on its own ("Watch All Sessions" in Settings adopts sessions from every folder).',
  },
  {
    id: 'cards',
    title: 'Agent cards and statuses',
    body:
      'The card bar has one card per running main agent: its mug shot, a status dot, its name ' +
      '("Directory · nickname · worktree") and its context along the foot. Pressing a card reaches its agent ' +
      '(standalone: opens its terminal; VS Code: focuses its terminal). Drag cards to reorder them; every open office ' +
      'shares the order. The × closes the agent (its terminal ends). Statuses: active (working its turn), done ' +
      '(finished, nothing pending), waiting for input (asked the user something), permission request (blocked until ' +
      'the user approves a tool).',
  },
  {
    id: 'bubbles',
    title: 'Speech bubbles and sounds',
    body:
      'An amber "…" bubble means a permission request: it stays until the user answers in the terminal. ' +
      'A green checkmark means the turn finished; it fades by itself after a couple of seconds, with a two-note chime ' +
      '(Settings → Sound Notifications turns it off). When one agent messages another, its character walks over ' +
      "with the message's gist in its bubble.",
  },
  {
    id: 'terminal',
    title: 'Terminals (standalone desktop and phone)',
    body:
      "Standalone (npx pixel-agents in a browser): each agent's terminal lives in the office. On a desktop it is a " +
      'panel docked on the right; the cards beside it are its tabs. On a phone the office and the terminal are two ' +
      'pages: swipe from the right edge, or press >_ / Office, to switch; tapping a card in the office first selects ' +
      'its character, a second tap opens its terminal. A key bar above the keyboard adds /, tab, esc, arrows (a ' +
      'trackpad) and a line break. A long press in the input area pastes; copy is verbatim (Alt+C copies re-flowed ' +
      'text). A file dropped on a terminal, or pasted into it (a copied screenshot), is saved on the machine the ' +
      'agent runs on and its path typed in. VS Code uses its own terminals instead.',
  },
  {
    id: 'launching',
    title: 'Launching agents: Directories, the roster, Worktrees',
    body:
      'The + card (New agent) opens the launch drawer: a list of Directories, named folders agents launch into. ' +
      'The host contributes some (VS Code: workspace folders; standalone: the folder the server started in, shown when ' +
      '"Show Start Directory" is on) and the user adds their own with their pencil to edit (name, default characters, ' +
      'Worktree base and branch prefix). Pressing a Directory launches a Claude Code agent there. The arrow beside + ' +
      "opens the roster: pick a character first and the next launch wears it. A Directory's default characters show " +
      'as mug shots on its row. On a git repo row, the worktree button launches into a new Worktree: a separate ' +
      'checkout on its own branch, made for that agent and tidied when it leaves (clean: removed; commits of its own: ' +
      'folder removed, branch kept; uncommitted changes: the user chooses Save & remove, Keep folder or Discard).',
  },
  {
    id: 'conversations',
    title: 'Recent conversations and resume',
    body:
      'Standalone lists recent conversations: a sidebar on the left on desktop (shut at first; the button above the zoom buttons ' +
      'opens and shuts it), the menu (top-left button or a swipe from the left edge) on a phone. "Recent" shows the ' +
      'newest five across Directories, then one section per Directory, with its Worktrees at the end. Pressing a past ' +
      'conversation resumes it (claude --resume) wearing the character it had, in its old seat when free; a running ' +
      'one goes to its agent. Search finds conversations by title.',
  },
  {
    id: 'characters',
    title: 'The Characters view: wardrobe and custom items',
    body:
      "The arrow beside the + card opens the roster; its + New, or a card's pencil, opens the Characters view, the cast designer: a roster of " +
      'characters, an animated preview, and the wardrobe — tabs of items (hair, tops, outfits, shoes, hats, ' +
      'accessories…) each with colourways and colour sliders. A pixel editor paints over any worn piece; "Save as new ' +
      'item" turns those edits into a custom item any character can wear, and Export / Import PNG moves a piece sheet ' +
      'in and out. Edits are a draft until Save. Characters are what agents wear: two agents in the same character ' +
      'get different clothes colours.',
  },
  {
    id: 'layout',
    title: 'The layout editor: floor, walls, furniture, Areas',
    body:
      'The Layout button opens the editor. Floor paints a pattern + colour per tile; Walls paints a wall set (Plain, ' +
      'Brick, Wood planks, Stone, Wainscot, Office panel, Glass partition, Half panel, Cubicle) in a colour, and ' +
      'starting a stroke on the same wall erases instead; Erase turns tiles to void (removing furniture on them). ' +
      'Select (in Floor/Walls) picks a whole same-looking section to restyle at once. Furniture: pick from the ' +
      'catalogue tabs and place it (R rotates, T toggles on/off); in Select, drag to move, Alt-drag copies, drag on ' +
      'empty floor to box-select, Shift+click to select several; a selected item shows colour sliders, rotate and ' +
      'delete buttons. Desks carry what stands on them. The dashed border outside the grid grows it. Ctrl+Z / Ctrl+Y ' +
      'undo and redo; nothing is kept until Save. Areas are named, coloured regions ("the blue room"): Directories ' +
      'mapped to an Area seat their agents there. Chairs make seats.',
  },
  {
    id: 'usage',
    title: 'Usage bars',
    body:
      'Top-left, beside the zoom buttons: how much of the Claude Code plan is left — a weekly bar over a 5-hour ' +
      'bar (the weekly bar alone on a plan with no 5-hour limit; none for an API account, which has no plan), ' +
      "the share left in each, a pixel heart beside them; they appear once a session has replied. Hover (tap on a phone) to see each bar's reset time. " +
      "They need Settings → Usage Bars, which wraps the user's Claude Code status line to read the plan limits " +
      '(disclosed before it is turned on, undone exactly when turned off).',
  },
  {
    id: 'radio',
    title: 'The office radio',
    body:
      'Bottom-right (on a phone, swipe up from the bottom): procedural 8-bit background music. Play/pause, skip, ' +
      'volume, a mood (Auto or one of several), and a song code to share a tune or play a shared one. It never plays ' +
      'by itself. Settings → Music Player hides it.',
  },
  {
    id: 'subagents',
    title: 'Sub-agents and teammates',
    body:
      'When an agent delegates work without a name, a sub-agent appears beside it, same look, labelled "Subtask:", ' +
      'and goes when its task ends. When it spawns a named agent, that is a teammate: its own character in its own ' +
      "seat, its spawner becomes its lead (a LEAD badge), and they form a team. Clicking either reaches the lead's " +
      'terminal. Neither gets a card of its own.',
  },
  {
    id: 'settings',
    title: 'Settings',
    body:
      'Settings (desktop standalone: at the foot of the conversation sidebar; elsewhere a toolbar button) holds: ' +
      'Sound Notifications, Music Player, Watch All Sessions, Instant Detection (Hooks: Claude Code tells the office ' +
      'what happens instead of the office reading transcripts), Usage Bars, Pixel Office MCP and its Read-only switch, ' +
      "Always Show Labels, Display Headless as Ghosts, Show Areas, Skip Permissions (launches skip Claude Code's " +
      'permission prompts — a warning sign marks it), Show Start Directory / Workspace Folders, Debug View, external ' +
      'asset directories, layout import and export, and Play the tutorial.',
  },
  {
    id: 'mcp',
    title: 'The Pixel Office MCP',
    body:
      "With the user's consent, every agent the office launches gets the Pixel Agents Office MCP (server " +
      '"pixel-office"), its own key passed with --mcp-config. Through it an agent lists the agents (list_agents), reads ' +
      'the layout and catalogue (get_layout, list_catalog), edits the layout (edit_layout; an office shows it as a ' +
      'buildout from where the agent sits, and the editor offers "Undo <agent>\'s edit"), walks its character ' +
      '(visit), sets up Directories — a new project with its Areas and default characters (list_directories, ' +
      "edit_directories) — reads and types into other agents' terminals (read_agent_terminal, send_message), and on standalone " +
      'launches and closes agents (launch_agent, close_agent) and opens, reads, types into and closes PC shells — the ' +
      'plain terminals a PC opens on this machine, shown to the user as a card and a lit PC (list_pc_shells, ' +
      'open_pc_shell, read_pc_shell, type_in_pc_shell, close_pc_shell). Agents adopted from outside never get it. Settings turns ' +
      'it off, or read-only (look but change nothing). Claude Code still asks permission for each tool.',
  },
  {
    id: 'tutorial',
    title: 'The tutorial',
    body:
      'Offered at the end of the Intro (and from Settings → Play the tutorial): the greeter (Byte, unless renamed) ' +
      'sits down at a desk and becomes the Guide, a real Claude Code agent that shows the user around in its ' +
      'terminal, as a conversation (its onboarding skill). A short checklist (top-right, collapsed) holds four first ' +
      'steps done in any order: create your first character, add a project (a Directory), put an agent to work, ' +
      'make the office yours (the layout). Each completes when the office sees it, any can be skipped, and Quit ends ' +
      "the tutorial and closes the Guide's session; once all are done the checklist goes and the Guide stays. It " +
      'needs the Pixel Office MCP turned on.',
  },
];

/** The topics' ids and titles, for an agent choosing one. */
export function featureGuideIndex(): Array<{ id: string; title: string }> {
  return FEATURE_GUIDE.map(({ id, title }) => ({ id, title }));
}
