# core/ - protocol + integration contracts

Score 14 (20 files, `src/index.ts` barrel, ~14 consumers of `HookProvider`, own codegen source). Every other layer imports from here; a change here moves the wire or the provider boundary.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add/change a wire message | `asyncapi.yaml` | then `npm run asyncapi:generate`; never touch `src/messages.ts` |
| Validate the contract | `npm run asyncapi:validate` | `@asyncapi/parser`, not `@asyncapi/cli` (advisories) |
| Provider boundary | `src/provider.ts` | `HookProvider`, `AgentEvent` kinds |
| Team queries | `src/teamProvider.ts` | optional extension on a provider |
| Persistence seam | `src/adapter.ts` | `StateAdapter`, `AssetCache`, `PersistedAgent`, `AgentSeat` |
| Terminal data-plane framing | `src/terminalFrames.ts` | shared client-frame parse / server-frame encode |
| Asset decode/build | `src/assets/` | `pngDecoder`, `loader`, `manifestUtils`, `build` |
| Shared shapes | `src/schemas.ts` | `OfficeLayout`, `PlacedFurniture`, `SpriteData`, `ColorValue` |

## CONVENTIONS
- `src/index.ts` says "types-only" - true for the barrel, NOT for the package: `src/assets/` is runtime code (PNG decoding) consumed by `server/src/assetLoader.ts`, `webview-ui/vite.config.ts` and `webview-ui/src/browserMock.ts`. Keep it side-effect free and Node+browser safe (no `fs`, no DOM).
- Barrel separates `export type` from runtime constants; consumers may import leaf modules directly.
- AsyncAPI pinned at 3.0.0 (Modelina limit). Every concrete message: `additionalProperties: false`, unions `oneOf` + `discriminator: type`.
- Reusable object shapes must be NAMED schemas: `scripts/generate-messages.ts` warns when an `AnonymousSchema_*` interface survives filtering.
- Wire vocabulary follows `CONTEXT.md` (ADR `docs/adr/0002`): `directories`/`Directory`, never `workspaceFolders`/`folderPath`.

## ANTI-PATTERNS
- Hand-editing `src/messages.ts` - CI and `.husky/pre-push` run generate + `git diff --exit-code`.
- Importing `server/`, `adapters/` or `webview-ui/` from here.
- Putting PTY bytes (`output`/`input`/`resize`/`exit`/`replay`) in `asyncapi.yaml`: AsyncAPI is the control plane only (`terminalAvailability`, `terminalSessionOpened/Closed`); bytes ride `/terminal/:agentId` (`docs/design/standalone-terminal.md`).
- Claude-specific names or tool semantics in `provider.ts`; they belong in `server/src/providers/hook/claude/`.
- Adding a message without deciding its privilege: the server refuses every non-`webviewReady` message from unprivileged clients by default - keep it that way.

## NOTES
- `core/asyncapi.yaml` is NOT in the npm tarball despite CLAUDE.md: `scripts/npm-package-contract.mjs` forbids the `core/` prefix.
