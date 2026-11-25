# Fork notes

This is a personal fork of [pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents), used to start and manage Claude Code sessions across repos with my own skills.

## Remotes

- `origin` is this fork.
- `upstream` is pixel-agents-hq/pixel-agents.

## Branches

- `main` mirrors `upstream/main`. Never commit to it directly.
- Personal changes live on their own branches and merge `main` in after each sync.

## Tooling: Bun instead of npm

- `bun install`, `bun run build`, `bun run test`.
- `bun.lock` replaces `package-lock.json`.
- `package.json` scripts, `.husky/` hooks, and `.vscode/tasks.json` call `bun`.
- `.github/workflows/` still use npm. They only matter upstream (publishing), and Actions are off on this fork.
- `npm pack` in `scripts/verify-npm-package.mjs` and the package-contract test stays, since it checks the npm artifact.
- `CLAUDE.md`, `README.md`, and `CONTRIBUTING.md` still say `npm`. They are left as upstream wrote them to avoid sync conflicts. Read `npm run X` as `bun run X`.
- Bun blocks four dev-only `@hyperjump/*` postinstalls that just delete a stale `dist`. The build passes without them.

Verified on 2026-11-25. Build passes. 1054 of 1055 tests pass. The failure, `server/__tests__/hookEventHandler.test.ts` "prunes expired buffered events", waits a real 7s and times out under full-suite load. It passes when run alone. The server starts and enables its terminal under both `node dist/cli.js` and `bun dist/cli.js`. A real agent session under the Bun runtime is not yet tested, so run the server with Node until it is.

## Pre-commit secret scan

`.husky/pre-commit` requires `gitleaks` and blocks commits without it. It lives in this clone at `.tools/bin/gitleaks`, excluded from git via `.git/info/exclude`. Husky puts `node_modules/.bin` on `PATH`, so it is linked there. A fresh `node_modules` loses the link. Restore it with:

```
ln -sf ../../.tools/bin/gitleaks node_modules/.bin/gitleaks
```

## Syncing with upstream

```
git fetch upstream
git checkout main && git merge --ff-only upstream/main
git checkout <branch> && git merge main
```

Merge rather than rebase, so resolved conflicts are not replayed. `rerere` is enabled in this clone to reuse resolutions.

Expected conflicts on each sync:

1. `package.json` scripts, where upstream edits a line I changed from `npm` to `bun`.
2. The lockfile. Upstream keeps updating `package-lock.json`. Resolve with `git rm package-lock.json && bun install`, then commit `bun.lock`.

To keep syncs cheap, put new behavior in new files and keep edits to upstream files small.

## Running it

- `node dist/cli.js` starts the server on `127.0.0.1`. The printed `?token=` URL grants full control, so treat it as a password.
- Agents are launched as `claude --session-id <id>` with the inherited environment, so `~/.claude` skills, plugins, and `CLAUDE.md` load as usual.
- The server must stay running. Planned: a systemd user service, with `PATH` set so it finds `claude` and Node.
- `--pty-host` (marked development-only) keeps agent terminals alive across server restarts.

## Security notes

- First run asks before adding hooks to `~/.claude/settings.json`. It backs the file up first.
- Hooks post full event payloads, including tool inputs, to the local server only.
- Leave Settings → Skip Permissions off. It adds `--dangerously-skip-permissions` to every launched agent.
