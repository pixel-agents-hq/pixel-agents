import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import type { Conversation, DirectoryConversations } from '../../../core/src/messages.js';
import type { TabStatus } from '../components/AgentCard.js';
import { CharacterMugShot } from '../components/CharacterMugShot.js';
import { STATUS_DOT } from '../components/statusDot.js';
import { PixelIcon } from '../components/ui/PixelIcon.js';
import { PixelText } from '../components/ui/PixelText.js';
import {
  CONVERSATION_EXPANDED_KEY,
  CONVERSATION_UNFOLD_MS,
  MUGSHOT_CROP_SIDE_PX,
  RECENT_CONVERSATIONS_COUNT,
} from '../constants.js';
import { prefersReducedMotion } from '../hooks/usePresence.js';
import { recentAcross } from './recent.js';
import { timeAgo } from './timeAgo.js';
import { useConversations } from './useConversations.js';

interface ConversationListProps {
  /** Whether it shows: the list is only fetched (and kept fresh) while it does. */
  open: boolean;
  /** A past conversation pressed: resume it. */
  onResume: (sessionId: string, directoryPath: string) => void;
  /** A running one pressed: go to its agent (as its card would). */
  onOpenAgent: (agentId: number) => void;
  /** A running conversation's status dot, the same as its agent card's. */
  statusFor: (agentId: number) => TabStatus | null;
  /** Rows sized for a finger (the phone's panel). */
  roomy?: boolean;
}

/**
 * The recent conversations, shared by the desktop sidebar and the phone's
 * panel: first the newest across every Directory ("Recent", each with its
 * Directory's name), then each Directory's own last conversations under a
 * header that expands and collapses it (one open at a time, collapsed until
 * this viewer opens it; remembered per browser). Titled as the coding agent
 * titles them, each with a mug shot of the character its agent wore. One an
 * agent in the office is running shows its status dot, and pressing it goes
 * to that agent; pressing a past one resumes it.
 */
export function ConversationList({
  open,
  onResume,
  onOpenAgent,
  statusFor,
  roomy = false,
}: ConversationListProps) {
  /** What pressing a row does: a running one opens its agent, a past one resumes. */
  const press = (conversation: Conversation, directory: DirectoryConversations) => () =>
    conversation.agentId !== undefined
      ? onOpenAgent(conversation.agentId)
      : onResume(conversation.sessionId, directory.path);
  const list = useConversations(open);
  // One open at a time: opening a Directory shuts the one that was open.
  const [openPath, setOpenPath] = useState(storedOpenPath);
  const toggle = (path: string) => {
    const next = openPath === path ? null : path;
    storeOpenPath(next);
    setOpenPath(next);
  };

  // flex-1 even while empty: whatever sits below the list stays at the bottom.
  if (list === null || list.directories.length === 0) {
    return (
      <p className="flex-1 m-0 px-10 py-8 text-sm text-text-muted">
        {list === null ? 'Loading…' : 'No Directories yet.'}
      </p>
    );
  }
  const recent = recentAcross(list.directories, RECENT_CONVERSATIONS_COUNT);
  const now = list.receivedAt;
  return (
    <div className="flex-1 min-h-0 quiet-scrollbar">
      <section data-testid="recent-conversations" className="pb-6 border-b-2 border-border">
        <SectionHeading>Recent</SectionHeading>
        {recent.length === 0 ? (
          <p className="m-0 px-10 py-2 text-xs text-text-muted">No conversations</p>
        ) : (
          recent.map(({ conversation, directory }) => (
            <ConversationRow
              key={conversation.sessionId}
              conversation={conversation}
              where={directory.name}
              onPress={press(conversation, directory)}
              statusFor={statusFor}
              now={now}
              roomy={roomy}
            />
          ))
        )}
      </section>
      <SectionHeading>By Directory</SectionHeading>
      {list.directories.map((directory) => (
        <DirectorySection
          key={directory.path}
          directory={directory}
          expanded={openPath === directory.path}
          onToggle={() => toggle(directory.path)}
          now={now}
          press={press}
          statusFor={statusFor}
          roomy={roomy}
        />
      ))}
    </div>
  );
}

/** A group's label: small, muted, uppercase-spaced, above its rows. */
function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className="m-0 px-10 pt-10 pb-4 text-2xs font-normal tracking-wider uppercase text-text-muted">
      {children}
    </h3>
  );
}

/** The open Directory, stored as `[path]` (or `[]`). */
function storedOpenPath(): string | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CONVERSATION_EXPANDED_KEY) ?? '[]') as unknown;
    const paths = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
    return paths[0] ?? null;
  } catch {
    return null;
  }
}

function storeOpenPath(path: string | null): void {
  try {
    localStorage.setItem(CONVERSATION_EXPANDED_KEY, JSON.stringify(path === null ? [] : [path]));
  } catch {
    // Not remembered; it still expands and collapses.
  }
}

interface SectionProps {
  directory: DirectoryConversations;
  expanded: boolean;
  onToggle: () => void;
  now: number;
  press: (conversation: Conversation, directory: DirectoryConversations) => () => void;
  statusFor: ConversationListProps['statusFor'];
  roomy: boolean;
}

