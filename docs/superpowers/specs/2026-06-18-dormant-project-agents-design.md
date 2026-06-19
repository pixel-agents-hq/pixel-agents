# Dormant Project Agents

**Date:** 2026-06-18  
**Status:** Approved  
**Author:** Fabian (fdiaz)

---

## Summary

Show all Claude Code projects from `~/.claude/projects/` as dormant (sleeping/offline) characters in the Pixel Agents office, even when no Claude terminal is running for them. Each dormant character can have skills assigned to it via a click-to-configure modal. When a project goes active (a real Claude session starts), the dormant character is replaced by the live agent character.

---

## Goals

1. All Claude projects in `~/.claude/projects/` auto-appear as dormant characters at startup.
2. Dormant characters are visually distinct (dim, desaturated, slow breathing animation).
3. Each project can have skills assigned from the UI and stored in `~/.pixel-agents/config.json`.
4. Projects can be individually hidden from the office.
5. When a dormant project goes active, transition is seamless (matrix despawn → active spawn).

---

## Non-Goals

- Clicking a dormant character does NOT launch a Claude terminal (use existing + Agent button).
- Skills assignment does NOT auto-configure CLAUDE.md or launch args (metadata only, for now).
- No limit on active agents — dormant characters are capped at 20 (most recently active first).

---

## Architecture

### 1. Project Discovery (`server/src/dormantProjectScanner.ts` — new file)

The `DormantProject` interface lives in `server/src/types.ts` (shared with webview via messages):

```ts
interface DormantProject {
  projectDir: string; // ~/.claude/projects/-Users-fdiaz-projects-telepatia
  workspacePath: string; // /Users/fdiaz/projects/telepatia (real or best-effort)
  displayName: string; // "telepatia" (last segment of workspacePath)
  skills: string[]; // assigned skill names
  hidden: boolean;
  lastSeenAt?: number; // mtime of most recent JSONL in projectDir
}
```

**Scan logic** (`scanDormantProjects(configuredProjects: DormantProject[]): DormantProject[]`):

1. Read `~/.claude/projects/` with `fs.readdir`.
2. For each subdir, find the most recently modified `.jsonl` file.
3. Read up to 8 KB of that file; look for a `SessionStart` record with `cwd` field. Use it as `workspacePath` if found.
4. Fallback: decode dirname by replacing `-` with `/` and prepending `/` → best-effort path. Extract last segment as `displayName`.
5. Set `lastSeenAt` = mtime of the most recent JSONL.
6. Merge with existing `configuredProjects`: preserve `skills` and `hidden` for known dirs; prune entries whose `projectDir` no longer exists on disk; add new dirs with defaults (`skills: []`, `hidden: false`).
7. Sort by `lastSeenAt` descending; cap at 20 entries.
8. Return merged list — caller writes it back to config.

**Filesystem watch:** `fs.watch('~/.claude/projects/')` triggers a re-scan when new project subdirs appear. Debounced 500 ms.

### 2. Config persistence (extends `server/src/configPersistence.ts`)

Add `dormantProjects: DormantProject[]` to the existing config shape in `~/.pixel-agents/config.json`. Read/write follows the existing atomic `tmp + rename` pattern already used for `externalAssetDirectories`.

### 3. Extension integration (`adapters/vscode/PixelAgentsViewProvider.ts`)

On `webviewReady` (after `layoutLoaded` is sent):

```
scanDormantProjects(config.dormantProjects)
  → save merged list back to config
  → filter: hidden:false AND projectDir not in active AgentState set
  → postMessage { type: 'dormantProjectsLoaded', projects: DormantProject[] }
```

On `AgentCreated` for a project: re-filter and re-send `dormantProjectsLoaded` (removes the now-active project).  
On `AgentClosed` for a project: re-scan and re-send `dormantProjectsLoaded` (adds it back as dormant).  
On new message `updateDormantProject { projectDir, skills?, hidden? }` from webview: update config, re-send.

### 4. Webview — `DormantCharacter` entity (`webview-ui/src/office/engine/officeState.ts`)

```ts
interface DormantCharacter {
  projectDir: string;
  displayName: string;
  workspacePath: string;
  skills: string[];
  palette: number; // deterministic: hash(projectDir) % 6, stable across restarts
  hueShift: number; // 0 for first 6 projects; 45–315 for repeats (same as active agents)
  seatId: string | null;
  frame: number;
  frameTimer: number; // for slow breathing animation
}
```

`DormantCharacter` objects live in a separate `Map<string, DormantCharacter>` (keyed by `projectDir`), **not** in the `Character` map. The game loop does not move them or apply active-agent logic.

### 5. Rendering (`webview-ui/src/office/engine/renderer.ts`)

Dormant characters render in the same Z-sorted pass as active characters. Before drawing each dormant sprite:

