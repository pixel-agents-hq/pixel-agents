/**
 * The tutorial on the standalone surface: the Guide is launched like any drawer
 * launch (launchIntoDirectory) into the start Directory, with the Pixel Office
 * MCP, the greeter's look and its first message, in the provider's auto
 * permission mode (else the CLI's default one), never with prompts skipped
 * whatever the office's skip-permissions setting (the tutorial's ask promises
 * the CLI still asks before anything risky), on the provider's most capable
 * model, and ended as its card's ×.
 */

import { directoryAt } from '../directories.js';
import type { TutorialSurface } from '../tutorial/tutorial.js';
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
      // Named as the office lists it: the user's own name for that folder wins.
      const start = directory();
      const listed = start && directoryAt(start.path, deps.hostDirectories);
      return { ok: true, directoryName: listed?.name ?? start?.name ?? null };
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
            // Safe actions go through, risky ones still ask (the ask says so),
            // on the CLI's most capable model, whatever the user's defaults.
            permissionMode: deps.provider.autoPermissionMode,
            neverSkipPermissions: true,
            model: deps.provider.mostCapableModel,
            seatId: request.seatId,
          },
          preapprovedMcpTools: request.preapprovedTools,
          pluginDir: request.pluginDir,
        },
      ),
    close,
  };
}