function DirectorySection({
  directory,
  expanded,
  onToggle,
  now,
  press,
  statusFor,
  roomy,
}: SectionProps) {
  const { conversations } = directory;
  const empty = conversations.length === 0;
  const runningIds = conversations.flatMap((c) => (c.agentId !== undefined ? [c.agentId] : []));
  const running = runningIds.length > 0;
  const runningStatus = mostUrgent(runningIds.map(statusFor));
  const latest = empty ? undefined : Math.max(...conversations.map((c) => c.updatedAt));
  return (
    <section className="mx-6 mb-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={directory.path}
        className={`group w-full flex items-center gap-6 px-6 ${roomy ? 'py-6' : 'py-3'} border-2 rounded-none cursor-pointer text-left text-sm leading-tight ${
          expanded ? 'bg-btn-bg border-border' : 'bg-transparent border-transparent hover:bg-btn-bg'
        } ${empty ? 'text-text-muted' : 'text-text'}`}
      >
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {directory.name}
        </span>
        <span
          className={`shrink-0 flex ${expanded ? 'text-accent' : 'text-text-muted group-hover:text-text'}`}
        >
          <PixelIcon name={expanded ? 'down' : 'next'} scale={1} />
        </span>
        {/* Like a row: a running agent's status dot, else how long ago the last one was. */}
        <RowTrail running={running} status={runningStatus} at={latest} now={now} push />
      </button>
      <Unfold open={expanded}>
        {/* A rule along the bottom: where its drawer ends. */}
        {directory.conversations.length === 0 ? (
          <p className="m-0 px-10 py-4 border-b-2 border-border text-xs text-text-muted">
            No conversations
          </p>
        ) : (
          <div className="py-2 border-b-2 border-border">
            {directory.conversations.map((conversation) => (
              <ConversationRow
                key={conversation.sessionId}
                conversation={conversation}
                onPress={press(conversation, directory)}
                statusFor={statusFor}
                now={now}
                roomy={roomy}
              />
            ))}
          </div>
        )}
      </Unfold>
    </section>
  );
}

/**
 * Its children slide open and shut (a grid row growing from 0fr to 1fr, so
 * no height is measured). Shut, they are unmounted, once the fold has played.
 * Whatever is open on first render shows at once, without the slide.
 */
function Unfold({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [unfolded, setUnfolded] = useState(open);
  const instant = prefersReducedMotion();

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (instant) {
        setUnfolded(true);
        return;
      }
      // One frame at 0fr first, or there is nothing to slide from.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setUnfolded(true));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setUnfolded(false);
    if (instant) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), CONVERSATION_UNFOLD_MS);
    return () => clearTimeout(timer);
  }, [open, instant]);

  if (!mounted) return null;
  return (
    <div
      className="grid"
      style={{
        gridTemplateRows: unfolded ? '1fr' : '0fr',
        transition: instant ? 'none' : `grid-template-rows ${CONVERSATION_UNFOLD_MS}ms ease-out`,
      }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** The status that most needs the user, of several agents' (null: none known). */
const URGENCY: TabStatus[] = ['attention', 'disconnected', 'working', 'idle'];
function mostUrgent(statuses: Array<TabStatus | null>): TabStatus | null {
  return URGENCY.find((s) => statuses.includes(s)) ?? null;
}

interface RowProps {
  conversation: Conversation;
  /** The Directory's name, shown under the title (the Recent section). */
  where?: string;
  onPress: () => void;
  statusFor: ConversationListProps['statusFor'];
  now: number;
  roomy: boolean;
}

function ConversationRow({ conversation, where, onPress, statusFor, now, roomy }: RowProps) {
  const { title, updatedAt, palette, repeat, agentId } = conversation;
  const status = agentId !== undefined ? statusFor(agentId) : null;
  return (
    <button
      type="button"
      data-testid="conversation-row"
      onClick={onPress}
      title={agentId !== undefined ? `Go to "${title}"` : `Resume "${title}"`}
      className={`w-full flex items-center gap-8 px-10 ${roomy ? 'py-8' : where ? 'py-3' : 'py-5'} bg-transparent border-none rounded-none cursor-pointer text-left text-text hover:bg-btn-bg`}
    >
      <span className="shrink-0 flex" style={{ width: MUGSHOT_CROP_SIDE_PX }}>
        {palette !== undefined ? (
          <CharacterMugShot palette={palette} repeat={repeat ?? 0} zoom={1} />
        ) : (
          // Never seen in the office: it gets a character when it resumes.
          <span
            aria-hidden="true"
            className="border-2 border-dashed border-border"
            style={{ width: MUGSHOT_CROP_SIDE_PX, height: MUGSHOT_CROP_SIDE_PX }}
          />
        )}
      </span>
      {/* leading-none: the pixel font's line height opens a wide gap
          between the title and its Directory. */}
      <span className="flex-1 min-w-0 flex flex-col leading-none">
        <span className="text-sm overflow-hidden text-ellipsis whitespace-nowrap">{title}</span>
        {where && (
          <span className="-mt-1 text-2xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap">
            {where}
          </span>
        )}
      </span>
      <RowTrail
        running={agentId !== undefined}
        status={status}
        at={updatedAt}
        now={now}
        testId="conversation-status"
      />
    </button>
  );
}

interface RowTrailProps {
  running: boolean;
  status: TabStatus | null;
  /** When it was last written (nothing shows without it). */
  at: number | undefined;
  now: number;
  /** Pushed to the row's end (the header's; a row's title already fills). */
  push?: boolean;
  /** The status dot's test id. */
  testId?: string;
}

/**
 * A row's end: running, its agent card's status colour in place of the time,
 * as a round dot (a square one reads as a stop button); else how long ago.
 */
function RowTrail({ running, status, at, now, push = false, testId }: RowTrailProps) {
  if (running) {
    return (
      <span
        data-testid={testId}
        aria-label={status ?? 'running'}
        className={`shrink-0 flex ${push ? 'ml-auto ' : ''}mx-4 ${status ? STATUS_DOT[status] : 'text-text-muted'}`}
      >
        <PixelIcon name="dot" scale={1} />
      </span>
    );
  }
  if (at === undefined) return null;
  return (
    <PixelText
      text={timeAgo(at, now)}
      smaller
      className={`shrink-0 ${push ? 'ml-auto ' : ''}text-xs text-text-muted`}
    />
  );
}
