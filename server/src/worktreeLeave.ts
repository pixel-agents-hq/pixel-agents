/**
 * The office's side of a Worktree's end: when its last agent has gone, apply
 * the leave rules (worktreeRetire.ts `retire`) in the background, and tell every
 * privileged office what each Directory's Worktrees hold now — a Worktree that
 * needs a decision opens the decision dialog there. The answer
 * (`decideWorktree`) comes back through here too.
 *
 * Retirement is keyed on the Worktree's PATH, not on one agent: a Worktree is
 * retired only once no live agent in the store runs in it, so a Teammate
 * leaving, or one of two agents in the same folder (a resumed session), never
 * takes the folder from under the others. The leave itself never holds up
 * closing: it starts after the process has exited, and nothing awaits it.
 * The card's × is the one exception that looks first (`handleCloseAgent`):
 * a quick `git status`, so a Worktree with uncommitted files is asked about
 * while its agent still runs, not a second after it has gone.
 */

import type {
  AgentCloseQuestion,
  CloseAgent,
  DecideWorktree,
  WorktreeChoice,
  WorktreesLoaded,
  WorktreeSummary,
} from '../../core/src/messages.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import type { AgentStateStore } from './agentStateStore.js';
import { cliName, isCliWorktree, removeCliWorktree } from './cliWorktrees.js';
import { WORKTREE_CLOSE_CHOICE_TTL_MS } from './constants.js';
import { latestWorktreeSession } from './conversations.js';
import { realPathKey, sameFolder } from './pathKey.js';
import { hookProviders } from './providers/index.js';
import type { AgentState } from './types.js';
import { worktreeLook } from './worktreeAgents.js';
import { listedDirectoryPath } from './worktreeAttribution.js';
import { uncommittedFileCount } from './worktreeInspect.js';
import { worktreesOf } from './worktreeListing.js';
import { worktreesCli } from './worktreeLocation.js';
import {
  entriesHeldBy,
  heldPaths,
  holdsWorktree,
  occupantOf,
  savedOccupant,
  worktreeInUse,
  type WorktreeOccupant,
} from './worktreeOccupancy.js';
import { hold, readRegistry, type WorktreeEntry } from './worktreeRegistry.js';
import {
  decide,
  deleteParkedBranch,
  retire,
  retireWith,
  type WorktreeActionResult,
  type WorktreeDecision,
} from './worktreeRetire.js';
import { sweep } from './worktreeSweep.js';

type Send = (message: Record<string, unknown>) => void;

const CHOICES: readonly WorktreeChoice[] = ['save', 'keep', 'discard', 'remove', 'deleteBranch'];

/** A non-negative integer from the wire, else undefined. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A Worktree's newest session, from the first bundled provider that files
 *  one for it. */
function latestSessionIn(
  directoryPath: string,
  worktree: { name: string; path: string },
): string | undefined {
  for (const provider of hookProviders) {
    const sessionId = latestWorktreeSession(provider, directoryPath, worktree);
    if (sessionId) return sessionId;
  }
  return undefined;
}

/** One Directory's Worktrees, as the office lists them: ours, then the CLI's
 *  own (shown, removed only at the user's word). */
