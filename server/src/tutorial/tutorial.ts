/**
 * The tutorial's owner, one per office server (composed into the Pixel Office
 * MCP feature, composeOfficeMcp.ts): whether it can be offered, the run under
 * way, and every way it moves —
 *
 * - started only by an office's `startTutorial` (the Intro's permission step:
 *   nothing launches without that yes), which launches the Guide through the
 *   surface's own launch with the MCP, its look and its skill's command;
 * - quests seen done by the server alone (tutorialSightings.ts: the office's
 *   facts checked against the ones the run started from, whenever the cast,
 *   the Directories, the agents or the layout may have changed, and on every
 *   `tutorial` call of the Guide's), or skipped by the user;
 * - ended when the user quits (the Guide is closed, as its card's × would) or
 *   the Guide leaves the office.
 *
 * Progress itself is the pure reducer in tutorialProgress.ts. Memory only: a
 * run lives exactly as long as its agent's MCP token (docs/adr/0003, 0004).
 */

import type { ServerMessage, TutorialStatus } from '../../../core/src/messages.js';
import type { SkillPackaging } from '../../../core/src/provider.js';
import { tutorialQuest } from '../../../core/src/tutorial/quests.js';
import type { AgentStateStore } from '../agentStateStore.js';
import type { AgentMcpAccess } from '../mcp/officeMcp.js';
import type { AgentLaunchOutcome } from '../mcp/officeOperations.js';
import {
  TUTORIAL_NICKNAME,
  TUTORIAL_PREAPPROVED_TOOLS,
  tutorialBrief,
  tutorialDisclosure,
  tutorialFirstMessage,
  tutorialHeadline,
  tutorialSkillName,
} from './tutorialCopy.js';
import {
  isTutorialFinished,
  reduceTutorialProgress,
  type TutorialProgress,
  type TutorialProgressEvent,
} from './tutorialProgress.js';
import { questsSeen, type TutorialFacts } from './tutorialSightings.js';

/** The Guide's launch, as a surface runs it. */
export interface TutorialLaunch {
  /** The character it wears (the greeter's), when the office named one. */
  palette?: number;
  firstMessage: string;
  nickname: string;
  /** Pixel Office MCP tool names it may call without a permission prompt. */
  preapprovedTools: readonly string[];
  /** The seat the greeter walked to: taken when free. */
  seatId?: string;
  /** A plugin directory for this session alone, holding the onboarding skill,
   *  where the CLI packages skills. */
  pluginDir?: string;
}

/** What a surface brings so its office can run the tutorial. */
export interface TutorialSurface {
  /** The Directory the Guide would launch into (its name), or why it can't launch now. */
  where(): { ok: true; directoryName: string | null } | { ok: false; reason: string };
  /** Launch the Guide with the MCP (`mcp`), resolving once it is an agent of the store. */
  launch(request: TutorialLaunch, mcp: AgentMcpAccess): Promise<AgentLaunchOutcome>;
  /** End an agent as its card's × does. */
  close(id: number): void;
}

/** What the tutorial needs from the rest of the office. */
export interface TutorialDeps {
  store: AgentStateStore;
  /** The surface's side, or absent where the office can't launch it. */
  surface?: TutorialSurface;
  /** Why this office can't hand the Pixel Office MCP to the agents it
   *  launches, whatever the consent (its server is another's, or its CLI takes
   *  no MCP config), in plain words; null where it can. */
  mcpUnavailable(): string | null;
  /** Whether agents get the Pixel Office MCP (its consent granted). */
  mcpGranted(): boolean;
  /** The MCP access the Guide's launch is given. */
  mcp: AgentMcpAccess;
  /** The office's facts its server quests are judged on (tutorialSightings.ts). */
  readFacts(): TutorialFacts;
  /** The Guide's name: the character `palette` names, else the greeter's. */
  guideName(palette?: number): string;
  /** How the Guide's CLI packages skills, or absent where it has none: the
   *  Guide is then sent to the `tutorial` tool's brief. */
  skills?: SkillPackaging;
  /** Write the onboarding skill for a launch (as `name`); returns the folder
   *  the launch names, or nothing where the CLI packages no skills. */
  writePlugin(name: string): string | undefined;
}

