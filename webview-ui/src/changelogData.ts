interface ChangelogSection {
  title: string;
  items: string[];
}

interface ChangelogContributor {
  name: string;
  url: string;
  description: string;
}

interface ChangelogEntry {
  version: string;
  sections: ChangelogSection[];
  contributors: ChangelogContributor[];
}

/** Extract "major.minor" from a semver string (e.g. "1.1.1" → "1.1") */
export function toMajorMinor(version: string): string {
  const parts = version.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : version;
}

export const CHANGELOG_REPO_URL = 'https://github.com/pixel-agents-hq/pixel-agents';

export const DISCORD_INVITE_URL = 'https://discord.gg/Yk7jXebv9H';

export const changelogEntries: ChangelogEntry[] = [
  {
    version: '1.4',
    sections: [
      {
        title: 'Features',
        items: [
          'Claude Code Agent Teams visualization with lead badges, role labels, and coordinated lifecycle',
          'Claude Code 2.1.220 support: named spawns become seated teammates, unnamed spawns stay watched sub-agents',
          'Context gauge on every agent, sized to the model its session runs',
          'Animated pets with saved placement, petting interactions, and external pet packs',
          'Auto-tiling carpets with color controls, painting tools, undo, and persistence',
          'Workspace Areas that map folders to office zones and guide agent seating',
          'Optional settings to show the panel and spawn an agent automatically at startup',
        ],
      },
      {
        title: 'Standalone and Architecture',
        items: [
          'Run the browser office with npx pixel-agents',
          'Layered architecture with a shared runtime, provider contracts, and transport adapters',
          'Multi-server hook fan-out lets VS Code and standalone run together',
          'Published AsyncAPI WebSocket contract with generated TypeScript bindings',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'Preserve agent tracking across terminal moves and align teammate lifecycle behavior',
          'Honor explicit standalone ports and restore browser-mock hot reload',
          'Improve Areas seating for custom-named folders and polish editor layouts',
          'Fix duplicate agent adoption on Windows and a /clear session reassignment race',
          'Render restored agents reliably, in VS Code and on standalone reconnect',
          'Surface hook install failures instead of logging false success',
          'Fix the Windows build for paths with spaces and keep JSONL discovery active with hooks',
        ],
      },
      {
        title: 'Testing and Release Infrastructure',
        items: [
          'Comprehensive narrated Playwright e2e coverage for VS Code and standalone',
          'Verified npm packaging and provenance-ready publishing pipeline',
        ],
      },
    ],
    contributors: [
      {
        name: '@itsManeka',
        url: 'https://github.com/itsManeka',
        description: 'Animated pet system, bundled pet sprites, and pet interactions',
      },
      {
        name: '@NNTin',
        url: 'https://github.com/NNTin',
        description: 'Carpet system and foundational Playwright e2e infrastructure',
      },
      {
        name: '@balgaly',
        url: 'https://github.com/balgaly',
        description: 'Automatic panel display and agent startup settings',
      },
      {
        name: '@elietwd',
        url: 'https://github.com/elietwd',
        description: 'Cross-platform Windows build script and server test isolation',
      },
      {
        name: '@snvtac',
        url: 'https://github.com/snvtac',
        description: 'Workspace JSONL discovery with hooks enabled',
      },
      {
        name: '@bezzborodth-tech',
        url: 'https://github.com/bezzborodth-tech',
        description: 'Standalone rendering fix for agents that already exist on connect',
      },
      {
        name: '@Ralphive',
        url: 'https://github.com/Ralphive',
        description: 'Restored-agent rendering fix',
      },
      {
        name: '@srasantos',
        url: 'https://github.com/srasantos',
        description: 'Reported the hook-install and restored-agent rendering bugs',
      },
      {
        name: '@ErickGross-19',
        url: 'https://github.com/ErickGross-19',
        description: 'Early Agent Teams implementation that informed the shipped design',
      },
      {
        name: '@ZenidX',
        url: 'https://github.com/ZenidX',
        description: 'Early Agent Teams implementation that informed the shipped design',
      },
      {
        name: '@pablodelucca',
        url: 'https://github.com/pablodelucca',
        description:
          'Claude 2.1.220 sub-agents and teammates, context gauge, Workspace Areas, layout-editor polish, narrated e2e review',
      },
      {
        name: '@florintimbuc',
        url: 'https://github.com/florintimbuc',
        description:
          'Architecture, Agent Teams, standalone, multi-server, file-watcher and CI hardening, e2e, and release work',
      },
    ],
  },
  {
    version: '1.3',
    sections: [
      {
        title: 'Features',
        items: [
          'Hooks-first session management with dual-mode architecture (hooks + heuristic fallback)',
          'Claude Code hooks for instant agent status detection',
          'External session support and Agent tool recognition',
          'Multi-root workspace agent detection across all workspace folders',
          'Load custom characters from external asset directories',
          'Tailwind CSS v4 migration for the webview UI',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'Prevent duplicate restores, fix tool status reconnect, improve agent tool detection',
        ],
      },
      {
        title: 'Maintenance',
        items: [
          'Add shared/ to lint, format, and lint-staged',
          'Dependabot dev-dependency group bumps',
        ],
      },
    ],
    contributors: [
      {
        name: '@drewf',
        url: 'https://github.com/drewf',
        description: 'External session support and Agent tool recognition',
      },
      {
        name: '@Commandershadow9',
        url: 'https://github.com/Commandershadow9',
        description: 'Multi-root workspace agent detection',
      },
      {
        name: '@mitre88',
        url: 'https://github.com/mitre88',
        description: 'Duplicate restore, tool status reconnect, tool detection fixes',
      },
      {
        name: '@noam971',
        url: 'https://github.com/noam971',
        description: 'Duplicate restore, tool status reconnect, tool detection fixes',
      },
      {
        name: '@itsManeka',
        url: 'https://github.com/itsManeka',
        description: 'Custom characters from external asset directories',
      },
      {
        name: '@pablodelucca',
        url: 'https://github.com/pablodelucca',
        description: 'Claude Code hooks integration, Tailwind v4 migration',
      },
      {
        name: '@NNTin',
        url: 'https://github.com/NNTin',
        description: 'Claude Code hooks integration, Tailwind v4 migration',
      },
      {
        name: '@florintimbuc',
        url: 'https://github.com/florintimbuc',
        description: 'Hooks-first dual-mode architecture, review coordination',
      },
    ],
  },
  {
    version: '1.2',
    sections: [
      {
        title: 'Features',
        items: [
          'Bypass permissions mode — right-click "+ Agent" to skip tool approvals',
          'External asset packs — load furniture from user-defined directories',
          'Improved seating, sub-agent spawning, and background agent support',
          'Always show overlay setting for agent labels',
          'Agent connection diagnostics and JSONL parser resilience',
          'Browser preview mode for development and review',
        ],
      },
      {
        title: 'Fixes',
        items: ['Agents not appearing on Linux Mint/macOS when no folder is open'],
      },
      {
        title: 'Testing',
        items: ['Playwright e2e tests with mock Claude CLI'],
      },
      {
        title: 'Maintenance',
        items: [
          'Bump Vite 8.0, ESLint 10, and various dependency updates',
          'CI improvements for Dependabot and badge updates',
        ],
      },
    ],
    contributors: [
      {
        name: '@marctebo',
        url: 'https://github.com/marctebo',
        description: 'External asset packs support',
      },
      {
        name: '@dankadr',
        url: 'https://github.com/dankadr',
        description: 'Bypass permissions mode',
      },
      {
        name: '@d4rkd0s',
        url: 'https://github.com/d4rkd0s',
        description: 'Linux/macOS fix for no-folder workspaces',
      },
      {
        name: '@daniel-dallimore',
        url: 'https://github.com/daniel-dallimore',
        description: 'Always show overlay setting',
      },
      {
        name: '@NNTin',
        url: 'https://github.com/NNTin',
        description: 'Playwright e2e tests, browser preview mode',
      },
      {
        name: '@florintimbuc',
        url: 'https://github.com/florintimbuc',
        description: 'Agent diagnostics, JSONL resilience, CI improvements',
      },
    ],
  },
];
