/**
 * P3 第二次獨立驗證（REFUTED）的重現指令與同類變體。
 * - kb（cwd 為 Agent Directory）、kbAtRoot（cwd 為工作空間根目錄）、kbAtTmp（cwd 為 /tmp）：
 *   伺服器以 KB 規則（或無法判斷）拒絕非 curator，且伺服器不可達時 hook 也 fail-closed。
 * - config（伺服器端 F17）、role（沒有 D 的 R+E：role-delete）、readOnly（只有 R：role-edit）。
 */
export function adversarialCases2(root: string, note: string, home: string) {
  const kb = [
    // P2-1：改變起點目錄的包裝選項，四種寫法
    `env -C${note} touch x`,
    `env --chdir=${note} touch x`,
    `env --chdir ${note} touch x`,
    `env -iC${note} touch x`,
    `env -C ${note} touch x`,
    `sudo -D${note} touch x`,
    `sudo --chdir=${note} touch x`,
    `sudo --chdir ${note} touch x`,
    // P2-3：~N（目錄堆疊）
    `pushd ${root} && pushd /tmp && touch ~1/.note/x`,
    // P2-5：(( )) 與 [[ ]]、let 內的 << 不是 heredoc，後續行照常分析
    `(( x = 1 << 2 ))\ntouch ${note}/x`,
    `echo $(( 1 << 2 ))\ntouch ${note}/x`,
    `let "x=1<<2"\ntouch ${note}/x`,
    `let x=1<<2\ntouch ${note}/x`,
    `[[ a << b ]]\ntouch ${note}/x`,
    `for ((i = 0; i << 1; i++)); do touch ${note}/x; done`,
    // P3：cd 進 KB 後，無法分類的指令以相對檔名寫入
    `cd ${note} && python3 -c "open('x.md','w')"`,
    `cd ${note} && sh -c 'echo x > y.md'`,
    // zsh 保守處理
    `=touch ${note}/x`,
    `repeat 2 touch ${note}/x`,
    `{ true } always { touch ${note}/x }`,
    `if (true) touch ${note}/x`,
    `while (false) touch ${note}/x`,
    `if [[ -d /tmp ]] { touch ${note}/x }`,
    `echo x >! ${note}/x`,
    `echo x >>! ${note}/x`,
    `noglob touch ${note}/x`,
    `ls *(e:'touch ${note}/x':)`,
    `echo \${(e)x} > /tmp/q`,
  ];
  const kbAtRoot = [
    // P2-2：$'...' 的各種跳脫
    `touch $'.note/x'`,
    `touch $'\\u002enote/x'`,
    `touch $'\\U0000002enote/x'`,
    `touch $'\\x2enote/x'`,
    `touch $'\\056note/x'`,
    `touch $'\\U00110000'x`,
    `touch $'\\uD800'x`,
    // P2-3：~+
    `touch ~+/.note/x`,
    // P3：lastpipe 與 zsh 的管線末段 cd
    `shopt -s lastpipe; true | cd .note; touch x`,
    `true | cd .note && touch x`,
  ];
  const kbAtTmp = [
    `cd ${root} && cd /tmp && touch ~-/.note/x`,
    // P2-6：find 起點之前的全域選項
    `find -L ${note} -name '*.md' -delete`,
    `find -H ${note} -delete`,
    `find -D tree -O3 ${note} -delete`,
    `find -HL ${root} -delete`,
    // P2-3：~user 無法解析（寫入目標無法判斷）
    `echo x > ~nobody-${'x'}/.claude/settings.json`,
  ];
  const config = [
    `find -P ${home}/.claude -name settings.json -delete`,
    `env -C${home}/.claude touch settings.json`,
  ];
  const role = [
    `(( x = 1 << 2 ))\nrm -rf src`,
    `let "x=1<<2"\nrm -rf src`,
    `[[ a << b ]]\nrm -rf src`,
    `sudo --chdir /tmp rm -rf src`,
    `sudo -D/tmp rm -rf src`,
    `xargs --arg-file f rm -rf`,
    `ls | xargs --max-lines 1 rm -rf`,
    `=rm -rf src`,
    `repeat 1 rm -rf src`,
    `{ true } always { rm -rf src }`,
    `ls *(e:'rm -rf src':)`,
    `if (true) rm -rf src`,
    `while (false) rm -rf src`,
    `echo \${(e)x}`,
    `echo \${(P)x}`,
    `ls *(+f)`,
    // zsh：引號內出現同樣文字也保守處理（區分 zsh 的引號規則與程式碼字串並不可靠）。
    `echo '*(e:true:)'`,
    `echo '\${(P)x}'`,
  ];
  const readOnly = [`(( 1 << 2 ))\ntouch out`];
  return { kb, kbAtRoot, kbAtTmp, config, role, readOnly };
}
