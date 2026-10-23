import { describe, expect, it } from 'vitest';

import {
  classifyTool,
  editedFileOf,
  findPrUrl,
  isPrCreateCommand,
  isPushCommand,
  isShellTool,
  isShipCommand,
  isTestCommand,
  prTitleFromCommand,
  repoFromPrUrl,
} from '../src/progress/phase.js';

/**
 * The stage track's rules (docs/progress/DESIGN.md): tool names decide EXPLORE
 * and BUILD; for shell tools the command decides TEST and SHIP. Commands are
 * skimmed, not parsed, so the negatives matter as much as the positives.
 */

const bash = (command: string) => classifyTool('Bash', { command });
const pwsh = (command: string) => classifyTool('PowerShell', { command });

describe('classifyTool', () => {
  it('maps reading tools to explore', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'LS']) {
      expect(classifyTool(tool, {})).toBe('explore');
    }
  });

  it('maps editing tools to build', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(classifyTool(tool, { file_path: '/x.ts' })).toBe('build');
    }
  });

  it('leaves other tools unclassified', () => {
    for (const tool of ['Task', 'Agent', 'TodoWrite', 'AskUserQuestion', 'mcp__x__y', '']) {
      expect(classifyTool(tool, {})).toBeNull();
    }
  });

  it('classifies shell commands as test, ship or nothing', () => {
    expect(bash('npm test')).toBe('test');
    expect(bash('git commit -m "wip"')).toBe('ship');
    expect(bash('ls -la')).toBeNull();
    expect(pwsh('npm run check-types; if ($?) { npm test }')).toBe('test');
    expect(pwsh('git push origin main')).toBe('ship');
  });

  it('prefers ship anywhere in a chain over test', () => {
    expect(bash('npm test && git commit -am "fix" && git push')).toBe('ship');
    expect(bash('git add -A; npm run build')).toBe('test');
  });

  it('treats a shell tool without a command as unclassified', () => {
    expect(classifyTool('Bash', {})).toBeNull();
    expect(classifyTool('Bash', { command: 42 })).toBeNull();
  });
});

describe('isTestCommand', () => {
  it.each([
    'npm test',
    'npm t',
    'npm run test:server',
    'npm run build',
    'npm run lint',
    'npm run check-types',
    'npm run typecheck',
    'npm test -- --run',
    'npm --prefix server test',
    'npm -w server run test',
    'pnpm test',
    'pnpm build',
    'pnpm --filter web lint',
    'yarn lint',
    'yarn workspace web build',
    'bun test',
    'npx vitest run',
    'npx -y vitest run server/__tests__/a.test.ts',
    'vitest',
    'jest --watchAll=false',
    'pytest -q',
    'python -m pytest tests/',
    'uv run pytest',
    'mocha',
    'tsc --noEmit',
    'npx tsc --noEmit -p server/tsconfig.test.json',
    './node_modules/.bin/eslint server/src',
    'npx eslint server/src server/__tests__/progress*.test.ts',
    'npx playwright test',
    'cargo test',
    'cargo build --release',
    'cargo clippy',
    'go test ./...',
    'go vet ./...',
    'dotnet test',
    'make',
    'make test',
    'mvn clean verify',
    './gradlew :app:test',
    'docker build -t app .',
    'turbo run build',
    'nx run web:test',
    'node --test scripts/x.test.mjs',
    'CI=1 npm test',
    'cd server && npx vitest run',
    'npm test 2>&1 | tail -20',
    'timeout 120 npm test',
    'bash -c "npm test"',
    "bash -lc 'cd server && npx vitest run'",
  ])('detects %s', (cmd) => {
    expect(isTestCommand(cmd)).toBe(true);
  });

  it.each([
    'cat test.txt',
    'git status',
    'ls tests/',
    'grep -rn "npm test" .',
    'echo "npm test"',
    'rm -rf build dist',
    'mkdir test',
    'cd build',
    'test -f package.json && echo ok',
    'vim test.py',
    'which vitest',
    'npm install',
    'npm ci',
    'npm run dev',
    'npm start',
    'npm view vitest version',
    'pnpm add -D vitest',
    'yarn add jest',
    'npx prettier --write .',
    'node scripts/test.js',
    'go run .',
    'cargo run',
    'docker run --rm test-image',
    'git commit -m "add tests; npm test passes"',
    'git log --grep=test',
    '',
  ])('ignores %s', (cmd) => {
    expect(isTestCommand(cmd)).toBe(false);
  });

  it('reads PowerShell commands', () => {
    expect(isTestCommand('npm run check-types; if ($?) { npm test }')).toBe(true);
    expect(isTestCommand('& "C:\\Program Files\\nodejs\\npm.cmd" test')).toBe(true);
    expect(isTestCommand('NPM TEST')).toBe(true);
    expect(isTestCommand('npx.cmd vitest run')).toBe(true);
    expect(isTestCommand('$env:CI = "1"; npm test')).toBe(true);
    expect(isTestCommand('powershell -NoProfile -Command "npm run lint"')).toBe(true);
    expect(isTestCommand('cmd /c npm run build')).toBe(true);
    expect(isTestCommand('Get-ChildItem tests')).toBe(false);
    expect(isTestCommand('Get-Content test.txt | Select-Object -First 5')).toBe(false);
  });
});

