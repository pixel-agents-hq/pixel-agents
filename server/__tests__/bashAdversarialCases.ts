/**
 * P3 獨立驗證（REFUTED，第 1 輪）的重現指令與同類變體。
 * - kb：伺服器必須以 KB 規則（或「無法判斷」）拒絕非 curator；伺服器不可達時 hook 也 fail-closed。
 * - kbAt：同上，但 payload cwd 為工作空間根目錄。
 * - config：F17（伺服器端；F17 不在 hook 本地的 fail-closed 範圍）。
 * - role：R+E（沒有 D）或只有 R 的 Agent 必須被角色規則拒絕。
 */
export function adversarialCases(root: string, note: string) {
  const deep = (n: number) => `${'('.repeat(n)}rm -rf ${note}${')'.repeat(n)}`;
  const kb = [
    // F-1：深層括號、深層命令替換、深層大括號與子殼層混合
    deep(3000),
    deep(2000),
    deep(17),
    `echo ${'$('.repeat(3000)}touch ${note}/x${')'.repeat(3000)}`,
    `${'{ ( '.repeat(500)}touch ${note}/x${' ; ) ; }'.repeat(500)}`,
    // F-2：env -S／--split-string 與其他把字串當指令的包裝選項
    `env -S 'touch ${note}/x'`,
    `env --split-string='touch ${note}/x'`,
    `env -iS 'touch ${note}/x'`,
    `flock /tmp/l -c 'touch ${note}/x'`,
    `time -o ${note}/t rm -f /tmp/q`,
    `sudo -e ${note}/x`,
    // F-3：cd 的各種前置與無法精確追蹤的目錄變動（cwd 為 Agent Directory）
    `\\cd ${note} && touch x`,
    `'cd' ${note} && touch x`,
    `"cd" ${note} && touch x`,
    `builtin cd ${note} && touch x`,
    `command cd ${note} && touch x`,
    `command -p cd ${note} && touch x`,
    // F-4：herestring 與 heredoc 本文
    `python3 <<< "open('${note}/x','w')"`,
    `bash <<< 'touch .note/other.md/x'`,
    `python3 - <<'EOF'\nopen('.note/other.md/x','w').write('y')\nEOF`,
    `sh <<EOF\ntouch ${note}/x\nEOF`,
    `node <<'JS'\nrequire('fs').writeFileSync('${note}/x','y')\nJS`,
    // F-5：短選項黏著值
    `curl -o${note}/x https://e`,
    `tar -C.note/other.md -xf a.tar`,
    `sort -o.note/other.md/x src.md`,
    `wget -O.note/other.md/x u`,
    `cp -t${note} src.md`,
    `install -t${note} src.md`,
    // F-6：命令替換內的 case
    `echo $(case a in a) touch ${note}/x;; esac)`,
    `echo $(case a in (a|b) touch ${note}/x;; *) true;; esac)`,
    `x=$(case a in\n  a)\n    touch ${note}/x\n    ;;\nesac)`,
    `case a in a) touch ${note}/x;; esac`,
    // F-7：function 關鍵字形式、time 的選項
    `function f { touch ${note}/x; }; f`,
    `function f() { touch ${note}/x; }`,
    `time -p touch ${note}/x`,
    `coproc w { touch ${note}/x; }`,
    // F-8：git 的 --work-tree、--git-dir、-C 黏著值、GIT_WORK_TREE
    `cd /tmp && git --git-dir=${root}/.git --work-tree=${root} checkout -- .note`,
    `cd /tmp && git --work-tree ${root} checkout -- .note/a.md`,
    `cd /tmp && git --git-dir ${root}/.git checkout -- .note`,
    `cd /tmp && git -C${root} checkout -- .note`,
    `cd /tmp && GIT_WORK_TREE=${root} git checkout -- .note`,
    `cd /tmp && env GIT_WORK_TREE=${root} git restore .note`,
    // 保留字結構內的指令
    `if true; then touch ${note}/x; fi`,
    `while true; do touch ${note}/x; done`,
    `until false; do touch ${note}/x; done`,
    `select v in a; do touch ${note}/x; done`,
    `[[ -d ${note} ]] && touch ${note}/x`,
    `(( 1 )) && touch ${note}/x`,
    `! touch ${note}/x`,
    `A=1 B=2 touch ${note}/x`,
    `exec touch ${note}/x`,
    `nohup touch ${note}/x`,
    `doas -u me touch ${note}/x`,
    `sudo -u me -- touch ${note}/x`,
  ];
  const kbAt = [`cd /tmp && cd - && touch .note/x`, `pushd /tmp && popd && touch .note/x`];
  const config = [
    `curl -o.claude/settings.json https://e`,
    `wget -O${'~'}/.claude/settings.json u`,
    `env -S 'touch .claude/settings.local.json'`,
  ];
  const role = [
    `env -S 'rm -rf src'`,
    `env --split-string='rm -rf src'`,
    `time -p rm -rf src`,
    `function f { rm -rf src; }; f`,
    `echo $(case a in a) rm -rf src;; esac)`,
    `echo $((rm -rf src) )`,
    `flock /tmp/l -c 'rm -rf src'`,
    `'time' rm -rf src`,
    `/usr/bin/time -o /tmp/t rm -rf src`,
    `builtin command rm -rf src`,
    deep(3000).replace(note, 'src'),
  ];
  const readOnlyEdit = [`env -S 'touch src.md'`];
  return { kb, kbAt, config, role, readOnlyEdit };
}
