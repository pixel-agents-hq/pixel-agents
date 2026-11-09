/**
 * P3 Bash 斷詞與結構解析（純函式，F10）：複合指令、引號、跳脫、重導向、heredoc、
 * 命令替換、cd 的工作目錄傳遞。
 */

import { describe, expect, it } from 'vitest';

import { WRITE_GUARD_BASH_MAX_NESTING } from '../src/constants.js';
import { parseBash } from '../src/writeGuard/bashParser.js';

/** 每個簡單指令的 argv、重導向（種類:目標）與可能工作目錄（cd 參數以 / 串接）。 */
function summary(src: string) {
  return parseBash(src).commands.map((c) => ({
    argv: c.words.map((w) => w.text),
    redirects: c.redirects
      .filter((r) => r.kind !== 'heredoc' || r.target === undefined)
      .map((r) => (r.target ? `${r.kind}:${r.target.text}` : r.kind)),
    dirs: c.dirs.map((chain) => chain.map((w) => w.text).join('/')),
  }));
}

const argvs = (src: string) => summary(src).map((c) => c.argv);

describe('compound commands', () => {
  it('splits on ; && || | & newline and parentheses', () => {
    expect(argvs('a 1; b 2 && c || d | e & f\ng (h; i)')).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c'],
      ['d'],
      ['e'],
      ['f'],
      ['g'],
      ['h'],
      ['i'],
    ]);
  });

  it('parses $( ), backticks and process substitution recursively', () => {
    expect(argvs('echo "$(rm -f a)" `touch b` $(echo $(mv c d)) cat <(cp e f)')).toEqual([
      ['echo', '"$(rm -f a)"'.slice(1, -1), '`touch b`', '$(echo $(mv c d))', 'cat', '<(cp e f)'],
      ['rm', '-f', 'a'],
      ['touch', 'b'],
      ['echo', '$(mv c d)'],
      ['mv', 'c', 'd'],
      ['cp', 'e', 'f'],
    ]);
  });

  it('$(( )) is arithmetic, but $((cmd) ) is a command substitution with a subshell (as in bash)', () => {
    expect(argvs('echo $((1 + (2 * 3)))')).toEqual([['echo', '$((1 + (2 * 3)))']]);
    expect(argvs('echo $((rm -rf x) )').slice(1)).toEqual([['rm', '-rf', 'x']]);
    expect(argvs('echo $(( $(touch y) + 1 ))').slice(1)).toEqual([['touch', 'y']]);
  });

  it('skips keywords and loop headers but keeps their bodies', () => {
    expect(argvs('if test -f x; then rm x; fi; for f in a b; do touch "$f"; done')).toEqual([
      ['test', '-f', 'x'],
      ['rm', 'x'],
      ['touch', '$f'],
    ]);
  });

  it('drops leading assignments but still parses their substitutions', () => {
    expect(argvs('A=1 B=$(rm y) env')).toEqual([['env'], ['rm', 'y']]);
  });
});

describe('quoting and escapes', () => {
  it('removes single quotes, double quotes and backslashes', () => {
    expect(argvs(`echo 'a b' "c d" e\\ f \\r\\m "x\\"y" 'it'\\''s'`)).toEqual([
      ['echo', 'a b', 'c d', 'e f', 'rm', 'x"y', "it's"],
    ]);
  });

  it('keeps operators inside quotes literal and joins line continuations', () => {
    expect(argvs(`echo "a; rm b" 'c && d' e\\\nf`)).toEqual([['echo', 'a; rm b', 'c && d', 'ef']]);
  });

  it("decodes $'...' escapes so a literal path cannot hide behind them", () => {
    expect(argvs("echo $'\\x2enote/a' $'\\056x'")).toEqual([['echo', '.note/a', '.x']]);
  });

  it('marks tilde, expansions and comments', () => {
    const [command] = parseBash('rm ~/a $HOME/b *.md ~other/c # rm -rf /').commands;
    expect(command.words.map((w) => [w.text, w.tilde, w.expansion])).toEqual([
      ['rm', false, false],
      ['~/a', true, false],
      ['$HOME/b', false, true],
      ['*.md', false, true],
      ['~other/c', false, true],
    ]);
    expect(parseBash('rm ~/a # rm -rf /').commands).toHaveLength(1);
  });
});

describe('redirects', () => {
  it('records every redirect kind and its target', () => {
    expect(
      summary('a > w1 >> w2 >| w3 &> w4 &>>w5 2> w6 < r1 <> rw 2>&1 >&2 >& w7 1<&0').map(
        (c) => c.redirects,
      ),
    ).toEqual([
      [
        'write:w1',
        'write:w2',
        'write:w3',
        'write:w4',
        'write:w5',
        'write:w6',
        'read:r1',
        'readWrite:rw',
        'dupOrWrite:1',
        'dupOrWrite:2',
        'dupOrWrite:w7',
        'dupOrRead:0',
      ],
    ]);
  });

  it('reads heredoc bodies as data, but runs substitutions in unquoted ones', () => {
    const src = "cat <<EOF > out\nrm -rf /\n$(touch t)\nEOF\ncat <<'Q'\n$(touch u)\nQ\nls";
    expect(argvs(src)).toEqual([['cat'], ['touch', 't'], ['cat'], ['ls']]);
    expect(summary(src)[0].redirects).toEqual(['heredoc', 'write:out']);
  });

  it('parses a heredoc inside $( ) inside double quotes (git commit style)', () => {
    const src = 'git commit -m "$(cat <<\'EOF\'\nfix (a) ) b\nEOF\n)" && rm x';
    expect(argvs(src).map((a) => a[0])).toEqual(['git', 'cat', 'rm']);
  });
});

