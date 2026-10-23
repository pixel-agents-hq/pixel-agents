/**
 * What an agent's status label says, as pure text rules (DOM-free, so they run
 * on the Node runner). ToolOverlay draws the result.
 *
 * The origin line names the session's task and where it runs:
 * `Draft review by email · hobbyfi-blog`, prefixed with the machine for a
 * relayed remote session (`💻 Mac · hobbyfi-blog`). The task title comes from
 * the server (agentCreated.title / existingAgents.titles / agentTitle); without
 * one the line is what it always was — the Directory, plus the remote prefix.
 */

/** Where a relayed remote session runs (OfficeState.agentSources). */
export interface AgentSource {
  label: string;
  kind: 'computer' | 'cloud';
}

export interface AgentOrigin {
  /** The session's task title, when the server knows one. */
  title?: string;
  /** The agent's Directory (repo) name. */
  directoryName?: string;
  /** Present only for a relayed remote session. */
  source?: AgentSource;
}

const SOURCE_ICONS: Record<AgentSource['kind'], string> = {
  cloud: '☁',
  computer: '💻',
};

const ELLIPSIS = '…';

/**
 * `text` cut to at most `max` characters, the last one an ellipsis when
 * anything was cut. Counts code points, so an emoji is never split in half.
 */
export function truncateText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= 1) return ELLIPSIS;
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}${ELLIPSIS}`;
}

/**
 * The label's origin line: `[source ·] [title ·] repo`, each part only when
 * known; undefined when there is nothing to say. The title alone is cut to
 * `maxTitleChars` (the repo is the short, stable part and stays readable);
 * pass Infinity for the full title (a hovered or selected label).
 */
export function originLabel(origin: AgentOrigin, maxTitleChars = Infinity): string | undefined {
  const title = origin.title?.trim();
  const parts: string[] = [];
  if (origin.source) parts.push(`${SOURCE_ICONS[origin.source.kind]} ${origin.source.label}`);
  if (title) parts.push(truncateText(title, maxTitleChars));
  if (origin.directoryName) parts.push(origin.directoryName);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** 'full': every row the label has. 'compact': the activity line alone, small. */
export type LabelDensity = 'full' | 'compact';

/**
 * How much a label shows. On a phone with Always Show Labels on, every label
 * at full size piles up over a 390px-wide office, so the ones nobody is
 * looking at shrink to their activity line; the hovered or selected agent
 * keeps its origin line, stage track and the rest. Desktop never compacts,
 * and with Always Show off only focused labels show at all, so they are full.
 */
export function labelDensity({
  compactLabels,
  alwaysShow,
  focused,
}: {
  /** The phone layout (useIsMobile). */
  compactLabels: boolean;
  alwaysShow: boolean;
  /** This agent is hovered or selected. */
  focused: boolean;
}): LabelDensity {
  return compactLabels && alwaysShow && !focused ? 'compact' : 'full';
}
