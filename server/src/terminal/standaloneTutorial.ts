/**
 * The tutorial on the standalone surface: the Guide is launched like any drawer
 * launch (launchIntoDirectory) into the start Directory, with the Pixel Office
 * MCP, the greeter's look, its first message and Claude Code's default
 * permission mode whatever the office's skip-permissions setting (the
 * tutorial's ask promises Claude Code still asks), and ended as its card's ×.
 */

import type { TutorialSurface } from '../tutorial/tutorial.js';
import { TUTORIAL_MODEL, TUTORIAL_PERMISSION_MODE } from '../tutorial/tutorialCopy.js';
import {
  launchIntoDirectory,
  type StandaloneLaunchDeps,
  terminalUnavailableReason,
} from './standaloneLaunches.js';

export function standaloneTutorialSurface(
  deps: Omit<StandaloneLaunchDeps, 'mcp'>,
  close: (id: number) => void,
): TutorialSurface {
  const directory = (): StandaloneLaunchDeps['hostDirectories'][number] | undefined =>
    deps.hostDirectories[0];
  return {
    where() {
      const unavailable = terminalUnavailableReason(deps.ptyManager);
      if (unavailable) return { ok: false, reason: unavailable };
      return { ok: true, directoryName: directory()?.name ?? null };
    },
    launch: (request, mcp) =>
      launchIntoDirectory(
        { ...deps, mcp },
        {
          directoryPath: directory()?.path,
          palette: request.palette,
          asks: {
            nickname: request.nickname,
            firstMessage: request.firstMessage,
            permissionMode: TUTORIAL_PERMISSION_MODE,
            model: TUTORIAL_MODEL,
            seatId: request.seatId,
          },
          preapprovedMcpTools: request.preapprovedTools,
          pluginDir: request.pluginDir,
        },
      ),
    close,
  };
}