describe('working directory (cd)', () => {
  it('cd X && cmd runs only in X; after ; or || both directories are possible', () => {
    const dirs = (src: string) => summary(src).map((c) => [c.argv[0], c.dirs]);
    expect(dirs('cd /x && a; b')).toEqual([
      ['cd', ['']],
      ['a', ['/x']],
      ['b', ['', '/x']],
    ]);
    expect(dirs('cd /x; a')).toEqual([
      ['cd', ['']],
      ['a', ['', '/x']],
    ]);
    // `||` 之後保守地兩者都算（cd 失敗時在原目錄；其前若有 && 也可能在 X）。
    expect(dirs('cd /x || a')).toEqual([
      ['cd', ['']],
      ['a', ['', '/x']],
    ]);
  });

  it('cd in a subshell, a pipeline or a substitution does not leak', () => {
    const last = (src: string) => summary(src).at(-1)?.dirs;
    expect(last('(cd /x && a); b')).toEqual(['']);
    // 第二次驗證後修改：管線中的 cd 在 bash 的 lastpipe 與 zsh 下可能影響目前殼層，保守地
    // 兩個目錄都算（子殼層與命令替換仍不外洩）。
    expect(last('cd /x | a; b')).toEqual(['', '/x']);
    expect(last('true | cd /x; b')).toEqual(['', '/x']);
    expect(last('echo $(cd /x); b')).toEqual(['']);
  });

  it('chains successive cds and treats a bare cd as HOME', () => {
    expect(summary('cd a && cd ../b && w').at(-1)?.dirs).toEqual(['a/../b']);
    expect(summary('cd && w').at(-1)?.dirs).toEqual(['~']);
  });
});

describe('verifier round 1 (F-1, F-3, F-6, F-7)', () => {
  it('F-1: subshells and braces count toward the nesting limit (no stack overflow)', () => {
    const deep = (n: number) => `${'('.repeat(n)}rm x${')'.repeat(n)}`;
    expect(parseBash(deep(3000)).nestingExceeded).toBe(true);
    // 第二次驗證後修改：`((` 開頭現在先當算術（內容另以子殼層解讀再分析一次），所以上限的
    // 邊界改用不會被當成算術的 `( (` 驗證；深度上限本身不變。
    const spaced = (n: number) => `${'( '.repeat(n)}rm x${' )'.repeat(n)}`;
    expect(parseBash(spaced(WRITE_GUARD_BASH_MAX_NESTING + 1)).nestingExceeded).toBe(true);
    expect(parseBash(spaced(WRITE_GUARD_BASH_MAX_NESTING - 1)).nestingExceeded).toBe(false);
    expect(parseBash(deep(3)).nestingExceeded).toBe(false);
    expect(argvs(deep(3)).filter((a) => a[0] !== ':')).toEqual([['rm', 'x']]);
  });

  it('F-3: a quoted, escaped, builtin or command cd is still a cd', () => {
    for (const cd of ['\\cd', "'cd'", '"cd"', 'builtin cd', 'command cd', 'command -p cd']) {
      expect(summary(`${cd} /x && w`).at(-1)?.dirs, cd).toEqual(['/x']);
    }
  });

  it('F-3: cd -, popd and cd $X widen to every directory seen so far', () => {
    expect(summary('cd /tmp && cd - && w').at(-1)?.dirs).toEqual(['', '/tmp']);
    expect(summary('pushd /a && popd && w').at(-1)?.dirs).toEqual(['', '/a']);
    expect(summary('cd /a && cd "$X" && w').at(-1)?.dirs).toEqual(['', '/a']);
  });

  it('F-6: case patterns do not close a command substitution', () => {
    expect(argvs('echo $(case a in a) touch x;; esac) y').map((a) => a[0])).toEqual([
      'echo',
      ':',
      ':',
      'touch',
      ':',
    ]);
    expect(argvs('case a in (a|b) rm x;; *) true;; esac').filter((a) => a[0] !== ':')).toEqual([
      ['rm', 'x'],
      ['true'],
    ]);
    expect(parseBash('echo $(case a in a) touch x )').nestingExceeded).toBe(true);
  });

  it('F-7: time options and the function keyword are skipped, the body is parsed', () => {
    expect(argvs('time -p rm -rf src')).toEqual([['rm', '-rf', 'src']]);
    expect(argvs('function f { rm -rf src; }; f')).toEqual([['rm', '-rf', 'src'], ['f']]);
    expect(argvs('function f() ( rm x )')).toEqual([['rm', 'x']]);
    expect(argvs('coproc w { rm x; }')).toEqual([['rm', 'x']]);
  });
});

describe('limits', () => {
  it('flags nesting beyond the limit instead of recursing forever', () => {
    const deep = '$('.repeat(WRITE_GUARD_BASH_MAX_NESTING + 2) + ')'.repeat(30);
    expect(parseBash(`echo ${deep}`).nestingExceeded).toBe(true);
    expect(parseBash('echo $(echo $(echo))').nestingExceeded).toBe(false);
  });

  it('survives unterminated quotes and stray parentheses', () => {
    expect(() => parseBash(`echo "abc; rm x`)).not.toThrow();
    expect(() => parseBash(`echo 'abc`)).not.toThrow();
    expect(argvs(') a ( b')).toEqual([['a'], ['b']]);
  });
});