export async function worktreesMessage(
  store: AgentStateStore,
  directoryPath: string,
): Promise<WorktreesLoaded> {
  const worktrees: WorktreeSummary[] = [];
  for (const listed of await worktreesOf(directoryPath, { details: true })) {
    const agentId = occupantOf(store, listed.entry ?? listed);
    const sessionId = latestSessionIn(directoryPath, listed);
    worktrees.push({
      name: listed.name,
      branch: listed.branch,
      owner: listed.owner,
      // The CLI's own have no state of ours: running while an agent is in one.
      state: listed.entry?.state ?? (agentId !== undefined ? 'active' : 'kept'),
      sizeBytes: listed.holds?.sizeBytes ?? 0,
      uncommittedFiles: listed.holds?.uncommittedFiles ?? 0,
      uniqueCommits: listed.holds?.uniqueCommits ?? 0,
      ...(sessionId ? { latestSessionId: sessionId } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...worktreeLook(store, listed, sessionId),
    });
  }
  // Keyed as the office lists the Directory, whichever spelling asked.
  const cliName = worktreesCli()?.displayName;
  return {
    type: 'worktreesLoaded',
    directoryPath: listedDirectoryPath(directoryPath),
    worktrees,
    ...(cliName !== undefined ? { cliName } : {}),
  };
}

/** The connect snapshot: one `worktreesLoaded` per Directory that has any. */
export async function worktreesSnapshot(store: AgentStateStore): Promise<WorktreesLoaded[]> {
  const directories: string[] = [];
  for (const entry of readRegistry()) {
    if (!directories.some((d) => sameFolder(d, entry.directoryPath))) {
      directories.push(entry.directoryPath);
    }
  }
  return Promise.all(directories.map((d) => worktreesMessage(store, d)));
}

/** Tell every privileged office what `directoryPath`'s Worktrees hold now
 *  (`worktreesLoaded` is a privileged broadcast type). Never rejects. */
export async function broadcastWorktrees(
  store: AgentStateStore,
  directoryPath: string,
): Promise<void> {
  try {
    store.broadcast({ ...(await worktreesMessage(store, directoryPath)) });
  } catch (err) {
    console.error(`[Pixel Agents] Worktrees: couldn't list ${directoryPath}:`, err);
  }
}

/**
 * The agent running in `worktree` has gone (its process exited, or never
 * started): apply the leave rules once no live agent runs there. Returns the
 * work's promise for tests; callers never await it. Only a Worktree an agent
 * was running in (`active`) is retired here — a kept or parked one is the
 * user's to manage.
 */
export function retireWhenUnused(
  store: AgentStateStore,
  worktree: { path: string },
): Promise<void> {
  // Shutting down: the agent didn't leave, the server killed it. The next
  // startup's sweep applies the same rules unhurried (see stopRetiring).
  if (retiringStopped) return Promise.resolve();
  const entry = readRegistry().find((e) => sameFolder(e.path, worktree.path));
  if (!entry || entry.state !== 'active') return Promise.resolve();
  // The answer given at the card's ×, if any: taken now, so one the leave
  // can't use (another agent still runs there) never applies to a later one.
  const answered = takeCloseChoice(entry.path);
  if (worktreeInUse(store, entry)) return Promise.resolve();
  return track(answered ? retireWith(entry, answered) : retire(entry)).then(async (result) => {
    if (result.ok) {
      const how = answered ? ` (answered ${answered.choice})` : '';
      console.log(
        `[Pixel Agents] Worktrees: ${entry.branch} - its agent left${how}: ${result.outcome}`,
      );
    } else {
      console.warn(`[Pixel Agents] Worktrees: ${entry.branch} - not retired: ${result.reason}`);
    }
    await broadcastWorktrees(store, entry.directoryPath);
  });
}

/**
 * An agent has left the office (its process exited, or its terminal was found
 * gone on restore): every Worktree of ours it held that is still `active`
 * goes through `retireWhenUnused` — the one it ran in, and the one it was
 * launched into when it had moved out of it. One it moved into that isn't
 * ours is left alone. Call it after the agent is out of the store. Returns
 * the work's promise for tests; callers never await it.
 */
export function retireWorktreesLeftBy(
  store: AgentStateStore,
  agent: WorktreeOccupant,
): Promise<void> {
  const active = entriesHeldBy(agent).filter((entry) => entry.state === 'active');
  return Promise.all(active.map((entry) => retireWhenUnused(store, entry))).then(() => undefined);
}

/**
 * Whether this Pixel Agents process owns the agent's process: a terminal it
 * started or reattached (standalone's PTY, a VS Code terminal in this window).
 * Everything else is `isExternal` — sessions adopted by location or by the
 * scanners, restored external agents, Teammates and Sub-agents — and runs in
 * a process some other host (or nobody) owns.
 */
function ownsAgentProcess(agent: { isExternal: boolean; leadAgentId?: number }): boolean {
  return !agent.isExternal && agent.leadAgentId === undefined;
}

/**
 * Every agent whose process this Pixel Agents process owns (launched, resumed,
 * reattached, restored with its terminal) and that runs in one of our
 * Worktrees makes this process its holder, so another Pixel Agents process (a
 * VS Code window, the standalone server) never retires the folder from under
 * it. Only the owner claims: its leave path is what retires the Worktree when
 * the agent's terminal ends, and the hook script reports every session to
 * every live server, so an adopter claiming it would block that owner's
 * retire for as long as the adopter runs. Both surfaces call it once, before
 * any agent is added. Returns the unsubscribe.
 */
export function holdWorktreesOf(store: AgentStateStore): () => void {
  const onAdded = (_id: number, agent: AgentState) => {
    if (!ownsAgentProcess(agent)) return;
    // Its Worktree, and the one it started in when it has moved since (it
    // still runs there as far as the leave rules are concerned).
    try {
      for (const entry of entriesHeldBy(agent)) hold(entry);
    } catch (err) {
      console.error('[Pixel Agents] Worktrees: could not record the holder:', err);
    }
  };
  store.on('agentAdded', onAdded);
  return () => store.off('agentAdded', onAdded);
}

/** `requestWorktrees`: the Directory's Worktrees, to the client that asked. */
export async function handleRequestWorktrees(
  store: AgentStateStore,
  msg: Record<string, unknown>,
  send: Send,
): Promise<void> {
  if (typeof msg.directoryPath !== 'string') return;
  send({ ...(await worktreesMessage(store, msg.directoryPath)) });
}

/**
 * `decideWorktree`: the user's answer for a Worktree no agent runs in — a
 * decision (save, keep, discard) or a Worktrees list action (`remove`: the
 * leave rules, which may come back needing a decision; `deleteBranch`: a
 * parked one's branch, confirmed when its commits are merged nowhere).
 * One of the CLI's own worktrees takes `remove` alone: its folder and branch,
 * losing no more than the files and commits the user confirmed
 * (`removeCliWorktree`, which names the CLI and reads its lock). Refused (to the sender, as
 * `worktreeDecisionRejected`) when it names no Worktree, an agent runs in it,
 * or git could not do it; every office is then sent the Worktrees as they stand, so an
 * answered dialog closes everywhere.
 */
export async function handleDecideWorktree(
  store: AgentStateStore,
  msg: Record<string, unknown>,
  send: Send,
): Promise<void> {
  const { directoryPath, name, choice, confirmedFiles, confirmedCommits } =
    msg as Partial<DecideWorktree>;
  if (typeof directoryPath !== 'string' || typeof name !== 'string') return;
  const reject = (reason: string) =>
    send({ type: 'worktreeDecisionRejected', directoryPath, name, reason });
  if (!CHOICES.includes(choice as WorktreeChoice)) return reject(`Unknown choice: ${choice}`);
  const confirmed = count(confirmedFiles);
  // Discarding deletes work: only ever the number of files the user was shown.
  if (choice === 'discard' && confirmed === undefined) {
    return reject('Discarding needs the number of files you confirmed losing.');
  }

  const entry: WorktreeEntry | undefined = readRegistry().find(
    (e) => e.name === name && sameFolder(e.directoryPath, directoryPath),
  );
  if (!entry && isCliWorktree(directoryPath, name)) {
    if (choice !== 'remove') {
      reject(`${name} is ${cliName()}'s worktree: Pixel Agents can only remove it.`);
    } else {
      const result = await removeCliWorktree(directoryPath, name, {
        confirmedFiles: confirmed,
        confirmedCommits: count(confirmedCommits),
        inUse: (folder) => worktreeInUse(store, { path: folder }),
      });
      if (result.ok) {
        console.log(
          `[Pixel Agents] Worktrees: ${name} (${cliName()}'s) - remove: removed${result.branchKept ? ', branch kept' : ''}`,
        );
      } else {
        reject(result.reason);
      }
    }
  } else if (!entry) {
    reject(`There is no Worktree ${name} in ${directoryPath}.`);
  } else if (worktreeInUse(store, entry)) {
    reject(`An agent is still running in ${entry.branch}.`);
  } else {
    let result: WorktreeActionResult;
    if (choice === 'remove') {
      result = await retire(entry);
    } else if (choice === 'deleteBranch') {
      result = await deleteParkedBranch(entry, { confirmedCommits: count(confirmedCommits) });
    } else if (choice === 'discard') {
      result = await decide(entry, { choice, confirmedFiles: confirmed! });
    } else {
      result = await decide(entry, { choice: choice as 'save' | 'keep' });
    }
    if (result.ok) {
      console.log(`[Pixel Agents] Worktrees: ${entry.branch} - ${choice}: ${result.outcome}`);
    } else {
      reject(result.reason);
    }
  }
  await broadcastWorktrees(store, directoryPath);
}

// ── Closing from the card ───────────────────────────────────

/** Answers given at the card's × (by Worktree folder, realPathKey), waiting
 *  for their agent's exit to retire the Worktree with them. */
const closeChoices = new Map<string, { decision: WorktreeDecision; at: number }>();

/** The answer waiting for `worktreePath`'s leave, if one was given recently.
 *  Taken: it applies to one leave at most. */
function takeCloseChoice(worktreePath: string): WorktreeDecision | undefined {
  const key = realPathKey(worktreePath);
  const waiting = closeChoices.get(key);
  closeChoices.delete(key);
  if (!waiting || Date.now() - waiting.at > WORKTREE_CLOSE_CHOICE_TTL_MS) return undefined;
  return waiting.decision;
}

/**
 * What closing agent `id` would leave behind that needs the user's answer: a
 * Worktree of ours it runs in, that no other agent stays in (its Teammates go
 * with it), holding uncommitted files. Null when there is none, or when this
 * process doesn't own the agent's process (an adopted session: its own host
 * applies the leave rules).
 */
async function closeQuestion(
  store: AgentStateStore,
  id: number,
): Promise<{ question: AgentCloseQuestion; path: string } | null> {
  const agent = store.get(id);
  if (!agent || !ownsAgentProcess(agent)) return null;
  for (const entry of entriesHeldBy(agent)) {
    if (entry.state !== 'active') continue;
    const staying = [...store].some(
      ([otherId, other]) =>
        otherId !== id && other.leadAgentId !== id && holdsWorktree(other, entry),
    );
    if (staying) continue;
    const uncommittedFiles = await uncommittedFileCount(entry);
    if (uncommittedFiles === 0) continue;
    return {
      path: entry.path,
      question: {
        type: 'agentCloseQuestion',
        id,
        directoryPath: listedDirectoryPath(entry.directoryPath),
        name: entry.name,
        branch: entry.branch,
        uncommittedFiles,
      },
    };
  }
  return null;
}

/** The answer a `closeAgent` carries, when it still covers what the
 *  Worktree holds: a discard only for at least as many files as there are now. */
function closeDecision(msg: CloseAnswer, files: number): WorktreeDecision | null {
  switch (msg.worktreeChoice) {
    case 'save':
    case 'keep':
      return { choice: msg.worktreeChoice };
    case 'discard': {
      const confirmed = count(msg.confirmedFiles);
      return confirmed !== undefined && confirmed >= files
        ? { choice: 'discard', confirmedFiles: confirmed }
        : null;
    }
    default:
      return null;
  }
}

/** The answer to a close question, as `closeAgent` carries it. */
type CloseAnswer = Pick<Partial<CloseAgent>, 'worktreeChoice' | 'confirmedFiles'>;

/** A Worktree answer kept for its agent's exit. */
export interface KeptCloseAnswer {
  name: string;
  branch: string;
  decision: WorktreeDecision;
}

/** What a close came to (`closeAgentAsking`). */
export type CloseAttempt =
  /** Closed (`close` was called). `answered`: the Worktree answer kept for its exit. */
  | { closed: true; answered?: KeptCloseAnswer }
  /** Not closed: the Worktree it would leave holds uncommitted files, and no
   *  answer given covers them (none, or a discard of fewer files than now). */
  | { closed: false; question: AgentCloseQuestion }
  /** Not closed: there is no such agent (any more). */
  | { closed: false; gone: true };

/**
 * Close agent `id` the way the card's × does, for any caller (the × itself,
 * the Pixel Office MCP's close_agent): an agent leaving a Worktree of ours
 * with uncommitted files is NOT closed unless `answer` covers them — the
 * caller gets the question back and the agent keeps running. A covering
 * answer is kept for the agent's exit, whose leave applies it
 * (`retireWhenUnused`), and the agent is closed. Anything else closes at
 * once. `close` is the surface's way to end the agent.
 */
export async function closeAgentAsking(
  store: AgentStateStore,
  id: number,
  answer: CloseAnswer,
  close: (id: number) => void,
): Promise<CloseAttempt> {
  if (!store.has(id)) return { closed: false, gone: true };
  let asked: Awaited<ReturnType<typeof closeQuestion>> = null;
  try {
    asked = await closeQuestion(store, id);
  } catch (err) {
    // Couldn't look: close anyway, and the leave rules ask after the exit.
    console.error('[Pixel Agents] Worktrees: could not check before closing:', err);
  }
  let answered: KeptCloseAnswer | undefined;
  if (asked) {
    const decision = closeDecision(answer, asked.question.uncommittedFiles);
    if (!decision) return { closed: false, question: asked.question };
    closeChoices.set(realPathKey(asked.path), { decision, at: Date.now() });
    answered = { name: asked.question.name, branch: asked.question.branch, decision };
  }
  // It may have exited on its own while git looked.
  if (!store.has(id)) return { closed: false, gone: true };
  close(id);
  return answered ? { closed: true, answered } : { closed: true };
}

/**
 * `closeAgent` (the card's ×), for either surface: `closeAgentAsking`, with
 * the question sent to the sender as `agentCloseQuestion`. The answer comes
 * back as a `closeAgent` carrying `worktreeChoice`; one that no longer
 * covers the Worktree (more files than a discard confirmed) is asked again.
 */
export async function handleCloseAgent(
  store: AgentStateStore,
  msg: Record<string, unknown>,
  send: Send,
  close: (id: number) => void,
): Promise<void> {
  const id = msg.id;
  if (typeof id !== 'number') return;
  const attempt = await closeAgentAsking(store, id, msg as Partial<CloseAgent>, close);
  if (!attempt.closed && 'question' in attempt) send({ ...attempt.question });
}

// ── Restarts ────────────────────────────────────────────────

/** Set once the server starts shutting down: no new retirement (or sweep) starts. */
let retiringStopped = false;
/** Retirements (and the sweep) whose git work is under way. */
const inFlight = new Set<Promise<unknown>>();

function track<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work));
  return work;
}

