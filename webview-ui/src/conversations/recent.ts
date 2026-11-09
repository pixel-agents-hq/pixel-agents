import type { Conversation, DirectoryConversations } from '../../../core/src/messages.js';

/** A conversation with the Directory it was listed under (a resume needs its path). */
export interface PlacedConversation {
  conversation: Conversation;
  directory: DirectoryConversations;
}

/**
 * The `count` newest conversations across every Directory. The server lists
 * each Directory's newest, so the newest overall are always among them: no
 * second request needed.
 */
export function recentAcross(
  directories: readonly DirectoryConversations[],
  count: number,
): PlacedConversation[] {
  return directories
    .flatMap((directory) =>
      directory.conversations.map((conversation) => ({ conversation, directory })),
    )
    .sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt)
    .slice(0, count);
}