describe('isShipCommand', () => {
  it.each([
    'git commit -m "fix: thing"',
    'git commit -am wip',
    'git commit --amend --no-edit',
    'git -C repo commit -m x',
    'git push',
    'git push -u origin feature/x',
    'git push --force-with-lease',
    'gh pr create --fill',
    'gh pr create --title "x" --body "y"',
    'gh pr create --web',
    'gh pr merge 12 --squash',
    'git add -A && git commit -m "x"',
    'npm test; if ($?) { git push }',
    `git commit -m "$(cat <<'EOF'\nFix tests\n\nCo-Authored-By: x\nEOF\n)"`,
  ])('detects %s', (cmd) => {
    expect(isShipCommand(cmd)).toBe(true);
  });

  it.each([
    'git status',
    'git log --oneline -5',
    'git diff HEAD~1',
    'git add -A',
    'git stash push -m wip',
    'git push --dry-run',
    'git push -n origin main',
    'git commit --help',
    'git commit --dry-run',
    'gh pr view 12',
    'gh pr list',
    'gh pr create --dry-run',
    'gh pr create --help',
    'echo "git push"',
    'cat commit.txt',
    'grep -rn "gh pr create" .',
  ])('ignores %s', (cmd) => {
    expect(isShipCommand(cmd)).toBe(false);
  });
});

describe('isPushCommand / isPrCreateCommand', () => {
  it('recognizes pushes, alone or chained', () => {
    expect(isPushCommand('git push -u origin x')).toBe(true);
    expect(isPushCommand('git commit -m x && git push')).toBe(true);
    expect(isPushCommand('git commit -m "push it"')).toBe(false);
    expect(isPushCommand('git stash push')).toBe(false);
    expect(isPushCommand('git push --dry-run')).toBe(false);
  });

  it('recognizes PR creation, but not the browser form or a dry run', () => {
    expect(isPrCreateCommand('gh pr create --fill')).toBe(true);
    expect(isPrCreateCommand('git push -u origin x && gh pr create -t "x" -b "y"')).toBe(true);
    expect(isPrCreateCommand('gh pr create --web')).toBe(false);
    expect(isPrCreateCommand('gh pr create --dry-run')).toBe(false);
    expect(isPrCreateCommand('gh pr merge 3')).toBe(false);
    expect(isPrCreateCommand('gh pr view --web')).toBe(false);
  });
});

describe('prTitleFromCommand', () => {
  it.each([
    ['gh pr create --title "Fix the thing" --body "y"', 'Fix the thing'],
    ["gh pr create --title 'Fix the thing'", 'Fix the thing'],
    ['gh pr create --title=Fix', 'Fix'],
    ['gh pr create --title="Fix it"', 'Fix it'],
    ['gh pr create -t "Short" -b "Body"', 'Short'],
    ['gh pr create --title "Say \\"hi\\""', 'Say "hi"'],
    ['git push -u origin x && gh pr create --title "feat: strip"', 'feat: strip'],
    ['gh pr create --title "a; b && c"', 'a; b && c'],
  ])('%s -> %s', (cmd, title) => {
    expect(prTitleFromCommand(cmd)).toBe(title);
  });

  it('has no title for --fill, an empty title, or a command that is not gh pr create', () => {
    expect(prTitleFromCommand('gh pr create --fill')).toBeUndefined();
    expect(prTitleFromCommand('gh pr create --title ""')).toBeUndefined();
    expect(prTitleFromCommand('gh issue create --title "x"')).toBeUndefined();
    expect(prTitleFromCommand('echo --title "x"')).toBeUndefined();
  });

  it('has no title when the title is an unexpanded shell expansion', () => {
    // The hook sees the command before the shell expands it.
    expect(prTitleFromCommand('gh pr create --title "[auto-post] $title"')).toBeUndefined();
    expect(prTitleFromCommand('gh pr create --title "${TITLE}"')).toBeUndefined();
    expect(prTitleFromCommand('gh pr create --title "$(git log -1 --format=%s)"')).toBeUndefined();
    expect(prTitleFromCommand('gh pr create --title "`cat t.txt`"')).toBeUndefined();
    expect(prTitleFromCommand('gh pr create --title $env:PR_TITLE')).toBeUndefined();
    // A literal dollar amount is still a real title.
    expect(prTitleFromCommand('gh pr create --title "Price is $5"')).toBe('Price is $5');
  });
});

describe('PR urls', () => {
  it('finds the first GitHub PR url in text', () => {
    expect(
      findPrUrl(
        'Creating pull request...\nhttps://github.com/acme/web/pull/42\nhttps://github.com/acme/web/pull/43',
      ),
    ).toBe('https://github.com/acme/web/pull/42');
    expect(findPrUrl('{"stdout":"https://github.com/a-b/c.d_e/pull/7\\n"}')).toBe(
      'https://github.com/a-b/c.d_e/pull/7',
    );
    expect(findPrUrl('https://github.com/acme/web/issues/42')).toBeUndefined();
    expect(findPrUrl('no url here')).toBeUndefined();
    expect(findPrUrl(undefined)).toBeUndefined();
  });

  it('reads owner/repo from a PR url', () => {
    expect(repoFromPrUrl('https://github.com/acme/web/pull/42')).toBe('acme/web');
    expect(repoFromPrUrl('https://gitlab.com/acme/web/-/merge_requests/1')).toBeUndefined();
  });
});

describe('tool inputs', () => {
  it('knows the shell tools', () => {
    expect(isShellTool('Bash')).toBe(true);
    expect(isShellTool('PowerShell')).toBe(true);
    expect(isShellTool('Read')).toBe(false);
  });

  it('finds the file an editing tool writes', () => {
    expect(editedFileOf('Edit', { file_path: '/a.ts' })).toBe('/a.ts');
    expect(editedFileOf('MultiEdit', { file_path: '/b.ts', edits: [] })).toBe('/b.ts');
    expect(editedFileOf('NotebookEdit', { notebook_path: '/n.ipynb' })).toBe('/n.ipynb');
    expect(editedFileOf('Read', { file_path: '/a.ts' })).toBeUndefined();
    expect(editedFileOf('Write', {})).toBeUndefined();
  });
});
