/**
 * P3 Bash 分類（純函式）：操作類別（read／edit／delete）、寫入目標、字面路徑片段。
 * 驗收 2：重導向、tee、sed -i、cp、mv、rm、touch、mkdir、git、複合指令、引號、相對路徑。
 */

import { describe, expect, it } from 'vitest';

import { analyzeBash } from '../src/writeGuard/bashAnalysis.js';

const ops = (src: string) => analyzeBash(src).ops;
/** 目標字串：路徑段以 | 串接（cd 參數在前），遞迴目標加 R: 前綴。 */
const targets = (src: string) =>
  analyzeBash(src).targets.map(
    (t) => `${t.mode === 'recursive' ? 'R:' : ''}${t.segments.map((s) => s.text).join('|')}`,
  );
const mentions = (src: string) =>
  analyzeBash(src).mentions.map((t) => t.segments.map((s) => s.text).join('|'));

describe('redirects (acceptance 2)', () => {
  it.each([
    ['echo x > a', ['a']],
    ['echo x >> a', ['a']],
    ['echo x >| a', ['a']],
    ['npm test &> a', ['a']],
    ['npm test 2> a', ['a']],
    ['cat <<EOF > a\nbody\nEOF', ['a']],
    ['echo x >& a', ['a']],
  ])('%j writes its target', (src, expected) => {
    expect(targets(src)).toEqual(expected);
    expect(ops(src)).toContain('edit');
  });

  it('> /dev/null, 2>&1 and >&2 are not writes', () => {
    expect(ops('echo x > /dev/null 2>&1')).toEqual(['read']);
    expect(ops('echo x >&2')).toEqual(['read']);
    expect(targets('ls 2>/dev/null')).toEqual([]);
  });

  it('an input redirect is a read; <> is read and write', () => {
    expect(ops('npm test < in')).toEqual(['read', 'edit']);
    expect(ops('cat <> f')).toEqual(['read', 'edit']);
    expect(targets('cat <> f')).toEqual(['f']);
  });
});

describe('command classes (acceptance 2)', () => {
  it.each([
    ['ls -la', ['read']],
    ['cat .note/a.md', ['read']],
    ['grep -r foo .note', ['read']],
    ['find . -name "*.md"', ['read']],
    ['git status', ['read']],
    ['git log --oneline', ['read']],
    ['git branch', ['read']],
    ['git branch -a', ['read']],
    ['git remote -v', ['read']],
    ['git -C sub diff', ['read']],
    ['tee a', ['edit']],
    ['sed -i s/a/b/ f', ['edit']],
    ['cp a b', ['edit']],
    ['mv a b', ['edit']],
    ['touch a', ['edit']],
    ['mkdir -p a/b', ['edit']],
    ['git add .', ['edit']],
    ['git commit -m "msg"', ['edit']],
    ['git checkout main', ['edit']],
    ['git branch -D old', ['edit']],
    ['git remote add o url', ['edit']],
    ['rm -rf a', ['delete']],
    ['rmdir a', ['delete']],
    ['unlink a', ['delete']],
    ['git rm a', ['delete']],
    ['git clean -fd', ['delete']],
    ['find . -name x -delete', ['delete']],
    ['npm test', ['edit']],
    ['npx vitest', ['edit']],
    ['python -c "print(1)"', ['edit']],
    ['bash -c "rm x"', ['edit']],
    ['make', ['edit']],
    ['sed -n 1p f', ['edit']],
    ['$CMD x', ['edit']],
  ])('%j needs %j', (src, expected) => {
    expect(ops(src)).toEqual(expected);
  });

  it('unions the classes of every command in a compound command', () => {
    expect(ops('ls; rm a')).toEqual(['read', 'delete']);
    expect(ops('cat a | tee b && echo ok')).toEqual(['read', 'edit']);
    expect(ops('echo $(rm a)')).toEqual(['read', 'delete']);
    expect(ops('(cd x && touch y) & wait')).toEqual(['read', 'edit']);
    expect(ops('echo `rm a`')).toEqual(['read', 'delete']);
  });

  it('classifies wrapped commands by the inner command', () => {
    expect(ops('sudo rm a')).toEqual(['delete']);
    expect(ops('env FOO=1 rm a')).toEqual(['delete']);
    expect(ops('timeout 5 rm a')).toEqual(['delete']);
    expect(ops('find . | xargs rm')).toEqual(['read', 'delete']);
    expect(ops('nice -n 5 ls')).toEqual(['read']);
    expect(ops('env')).toEqual(['read']);
    expect(ops('command -v rm')).toEqual(['read']);
    expect(targets('env -C /x rm a')).toEqual(['R:/x|a']);
  });

  it('a quoted or escaped command name is still recognized', () => {
    expect(ops('"rm" a')).toEqual(['delete']);
    expect(ops('\\rm a')).toEqual(['delete']);
    expect(ops('/bin/rm a')).toEqual(['delete']);
  });
});

