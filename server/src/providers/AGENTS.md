# server/src/providers/ - provider registry, consent, Claude integration

Score 10, distinct domain: the integration boundary. 9 files, ~2k LOC; `index.ts` registry is the module entry. Claude is the only registered provider.

## STRUCTURE
```
providers/
├── index.ts                 # claudeProvider, hookProviders (order is explicit), hookProviderById, copyHookScript
└── hook/
    ├── consentGate.ts       # POLICY: hooksConsentRequest, consentActionFor
    ├── consentExecutor.ts   # EXECUTION: applyConsentChoice, per-process serialization
    └── claude/              # everything Claude-specific
        ├── claude.ts                # normalizeHookEvent, formatToolStatus, file fallback, contextWindowForModel
        ├── claudeHookInstaller.ts   # ~750 LOC, ~/.claude/settings.json surgery
        ├── claudeTeamProvider.ts    # ~/.claude/teams/<name>/config.json
        ├── consentCopy.ts           # disclosure text (rendered verbatim by the webview)
        ├── constants.ts             # CLAUDE_HOOK_EVENTS
        └── hooks/claude-hook.ts     # bundled to dist/hooks/claude-hook.js (CJS, node18, shebang)
```

## WHERE TO LOOK
| Task | Location |
|------|----------|
| New CLI integration | new `hook/<id>/` + register in `index.ts`; zero runtime/UI changes |
| Revision semantics of consent answers | `docs/adr/0001-*.md` + `consentGate.ts` |
| Format history of Claude transcripts/sidecars/teams | `docs/research/claude-harness-spawn-formats.md` |

## CONVENTIONS
- Normalize raw payloads to `AgentEvent` here; runtime dispatches on `.kind` only.
- Capabilities (file fallback, `team`) are optional fields on `HookProvider`, not runtime branches.
- `claude-hook.ts` is spawned per hook by Claude: keep it dependency-free and fast; it is tested as a built artifact (`claude-hook.test.ts` skips when `dist/` is missing).
- Installer writes go tmp -> chmod -> re-read verify -> rename, retried on concurrent change; every failure throws.

## ANTI-PATTERNS
- Treating unknown consent choices, a missing `providerId`, or unreadable install state as consent/decline - fail closed.
- `notNow` leaving any disk trace (must equal "never answered").
- Rewriting an unparseable `settings.json` or a non-array `hooks.<Event>`; refreshing an existing `.pixel-agents.backup`.
- Identifying our hooks by anything but the anchored, case-insensitive `/.pixel-agents/hooks/claude-hook.js` first-token suffix.
- Re-adding `UserPromptSubmit`/`TaskCreated` to installed events (they normalize to null; installs migrate them away).
- Linking implicit teams by the config's `leadSessionId` (matches no transcript).
- Duplicating consent action order per host - both Adapters call `applyConsentChoice`.