/** The `tutorial` tool's view, for the agent asking. */
export type TutorialView =
  | { running: false; note: string }
  | {
      running: true;
      agentId: number;
      you: boolean;
      /** The skill that runs the tour, for the agent running it. */
      skill?: string;
      brief?: string;
      finished: boolean;
      quests: Array<{
        id: string;
        title: string;
        goal: string;
        state: string;
        forGuide: string;
      }>;
    };

export type TutorialSkipOutcome = { ok: true; view: TutorialView } | { ok: false; reason: string };

export class Tutorial {
  private progress: TutorialProgress = null;
  private starting = false;
  /** The facts the run started from (the layout re-baselined by agents' edits). */
  private baseline: TutorialFacts | null = null;
  /** The running Guide's name (its character's, read at start). */
  private name = '';
  private readonly detach: () => void;

  constructor(private readonly deps: TutorialDeps) {
    const { store } = deps;
    const onRemoved = (id: number): void => {
      if (this.progress?.agentId === id) this.apply({ kind: 'ended' });
    };
    const onBroadcast = (message: Record<string, unknown>): void => this.heard(message);
    // An agent joining may be the put-an-agent-to-work quest.
    const onAdded = (): void => this.look();
    store.on('agentAdded', onAdded);
    store.on('agentRemoved', onRemoved);
    store.on('broadcast', onBroadcast);
    this.detach = () => {
      store.off('agentAdded', onAdded);
      store.off('agentRemoved', onRemoved);
      store.off('broadcast', onBroadcast);
    };
  }

  dispose(): void {
    this.detach();
  }

  // ── The wire ──────────────────────────────────────────────

  statusMessage(): TutorialStatus {
    const where = this.deps.surface?.where();
    const reason = this.unavailableReason(where);
    const run = this.progress;
    return {
      type: 'tutorialStatus',
      available: reason === null,
      ...(reason !== null ? { unavailableReason: reason } : {}),
      headline: tutorialHeadline(),
      disclosure: tutorialDisclosure(where?.ok ? where.directoryName : null),
      ...(run
        ? {
            run: {
              agentId: run.agentId,
              quests: run.quests.map((q) => ({ ...q })),
              finished: isTutorialFinished(run),
            },
          }
        : {}),
    };
  }

  /** Every office hears the new state (consent changed, a quest moved…). */
  broadcastStatus(): void {
    this.deps.store.broadcast({ ...this.statusMessage() });
  }

  /** Answer an office's tutorial message; false when it isn't one. */
  handleMessage(msg: Record<string, unknown>, reply: (message: ServerMessage) => void): boolean {
    switch (msg.type) {
      case 'startTutorial': {
        const palette =
          typeof msg.palette === 'number' && Number.isInteger(msg.palette) && msg.palette >= 0
            ? msg.palette
            : undefined;
        const seatId = typeof msg.seatId === 'string' && msg.seatId ? msg.seatId : undefined;
        void this.start(palette, seatId).then((outcome) => {
          if (!outcome.ok) reply({ type: 'tutorialRejected', reason: outcome.reason });
        });
        return true;
      }
      case 'skipTutorialQuest':
        if (typeof msg.questId === 'string') {
          this.apply({ kind: 'questSkipped', questId: msg.questId });
        }
        return true;
      case 'quitTutorial':
        this.quit();
        return true;
      default:
        return false;
    }
  }

  /** An office saved the layout: its quest may be done. */
  layoutSavedByOffice(): void {
    this.look();
  }

  // ── Start / quit ──────────────────────────────────────────