/**
 * The server is shutting down: retire nothing more. With in-process
 * terminals, shutting down kills every agent, and each exit would start a
 * retirement the process exit then cuts short mid-git (a folder half
 * removed, a branch left checked out nowhere). Those agents didn't leave —
 * the server ended them — and their Worktrees stay `active`, which the next
 * startup's sweep treats as what they are: Worktrees whose agent is gone.
 * Returns once the retirements already under way have finished (or after
 * `timeoutMs`), so the caller can exit without cutting one short.
 */
export async function stopRetiring(timeoutMs: number): Promise<void> {
  retiringStopped = true;
  if (inFlight.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Tests only: undo stopRetiring. */
export function resumeRetiringForTests(): void {
  retiringStopped = false;
}

/**
 * The startup tidy-up, for either surface: the sweep (worktreeSweep.ts) with
 * the Worktrees agents hold as in use, then every privileged office told what
 * changed. Held: every agent in the store, and every saved agent
 * `savedAgentsHold` keeps — restored only when an office connects, which may
 * come after the sweep. Standalone keeps its saved external agents (its
 * terminal agents were reattached into the store before the sweep, or died
 * with the last server); VS Code keeps every saved agent, since its terminals
 * outlive the extension host and are restored only when the office opens.
 * Run it after restored and reattached agents are in the store, in the
 * background: nothing waits on it, and it never rejects.
 */
export async function sweepWorktrees(
  store: AgentStateStore,
  { savedAgentsHold }: { savedAgentsHold: (saved: PersistedAgent) => boolean },
): Promise<void> {
  if (retiringStopped) return;
  try {
    // Asked per entry, inside its repo's queue: an agent that arrived while
    // the sweep ran (a launch, a reattach) counts.
    const held = () =>
      heldPaths([
        ...store.values(),
        ...store.loadPersistedAgents().filter(savedAgentsHold).map(savedOccupant),
      ]);
    const report = await track(
      sweep({ inUse: (worktreePath) => held().has(realPathKey(worktreePath)) }),
    );
    for (const directoryPath of report.changedDirectories) {
      await broadcastWorktrees(store, directoryPath);
    }
  } catch (err) {
    console.error('[Pixel Agents] Worktrees: startup sweep failed:', err);
  }
}