```ts
ctx.save();
ctx.globalAlpha = 0.45;
ctx.filter = 'grayscale(80%)';
// draw sprite at seat position
ctx.restore();
```

Animation: frame cycles slowly between walk2 (standing) and walk1 with period ~3 s (driven by `frameTimer`), compared to the 150 ms walk cycle for active characters.

### 6. Hover tooltip (`webview-ui/src/office/components/ToolOverlay.tsx`)

When the hovered entity is a `DormantCharacter`, show:

```
📁 telepatia
/Users/fdiaz/projects/telepatia
Last active: 2 days ago
Skills: [brainstorming] [deep-research]
[Configure]
```

"Configure" opens `ProjectModal`.

### 7. `ProjectModal.tsx` (new component)

Same pixel aesthetic as `SettingsModal`. Contents:

- **Header:** `displayName` + full `workspacePath`
- **Last active:** human-readable relative time from `lastSeenAt`
- **Skills section:** chips for each skill. `[×]` removes. `[+ Add skill…]` input with autocomplete from `~/.claude/skills/` and `~/.claude/plugins/*/skills/`
- **Footer:** `[Hide from office]` button + `[Close]`

On any change, webview sends `updateDormantProject` to extension; extension saves config and re-sends `dormantProjectsLoaded`.

Skills autocomplete source: new message `availableSkills` sent by extension on startup — it scans `~/.claude/skills/` and `~/.claude/plugins/` for skill directories.

### 8. Settings modal — "Projects" section (extends `SettingsModal.tsx`)

New collapsible section "Offline Projects" lists hidden projects with a `[Show]` button to restore them.

---

## Data Flow Diagram

```
Extension startup
  scanDormantProjects()
  ├─ reads ~/.claude/projects/
  ├─ extracts cwd from JSONL (or decodes dirname)
  ├─ merges with ~/.pixel-agents/config.json
  └─ postMessage dormantProjectsLoaded → webview
       └─ officeState.setDormantProjects()
            └─ renderer draws dim characters at seats

AgentCreated (projectDir X)
  extension re-filters dormant list (removes X)
  postMessage dormantProjectsLoaded (without X)
  webview removes DormantCharacter X (no animation)
  webview matrix-spawns Character X

AgentClosed (projectDir X)
  extension re-scans, re-merges
  postMessage dormantProjectsLoaded (with X back)
  webview adds DormantCharacter X (no animation — appears instantly)

User clicks Configure on dormant character
  webview opens ProjectModal
  user edits skills / hides project
  webview sends updateDormantProject
  extension saves config
  extension re-sends dormantProjectsLoaded
  webview updates DormantCharacter in place
```

---

## Error Handling

| Scenario                                | Behavior                                                |
| --------------------------------------- | ------------------------------------------------------- |
| `~/.claude/projects/` doesn't exist     | Skip scan, no dormant chars, no error                   |
| JSONL is corrupt / no SessionStart      | Use dirname decode for workspacePath                    |
| Workspace path no longer exists on disk | Show dormant character anyway                           |
| Two projects with same displayName      | Show full workspacePath in tooltip                      |
| >20 projects discovered                 | Cap at 20 most recent; extras ignored silently (logged) |
| Skill autocomplete scan fails           | Input still works; just no autocomplete suggestions     |

---

## Files Changed

| File                                               | Change                                                        |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `server/src/dormantProjectScanner.ts`              | **New** — scan + merge logic                                  |
| `server/src/configPersistence.ts`                  | Add `dormantProjects` field to config shape                   |
| `adapters/vscode/PixelAgentsViewProvider.ts`       | Call scanner on ready, handle `updateDormantProject` messages |
| `server/src/types.ts`                              | Add `DormantProject` interface                                |
| `webview-ui/src/office/engine/officeState.ts`      | Add `dormantCharacters` map + `setDormantProjects()`          |
| `webview-ui/src/office/engine/renderer.ts`         | Render dormant chars with dim/grayscale                       |
| `webview-ui/src/office/engine/characters.ts`       | Dormant breathing animation tick                              |
| `webview-ui/src/office/components/ToolOverlay.tsx` | Handle dormant char hover                                     |
| `webview-ui/src/hooks/useExtensionMessages.ts`     | Handle `dormantProjectsLoaded` message                        |
| `webview-ui/src/components/ProjectModal.tsx`       | **New** — skill assignment modal                              |
| `webview-ui/src/components/SettingsModal.tsx`      | Add "Offline Projects" section                                |
| `webview-ui/src/office/types.ts`                   | Add `DormantCharacter` interface                              |

---

## Out of Scope (Future)

- Launching Claude for a specific project by clicking the dormant character
- Skills assignment auto-injecting into CLAUDE.md or launch args
- Real-time sync across multiple VS Code windows for dormant state
