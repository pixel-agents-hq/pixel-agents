import fs from 'fs';
import path from 'path';

import { expect, test } from '../../../fixtures/pixel-agents';
import { readAgentSeats, type TestHooksWindow } from '../../../helpers/editor';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import { getPixelAgentsFrame, openPixelAgentsPanel } from '../../../helpers/webview';

/**
 * The agent label's secondary line prefers the Claude session name over the
 * workspace folder. The name lives in Claude's per-session registry
 * (~/.claude/sessions/<pid>.json → { sessionId, name, ... }); the provider's
 * getSessionName maps sessionId → name and the runtime's periodic refresh
 * broadcasts agentSessionNameChanged so live renames (and sessions that get a
 * name after they start) surface without a reload.
 *
 * Seeding the registry file directly mirrors how team config is seeded
 * (helpers/team.ts) — it's Claude metadata, not a transcript, so the
 * append-only/scenario-driven transcript rules don't apply. The character's
 * resolved sessionName is read through the getAgentSeats test hook, the same
 * way the Areas specs read seat state (canvas-only, no DOM).
 */
test.describe('Hooks ON / labels', () => {
  test('agent label resolves to the Claude session name from the session registry @area:labels', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    // Default holdOpen (30s) keeps the mock — and thus the agent — alive well
    // past the 3s session-name refresh, so no scenario needs arranging.
    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    // Seed the session registry the provider reads. The filename is arbitrary —
    // buildSessionNameCache scans every *.json in the dir and keys by sessionId.
    const sessionName = 'stardust-session-1a';
    const sessionsDir = path.join(tmpHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, '424242.json'),
      JSON.stringify({
        pid: 424242,
        sessionId: spawned.sessionId,
        cwd: spawned.projectDir,
        name: sessionName,
        nameSource: 'user',
        status: 'active',
      }),
    );
    narrator.step(`seeded the session registry: ${spawned.sessionId} → "${sessionName}"`);

    // The spawned terminal took over the panel area — re-open the webview.
    await openPixelAgentsPanel(window);
    const fresh = await getPixelAgentsFrame(window);

    narrator.step('waiting for the periodic refresh to resolve the session name onto the agent');
    await fresh.waitForFunction(
      (expected) =>
        ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAgentSeats?.() ?? []).some(
          (a) => a.sessionName === expected,
        ),
      sessionName,
      { timeout: 20_000 },
    );

    const seats = await readAgentSeats(fresh);
    expect(seats.some((a) => a.sessionName === sessionName)).toBe(true);
    narrator.check(`the agent's label resolved to the session name "${sessionName}"`);
  });
});
