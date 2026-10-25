type RelayEvent = Record<string, unknown>;
type Tool = { id: string; name: string };
type Session = {
  actor: string;
  cwd: string;
  name: string;
  isSubagent: boolean;
  working: boolean;
  tools: Map<string, Tool>;
  changed: number;
};
type Actor = { selectedTool?: Tool; delivery: Promise<void> };

const READING_TOOLS = new Set([
  'read',
  'web_fetch',
  'web__run',
  'browser',
  'memory_search',
  'memory_get',
]);
export function isReadingActivity(name: string): boolean {
  return (
    READING_TOOLS.has(name.toLowerCase()) ||
    /(?:^|_)(?:search|read|fetch|browse)(?:_|$)/i.test(name)
  );
}

/** Collapse private session state into one content-free character per Gateway agent. */
export class SessionActivityAggregator {
  private sessions = new Map<string, Session>();
  private actors = new Map<string, Actor>();
  private sequence = 0;

  constructor(private send: (event: RelayEvent) => Promise<void>) {}

  async accept(event: RelayEvent): Promise<void> {
    const sid = event.session_id;
    if (typeof sid !== 'string') return;
    let session = this.sessions.get(sid);
    if (event.event === 'session_start') {
      if (!session) {
        session = {
          actor: typeof event.actor_id === 'string' ? event.actor_id : sid,
          cwd: typeof event.cwd === 'string' ? event.cwd : '',
          name: typeof event.display_name === 'string' ? event.display_name : '',
          isSubagent: event.is_subagent === true,
          working: true,
          tools: new Map(),
          changed: 0,
        };
        this.sessions.set(sid, session);
      } else {
        session.working = true;
        if (typeof event.display_name === 'string') session.name = event.display_name;
        if (typeof event.cwd === 'string') session.cwd = event.cwd;
        if (typeof event.is_subagent === 'boolean') session.isSubagent = event.is_subagent;
      }
    }
    if (!session) return;
    // Model calls may finish with a tool request. A completion fallback must
    // never cancel a tool that has already started in this session.
    if (event.event === 'model_idle' && session.tools.size > 0) return;
    session.changed = ++this.sequence;
    if (
      event.event === 'tool_start' &&
      typeof event.tool_id === 'string' &&
      typeof event.tool_name === 'string'
    ) {
      session.working = false;
      session.tools.set(event.tool_id, { id: event.tool_id, name: event.tool_name });
    } else if (event.event === 'tool_end' && typeof event.tool_id === 'string') {
      if (!session.tools.has(event.tool_id)) return;
      session.tools.delete(event.tool_id);
      session.working = session.tools.size === 0;
    } else if (event.event === 'turn_end' || event.event === 'model_idle') {
      session.working = false;
      session.tools.clear();
    } else if (event.event === 'session_end') {
      this.sessions.delete(sid);
    }

    const actorId = session.actor;
    let actor = this.actors.get(actorId);
    if (!actor) {
      actor = { delivery: Promise.resolve() };
      this.actors.set(actorId, actor);
    }
    const candidates = [...this.sessions.values()].filter((s) => s.actor === actorId);
    const rank = (s: Session): number =>
      s.working
        ? 3
        : s.tools.size
          ? [...s.tools.values()].some((t) => !isReadingActivity(t.name))
            ? 2
            : 1
          : 0;
    candidates.sort((a, b) => rank(b) - rank(a) || b.changed - a.changed);
    const winner = candidates[0];
    const events: RelayEvent[] = [];
    if (actor.selectedTool)
      events.push({ event: 'tool_end', session_id: actorId, tool_id: actor.selectedTool.id });
    actor.selectedTool = undefined;
    if (!winner) {
      events.push({ event: 'session_end', session_id: actorId, reason: 'all_sessions_ended' });
    } else {
      // Reannounce on activity so a restarted office can rebuild its roster.
      events.push({
        event: 'session_start',
        session_id: actorId,
        source: 'openclaw',
        cwd: winner.cwd,
        display_name: winner.name,
        is_subagent: winner.isSubagent,
      });
      if (rank(winner) === 0) events.push({ event: 'turn_end', session_id: actorId });
      else if (!winner.working) {
        const tools = [...winner.tools.values()];
        const tool = tools.reverse().find((t) => !isReadingActivity(t.name)) ?? tools[0];
        actor.selectedTool = tool;
        events.push({
          event: 'tool_start',
          session_id: actorId,
          tool_id: tool.id,
          tool_name: tool.name,
        });
      }
    }
    // Snapshot and serialize each actor's projection: slower HTTP completion
    // from one session must never overwrite a newer session's winning state.
    const pending = actor.delivery
      .catch(() => {})
      .then(async () => {
        for (const item of events) await this.send(item);
      });
    actor.delivery = pending;
    await pending;
    if (
      !winner &&
      this.actors.get(actorId) === actor &&
      ![...this.sessions.values()].some((s) => s.actor === actorId)
    )
      this.actors.delete(actorId);
  }

  async stop(): Promise<void> {
    const entries = [...this.actors];
    this.sessions.clear();
    this.actors.clear();
    await Promise.all(
      entries.map(async ([id, actor]) => {
        await actor.delivery.catch(() => {});
        await this.send({ event: 'session_end', session_id: id, reason: 'gateway_stop' });
      }),
    );
  }
}
