import type { UIEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { FoundConversation } from '../../../core/src/messages.js';
import type { TabStatus } from '../components/AgentCard.js';
import { Modal } from '../components/ui/Modal.js';
import { PixelIcon } from '../components/ui/PixelIcon.js';
import {
  CONVERSATION_SEARCH_DEBOUNCE_MS,
  CONVERSATION_SEARCH_PAGE,
  CONVERSATION_SEARCH_PREFETCH_PX,
} from '../constants.js';
import { transport } from '../transport/index.js';
import { ConversationRow, type ConversationSearchScope } from './ConversationList.js';

interface ConversationSearchProps {
  /** Where it searches when it opens; null = closed. */
  scope: ConversationSearchScope | null;
  onClose: () => void;
  /** A past conversation pressed: resume it. */
  onResume: (sessionId: string, directoryPath: string) => void;
  /** A running one pressed: go to its agent. */
  onOpenAgent: (agentId: number) => void;
  statusFor: (agentId: number) => TabStatus | null;
  /** Rows sized for a finger (the phone). */
  roomy?: boolean;
  /** Above whatever opened it (the phone's menu). */
  zIndex?: number;
}

/**
 * Every conversation, newest first, searched by title: "See all" and the
 * sidebar's search field open it, a Directory's "See all" opens it on that
 * Directory alone (a chip to drop, to search everywhere). The server does the
 * searching (the office only holds what the sidebar shows); results come a
 * page at a time, the next asked for as the list scrolls near its end.
 * Mounted at App's top level, so both shells show it.
 */
export function ConversationSearch(props: ConversationSearchProps) {
  const { scope, onClose, zIndex } = props;
  return (
    <Modal
      isOpen={scope !== null}
      onClose={onClose}
      title="Conversations"
      zIndex={zIndex}
      className="w-[min(520px,100%)]"
    >
      {scope && <SearchBody key={scope.directoryPath ?? ''} {...props} scope={scope} />}
    </Modal>
  );
}

interface Results {
  query: string;
  directoryPath: string | undefined;
  limit: number;
  results: FoundConversation[];
  more: boolean;
  receivedAt: number;
}

function SearchBody({
  scope,
  onClose,
  onResume,
  onOpenAgent,
  statusFor,
  roomy = false,
}: ConversationSearchProps & { scope: ConversationSearchScope }) {
  const [query, setQuery] = useState('');
  const [sent, setSent] = useState('');
  const [directory, setDirectory] = useState(scope.directoryPath ? scope : null);
  const [limit, setLimit] = useState(CONVERSATION_SEARCH_PAGE);
  const [answer, setAnswer] = useState<Results | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const directoryPath = directory?.directoryPath;

  useEffect(() => inputRef.current?.focus(), []);

  // Typing settles before it is sent, and starts again from the first page.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSent(query.trim());
      setLimit(CONVERSATION_SEARCH_PAGE);
    }, CONVERSATION_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Ask; take only the answer to the latest question.
  useEffect(() => {
    const unsubscribe = transport.onMessage((msg) => {
      if (msg.type !== 'conversationSearchResults') return;
      if (msg.query !== sent || msg.directoryPath !== directoryPath || msg.limit !== limit) return;
      setAnswer({ ...msg, directoryPath: msg.directoryPath, receivedAt: Date.now() });
    });
    transport.send({
      type: 'searchConversations',
      query: sent,
      limit,
      ...(directoryPath !== undefined ? { directoryPath } : {}),
    });
    return unsubscribe;
  }, [sent, directoryPath, limit]);

  // The answer to this search (at any page), if it came.
  const current =
    answer && answer.query === sent && answer.directoryPath === directoryPath ? answer : null;
  const loadingMore = current !== null && current.limit !== limit;
  // A new search keeps the old results on screen until its answer comes.
  const shown = answer?.results ?? [];

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const nearEnd =
      el.scrollHeight - el.scrollTop - el.clientHeight < CONVERSATION_SEARCH_PREFETCH_PX;
    if (nearEnd && current?.more && current.limit === limit) {
      setLimit((l) => l + CONVERSATION_SEARCH_PAGE);
    }
  };

  return (
    <div data-testid="conversation-search" className="flex flex-col gap-6 px-6 py-4">
      <div className="flex items-center gap-6 px-6 bg-bg-dark border-2 border-border focus-within:border-accent">
        <span className="shrink-0 flex text-text-muted">
          <PixelIcon name="search" scale={1} />
        </span>
        <input
          ref={inputRef}
          data-testid="conversation-search-input"
          type="text"
          value={query}
          placeholder={
            directory ? `Search ${directory.directoryName ?? ''}` : 'Search conversations'
          }
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 min-w-0 text-sm py-4 bg-transparent border-none outline-none rounded-none text-text"
        />
      </div>
      {directory && (
        <span className="flex">
          <button
            type="button"
            data-testid="conversation-search-scope"
            onClick={() => {
              setDirectory(null);
              setLimit(CONVERSATION_SEARCH_PAGE);
            }}
            title="Search every Directory"
            className="flex items-center gap-6 max-w-full py-1 px-6 bg-active-bg border-2 border-accent rounded-none cursor-pointer text-2xs text-text"
          >
            <span className="min-w-0 truncate">{directory.directoryName}</span>
            <PixelIcon name="close" scale={1} />
          </button>
        </span>
      )}
      <div
        data-testid="conversation-search-results"
        onScroll={onScroll}
        className="flex flex-col -mx-6 h-[min(420px,60vh)] overflow-y-auto quiet-scrollbar"
      >
        {shown.map(({ conversation, directoryPath: path, directoryName }) => (
          <ConversationRow
            key={conversation.sessionId}
            conversation={conversation}
            where={directory ? undefined : directoryName}
            onPress={() => {
              if (conversation.agentId !== undefined) onOpenAgent(conversation.agentId);
              else onResume(conversation.sessionId, path);
              onClose();
            }}
            statusFor={statusFor}
            now={answer?.receivedAt ?? 0}
            roomy={roomy}
          />
        ))}
        {shown.length === 0 && (
          <p className="m-0 px-10 py-8 text-sm text-text-muted">
            {current === null
              ? 'Searching…'
              : sent
                ? 'No conversation matches.'
                : 'No conversations yet.'}
          </p>
        )}
        {loadingMore && <p className="m-0 px-10 py-8 text-sm text-text-muted">Loading more…</p>}
      </div>
    </div>
  );
}