  async start(
    palette: number | undefined,
    seatId?: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.progress) {
      return {
        ok: false,
        reason: `The tutorial is already running (agent ${this.progress.agentId}).`,
      };
    }
    if (this.starting) return { ok: false, reason: 'The tutorial is already starting.' };
    const surface = this.deps.surface;
    const reason = this.unavailableReason(surface?.where());
    if (reason !== null || !surface) return { ok: false, reason: reason ?? 'Unavailable.' };
    this.starting = true;
    let outcome: AgentLaunchOutcome;
    // The run starts from the office as it is when the user said yes.
    const baseline = this.deps.readFacts();
    const name = this.deps.guideName(palette);
    try {
      outcome = await surface.launch(
        {
          palette,
          seatId,
          firstMessage: tutorialFirstMessage(this.deps.skills),
          nickname: TUTORIAL_NICKNAME,
          preapprovedTools: TUTORIAL_PREAPPROVED_TOOLS,
          pluginDir: this.deps.writePlugin(name),
        },
        this.deps.mcp,
      );
    } catch (err) {
      outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      this.starting = false;
    }
    if (!outcome.ok) return { ok: false, reason: `${name} couldn't start: ${outcome.reason}` };
    if (!this.deps.store.has(outcome.id)) {
      return { ok: false, reason: `${name}'s session ended as it started.` };
    }
    this.baseline = baseline;
    this.name = name;
    this.apply({ kind: 'started', agentId: outcome.id });
    this.look();
    return { ok: true };
  }

  /** The user quit: the run ends and the Guide's session with it. */
  quit(): void {
    const run = this.progress;
    if (!run) return;
    this.apply({ kind: 'ended' });
    if (this.deps.store.has(run.agentId)) this.deps.surface?.close(run.agentId);
  }

  // ── The tool (tutorial) ───────────────────────────────────

  view(caller: number, opts: { brief?: boolean } = {}): TutorialView {
    // The Guide asks every turn: a change the server heard no event for still counts.
    if (this.progress?.agentId === caller) this.look();
    const run = this.progress;
    if (!run) {
      return {
        running: false,
        note: 'No tutorial is running. The user starts one from the Intro or Settings → Play the tutorial.',
      };
    }
    const you = run.agentId === caller;
    const skillName = tutorialSkillName(this.deps.skills);
    return {
      running: true,
      agentId: run.agentId,
      you,
      ...(you && skillName ? { skill: skillName } : {}),
      ...(you && opts.brief ? { brief: tutorialBrief(this.name) } : {}),
      finished: isTutorialFinished(run),
      quests: run.quests.map(({ id, state }) => {
        const quest = tutorialQuest(id);
        return {
          id,
          title: quest?.title ?? id,
          goal: quest?.goal ?? '',
          state,
          forGuide: quest?.forGuide ?? '',
        };
      }),
    };
  }

  /** The Guide skips a quest the user asked it to skip (as the checklist's Skip). */
  skip(caller: number, questId: string): TutorialSkipOutcome {
    const run = this.progress;
    if (!run) return { ok: false, reason: 'No tutorial is running.' };
    if (run.agentId !== caller) {
      return {
        ok: false,
        reason: `Only the tutorial's Guide (agent ${run.agentId}) skips its quests; the user can skip in the checklist.`,
      };
    }
    const quest = run.quests.find((q) => q.id === questId);
    if (!quest) {
      return {
        ok: false,
        reason: `There is no quest ${questId}: the quests are ${run.quests.map((q) => q.id).join(', ')}.`,
      };
    }
    if (quest.state !== 'open')
      return { ok: false, reason: `${questId} is already ${quest.state}.` };
    this.apply({ kind: 'questSkipped', questId });
    return { ok: true, view: this.view(caller) };
  }

  // ── Internals ─────────────────────────────────────────────

  private unavailableReason(
    where: ReturnType<TutorialSurface['where']> | undefined,
  ): string | null {
    if (!this.deps.surface || !where) return "This office can't launch the tutorial's Guide.";
    const noMcp = this.deps.mcpUnavailable();
    if (noMcp !== null) return noMcp;
    if (!this.deps.mcpGranted()) {
      return 'The tutorial runs on the Pixel Agents Office MCP: turn it on in Settings first.';
    }
    if (!where.ok) return where.reason;
    return null;
  }

  /** A broadcast the offer or the quests may hang on. */
  private heard(message: Record<string, unknown>): void {
    if (!this.progress || !this.baseline) return;
    if (message.type === 'layoutLoaded') {
      // An agent's edit or an undo moved the layout: not the user's change.
      this.baseline = { ...this.baseline, layout: this.deps.readFacts().layout };
    } else if (message.type === 'characterProfilesLoaded' || message.type === 'directoriesLoaded') {
      this.look();
    }
  }

  /** Check the office's facts against the run's start: each quest seen done. */
  private look(): void {
    if (!this.progress || !this.baseline) return;
    const seen = questsSeen(this.baseline, this.deps.readFacts(), this.progress.agentId);
    for (const questId of seen) this.apply({ kind: 'questDone', questId });
  }

  private apply(event: TutorialProgressEvent): void {
    const next = reduceTutorialProgress(this.progress, event);
    if (next === this.progress) return;
    this.progress = next;
    this.broadcastStatus();
  }
}