describe('write targets (acceptance 2)', () => {
  it('tee, sed -i, touch, mkdir take every operand', () => {
    expect(targets('tee -a a b')).toEqual(['a', 'b']);
    expect(targets('sed -i.bak -e s/a/b/ f g')).toEqual(['f', 'g']);
    expect(targets("sed -i '' s/a/b/ f")).toEqual(['s/a/b/', 'f']);
    expect(targets('touch -d now a')).toEqual(['a']);
    expect(targets('mkdir -m 700 d')).toEqual(['d']);
  });

  it('cp and mv write dest and dest/basename(src); mv also removes its sources', () => {
    expect(targets('cp a/x.md b')).toEqual(['b', 'b|x.md']);
    expect(targets('cp -t d a b')).toEqual(['d', 'd|a', 'd|b']);
    expect(targets('cp -r src/ dest')).toEqual(['dest', 'dest|src', 'R:dest']);
    expect(targets('mv a b')).toEqual(['b', 'b|a', 'R:a']);
  });

  it('rm targets are recursive (deleting an ancestor deletes what is inside)', () => {
    expect(targets('rm -rf -- a "b c"')).toEqual(['R:a', 'R:b c']);
    expect(targets('find x y -delete')).toEqual(['R:x', 'R:y']);
    expect(targets('git clean -fdx')).toEqual(['R:.']);
  });

  it('chmod skips the mode, chown the owner; -R is recursive', () => {
    expect(targets('chmod 644 a')).toEqual(['a']);
    expect(targets('chmod -w a')).toEqual(['a']);
    expect(targets('chmod -R u+w d')).toEqual(['R:d']);
    expect(targets('chown me:staff a')).toEqual(['a']);
  });

  it('dd writes of=, git -C prefixes path operands, git checkout pathspecs are recursive', () => {
    expect(targets('dd if=a of=b')).toEqual(['b']);
    expect(targets('git -C sub checkout -- .note/a')).toEqual(['R:sub|.note/a']);
    expect(targets('git restore .')).toEqual(['R:.']);
    expect(targets('git commit -m .note/x')).toEqual([]);
  });

  it('relative targets carry the cd chain; `cd X; cmd` keeps both directories', () => {
    expect(targets('cd /tmp && echo x > a')).toEqual(['/tmp|a']);
    expect(targets('cd /tmp; echo x > a')).toEqual(['a', '/tmp|a']);
    expect(targets('cd \'my dir\' && touch "b c"')).toEqual(['my dir|b c']);
  });

  it('tilde targets are marked for HOME expansion', () => {
    const [t] = analyzeBash('echo x > ~/.claude/settings.json').targets;
    expect(t.segments).toEqual([{ text: '~/.claude/settings.json', tilde: true }]);
  });
});

describe('literal path fragments in interpreters and unclassified commands', () => {
  // 第二次驗證後修改：無法分類的指令另外把工作目錄本身（'.'）列為潛在寫入
  // （`cd .note && python3 -c "open('x','w')"`），原有的片段斷言不變。
  it('collects path-like fragments, also inside quoted code', () => {
    expect(mentions(`python -c "open('/w/.note/x','w')"`)).toEqual(['/w/.note/x', '.']);
    expect(mentions(`bash -c 'echo > .note/x'`)).toEqual(['.note/x', '.']);
    expect(mentions('node build.js --out=dist/a')).toEqual(['dist/a', '.']);
  });

  it('read-class commands are never scanned (cat or grep reading .note is fine)', () => {
    expect(mentions('cat .note/a.md')).toEqual([]);
    expect(mentions('grep -r x /w/.note')).toEqual([]);
  });
});
